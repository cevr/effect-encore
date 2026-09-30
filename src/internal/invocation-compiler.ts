import type { DateTime, Schema as SchemaType } from "effect";
import { Context, Effect, Option, Predicate, PrimaryKey, Schema, SchemaGetter } from "effect";
import {
  ClusterSchema,
  type Entity as ClusterEntity,
  type EntityAddress,
  Envelope,
  Message,
  type Snowflake,
} from "effect/cluster";
import * as DeliverAt from "effect/cluster/DeliverAt";
import * as Headers from "effect/http/Headers";
import type { Rpc } from "effect/rpc";
import { Rpc as RpcMod } from "effect/rpc";
import { ActorDefect } from "../actor-defect.js";
import type { ExecId } from "../receipt.js";
import { ExecIdCodec } from "../receipt.js";

export type EntityIdReturn = string | { readonly entityId: string; readonly primaryKey?: string };

export interface OperationDef {
  readonly payload?: Schema.Top | Schema.Struct.Fields;
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
  readonly persisted?: boolean;
  readonly id: (payload: never) => EntityIdReturn;
  readonly deliverAt?: (payload: never) => DateTime.DateTime;
}

export type OperationDefs = Record<string, OperationDef>;

const EntityIdReturnSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    entityId: Schema.String,
    primaryKey: Schema.optionalKey(Schema.String),
  }),
]);

const isString = Schema.is(Schema.String);

export interface OperationIdentity {
  readonly entityId: string;
  readonly primaryKey: string;
  readonly execId: ExecId;
}

export interface Invocation {
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity protocols are type-erased inside transport.
  readonly entity: ClusterEntity.Entity<string, any>;
  readonly tag: string;
  readonly definition: OperationDef;
  readonly payload: unknown;
  readonly operation: OperationValue;
  readonly identity: OperationIdentity;
}

export interface OperationValue {
  readonly _tag: string;
  readonly _payload?: unknown;
}

interface OperationIdentityBase {
  readonly entityId: string;
  readonly primaryKey: string;
}

export const isOpaquePayload = <Payload>(payload: Payload): boolean =>
  Schema.isSchema(payload) && !Predicate.hasProperty(payload, "fields");

/* oxlint-disable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary, effect/noUnknownParameters, effect/noUnsafeDictionaryType -- Effect Cluster erases schema-specific RPC types at this compiler seam. */

const OpaquePayloadValue = Symbol("effect-encore/OpaquePayloadValue");

export const unwrapOpaquePayload = (input: unknown): unknown => {
  if (Predicate.hasProperty(input, OpaquePayloadValue)) {
    const getter = input[OpaquePayloadValue];
    if (typeof getter === "function") return Reflect.apply(getter, input, []);
  }
  return input;
};

const unwrapOpaquePayloadForEncoding = (input: unknown): unknown => {
  const unwrapped = unwrapOpaquePayload(input);
  if (unwrapped !== input) return unwrapped;
  // Schema encoding validates the target class before it invokes the
  // transformation. That validation can produce a plain object, so retain a
  // structural fallback for the encode-side value.
  return Predicate.isObject(input) && Predicate.hasProperty(input, "value")
    ? input["value"]
    : input;
};

export const resolveId = <Payload>(
  definition: OperationDef | void,
  payload: Payload,
  fallbackTag: string,
): OperationIdentityBase => {
  const id = definition?.id;
  if (!id) return { entityId: fallbackTag, primaryKey: fallbackTag };
  const result = Schema.decodeUnknownSync(EntityIdReturnSchema)(Reflect.apply(id, id, [payload]));
  if (isString(result)) return { entityId: result, primaryKey: result };
  return { entityId: result.entityId, primaryKey: result.primaryKey ?? result.entityId };
};

export const makeOperationValue = <Payload>(
  definition: OperationDef | void,
  tag: string,
  payload: Payload,
): OperationValue => {
  const payloadSchema = Option.fromNullishOr(definition?.payload);
  if (Option.isSome(payloadSchema) && isOpaquePayload(payloadSchema.value)) {
    return { _tag: tag, _payload: payload };
  }
  if (Predicate.isObjectOrArray(payload)) {
    return Object.assign(Object.create(Object.getPrototypeOf(payload)), payload, { _tag: tag });
  }
  return { _tag: tag };
};

export const payloadFromOperation = (
  definition: OperationDef | void,
  operation: OperationValue,
): unknown => {
  const payloadSchema = Option.fromNullishOr(definition?.payload);
  if (
    Option.isSome(payloadSchema) &&
    isOpaquePayload(payloadSchema.value) &&
    Predicate.hasProperty(operation, "_payload")
  ) {
    return unwrapOpaquePayload(operation["_payload"]);
  }
  return operation;
};

export const compileInvocation = <Payload>(
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity protocols are type-erased inside transport.
  entity: ClusterEntity.Entity<string, any>,
  tag: string,
  definition: OperationDef,
  payload: Payload,
): Invocation => {
  const operation = makeOperationValue(definition, tag, payload);
  const { entityId, primaryKey } = resolveId(definition, payload, tag);
  return {
    entity,
    tag,
    definition,
    payload,
    operation,
    identity: {
      entityId,
      primaryKey,
      execId: ExecIdCodec.encode({ entityId, tag, primaryKey }),
    },
  };
};

type PayloadClassBase = new (...args: ReadonlyArray<unknown>) => object;

const makePayloadClass = (
  base: Schema.Top,
  primaryKeyOf: (input: unknown) => string,
  deliverAt: ((input: unknown) => DateTime.DateTime) | undefined,
  attachPrimaryKey: boolean,
  opaque: boolean = false,
): Schema.Top => {
  class PayloadClass extends (base as unknown as PayloadClassBase) {}
  const proto = PayloadClass.prototype as Record<string | symbol, unknown>;
  if (opaque) {
    proto[OpaquePayloadValue] = function (this: Record<string, unknown>) {
      return this["value"];
    };
  }
  if (attachPrimaryKey) {
    proto[PrimaryKey.symbol] = function (this: unknown) {
      return primaryKeyOf(unwrapOpaquePayload(this));
    };
  }
  if (deliverAt) {
    proto[DeliverAt.symbol] = function (this: unknown) {
      return deliverAt(unwrapOpaquePayload(this));
    };
  }
  return PayloadClass as unknown as Schema.Top;
};

const makeOpaquePayloadSchema = (
  actorName: string,
  tag: string,
  payload: Schema.Top,
  primaryKeyOf: (input: unknown) => string,
  deliverAt: ((input: unknown) => DateTime.DateTime) | undefined,
): Schema.Top => {
  const Base = Schema.Class<Record<string, unknown>>(`effect-encore/${actorName}/${tag}/Payload`)({
    value: Schema.Unknown,
  });
  const payloadClass = makePayloadClass(Base, primaryKeyOf, deliverAt, true, true);
  const wrapped = Schema.decodeTo(payloadClass, {
    decode: SchemaGetter.transform((input) => payloadClass.make({ value: input })),
    encode: SchemaGetter.transform((input) => unwrapOpaquePayloadForEncoding(input)),
  })(payload);

  // The public constructor accepts the decoded user payload. The transformed
  // schema itself stores the internal carrier so Envelope.primaryKey can read
  // the cluster protocol before the original codec encodes the wire value.
  // Schemas inherit `make` as a lazy getter, so the override is an own property.
  const make: Schema.Top["make"] = (input, options) => payloadClass.make({ value: input }, options);
  Object.defineProperty(wrapped, "make", { value: make, enumerable: true });
  return wrapped;
};

const compileSchemaPayload = (
  actorName: string,
  tag: string,
  payload: Schema.Top,
  primaryKeyOf: (input: unknown) => string,
  deliverAt: ((input: unknown) => DateTime.DateTime) | undefined,
): Schema.Top => {
  if (Predicate.hasProperty(payload, "fields")) {
    const hasPrimaryKey =
      Predicate.hasProperty(payload, "prototype") &&
      Predicate.hasProperty(payload["prototype"], PrimaryKey.symbol);
    const hasDeliverAt =
      Predicate.hasProperty(payload, "prototype") &&
      Predicate.hasProperty(payload["prototype"], DeliverAt.symbol);

    if (hasPrimaryKey && (!deliverAt || hasDeliverAt)) return payload;

    let base: Schema.Top;
    let preserveSchema = false;
    let payloadDeliverAt = deliverAt;
    if (Predicate.hasProperty(payload, "identifier")) {
      base = payload;
    } else {
      base = Schema.Class<Record<string, unknown>>(`effect-encore/${actorName}/${tag}/Payload`)(
        payload["fields"] as Schema.Struct.Fields,
      );
      preserveSchema = true;
    }
    if (hasDeliverAt) payloadDeliverAt = undefined;
    const payloadClass = makePayloadClass(base, primaryKeyOf, payloadDeliverAt, !hasPrimaryKey);
    if (preserveSchema) return Schema.decodeTo(payloadClass)(payload);
    return payloadClass;
  }

  // Opaque payloads (for example Schema.String) have no object prototype on
  // on which the cluster protocol can be attached. This also covers
  // transformed schemas whose decoded value is an object or class: the
  // original decoded value stays inside the carrier and reaches user code
  // unchanged after the transport unwraps it.
  return makeOpaquePayloadSchema(actorName, tag, payload, primaryKeyOf, deliverAt);
};

export const compileRpc = (actorName: string, tag: string, def: OperationDef): Rpc.Any => {
  const options: Record<string, unknown> = {};
  const payload = def["payload"];
  const deliverAt = def["deliverAt"] as ((input: unknown) => DateTime.DateTime) | undefined;
  const primaryKeyOf = (input: unknown) => resolveId(def, input, tag).primaryKey;

  if (payload) {
    if (Schema.isSchema(payload)) {
      options["payload"] = compileSchemaPayload(actorName, tag, payload, primaryKeyOf, deliverAt);
    } else {
      const Base = Schema.Class<Record<string, unknown>>(
        `effect-encore/${actorName}/${tag}/Payload`,
      )(payload);
      const payloadClass = makePayloadClass(Base, primaryKeyOf, deliverAt, true);
      options["payload"] = payloadClass;
    }
  } else {
    const Base = Schema.Class<Record<string, unknown>>(`effect-encore/${actorName}/${tag}/Payload`)(
      {},
    );
    const emptyPrimaryKeyOf = (_input: unknown) => primaryKeyOf(Schema.Void.make());
    const payloadClass = makePayloadClass(Base, emptyPrimaryKeyOf, undefined, true);
    options["payload"] = payloadClass;
  }

  if (def["success"]) options["success"] = def["success"];
  if (def["error"]) options["error"] = def["error"];

  let rpc: Rpc.Any = (RpcMod.make as Function)(tag, options) as Rpc.Any;
  if (def["persisted"]) {
    rpc = (rpc as unknown as { annotate: Function }).annotate(
      ClusterSchema.Persisted,
      true,
    ) as Rpc.Any;
  }
  return rpc;
};

interface ErasedRequestOptions {
  readonly requestId: Snowflake.Snowflake;
  readonly address: EntityAddress.EntityAddress;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: Headers.Headers;
}

function makeErasedRequest(options: ErasedRequestOptions): Envelope.Request<Rpc.AnyWithProps>;
function makeErasedRequest(options: ErasedRequestOptions): unknown {
  return Reflect.apply(Envelope.makeRequest, Envelope, [options]);
}

interface ErasedOutgoingRequestOptions {
  readonly rpc: Rpc.AnyWithProps;
  readonly context: Context.Context<never>;
  readonly envelope: Envelope.Request<Rpc.AnyWithProps>;
  readonly lastReceivedReply: Option.Option<never>;
  readonly respond: () => Effect.Effect<void>;
  readonly annotations: Context.Context<never>;
}

function makeErasedOutgoingRequest(
  options: ErasedOutgoingRequestOptions,
): Message.OutgoingRequest<Rpc.Any>;
function makeErasedOutgoingRequest(options: ErasedOutgoingRequestOptions): unknown {
  return Reflect.construct(Message.OutgoingRequest, [options]);
}

export const compileOutgoingRequest = (
  invocation: Invocation,
  address: EntityAddress.EntityAddress,
  snowflakeGenerator: Snowflake.Generator["Service"],
): Effect.Effect<Message.OutgoingRequest<Rpc.Any>> =>
  Effect.gen(function* () {
    const { entity, tag, definition, operation } = invocation;
    const rpc = entity.protocol.requests.get(tag);
    if (!rpc) {
      return yield* Effect.die(
        new ActorDefect({
          message: `effect-encore: rpc "${tag}" not found on entity "${entity.type}"`,
        }),
      );
    }

    const payloadSchema: SchemaType.Top = rpc.payloadSchema;
    let payload;
    if (!definition.payload) {
      payload = payloadSchema.make({});
    } else if (isOpaquePayload(definition.payload)) {
      payload = payloadSchema.make(operation["_payload"]);
    } else {
      const { _tag: operationTag, ...fields } = operation;
      void operationTag;
      payload = payloadSchema.make(fields);
    }

    const context = yield* Effect.context<never>();
    const envelope = makeErasedRequest({
      requestId: snowflakeGenerator.nextUnsafe(),
      address,
      tag,
      payload,
      headers: Headers.empty,
    });
    const rpcAnnotations: Context.Context<never> = rpc.annotations;
    const dynamic = Context.get(rpcAnnotations, ClusterSchema.Dynamic);
    const annotations = dynamic(rpcAnnotations, envelope);

    return makeErasedOutgoingRequest({
      rpc,
      context,
      envelope,
      lastReceivedReply: Option.none(),
      respond: () => Effect.void,
      annotations,
    });
  });

/* oxlint-enable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary, effect/noUnknownParameters, effect/noUnsafeDictionaryType */
