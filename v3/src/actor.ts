import type { Entity as ClusterEntity, EntityType } from "@effect/cluster";
import {
  ClusterSchema,
  Entity,
  EntityAddress,
  EntityId,
  MessageStorage,
  Sharding,
} from "@effect/cluster";
import * as DeliverAt from "@effect/cluster/DeliverAt";
import type { MalformedMessage, PersistenceError } from "@effect/cluster/ClusterError";
import type { Rpc, RpcClient } from "@effect/rpc";
import { Rpc as RpcMod } from "@effect/rpc";
import { Workflow as UpstreamWorkflow } from "@effect/workflow";
import type { WorkflowEngine } from "@effect/workflow/WorkflowEngine";
import { layerMemory as workflowEngineLayerMemory } from "@effect/workflow/WorkflowEngine";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PrimaryKey,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { DateTime, Scope } from "effect";
import type { ExecId, PeekResult } from "./receipt.js";
import {
  Defect,
  Failure,
  Interrupted,
  Suspended,
  isTerminal,
  makeExecId,
  Pending,
  Success,
} from "./receipt.js";

// ── Payload classification ─────────────────────────────────────────────────
// Schema.Class has `fields`; scalars like Schema.String don't.
const isOpaquePayload = (payload: unknown): boolean =>
  Schema.isSchema(payload) && !("fields" in (payload as object));

// ── Operation DSL ──────────────────────────────────────────────────────────

export interface OperationDef {
  readonly payload?: Schema.Schema.Any | Schema.Struct.Fields;
  readonly success?: Schema.Schema.Any;
  readonly error?: Schema.Schema.Any | Schema.Schema.All;
  readonly persisted?: boolean;
  readonly primaryKey: (payload: never) => string;
  readonly deliverAt?: (payload: never) => DateTime.DateTime;
}

export type OperationDefs = Record<string, OperationDef>;

// ── Reserved key guard ─────────────────────────────────────────────────────

type ReservedKeys = "_tag" | "_meta" | "$is" | "Context" | "actor" | "peek" | "watch" | "interrupt";

type AssertNoReservedKeys<Defs extends OperationDefs> =
  Extract<keyof Defs, ReservedKeys> extends never ? Defs : never;

const RESERVED_KEYS = new Set<string>([
  "_tag",
  "_meta",
  "$is",
  "Context",
  "actor",
  "peek",
  "watch",
  "interrupt",
]);

// ── Type-level Rpc mirror ──────────────────────────────────────────────────

type PayloadOf<C extends OperationDef> = C extends {
  readonly payload: infer P extends Schema.Schema.Any;
}
  ? P
  : C extends { readonly payload: infer F extends Schema.Struct.Fields }
    ? Schema.Struct<F>
    : typeof Schema.Void;

type SuccessOf<C extends OperationDef> = C extends {
  readonly success: infer S extends Schema.Schema.Any;
}
  ? S
  : typeof Schema.Void;

type ErrorOf<C extends OperationDef> = C extends {
  readonly error: infer E extends Schema.Schema.Any;
}
  ? E
  : typeof Schema.Never;

type DefRpc<Tag extends string, C extends OperationDef> = Rpc.Rpc<
  Tag,
  PayloadOf<C>,
  SuccessOf<C>,
  ErrorOf<C>
>;

type DefRpcs<Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: DefRpc<Tag, Defs[Tag]>;
}[keyof Defs & string];

// ── OperationValue brand ───────────────────────────────────────────────────

declare const OperationBrandId: unique symbol;

export interface OperationBrand<Name extends string, Tag extends string, Output, Error> {
  readonly [OperationBrandId]: {
    readonly name: Name;
    readonly tag: Tag;
    readonly output: Output;
    readonly error: Error;
  };
}

export type OperationOutput<V> = V extends {
  readonly [OperationBrandId]: { readonly output: infer A };
}
  ? A
  : never;

export type OperationError<V> = V extends {
  readonly [OperationBrandId]: { readonly error: infer E };
}
  ? E
  : never;

// ── OperationValue types ───────────────────────────────────────────────────

type OperationValue<Name extends string, Tag extends string, C extends OperationDef> = {
  readonly _tag: Tag;
} & PayloadFieldsType<C> &
  OperationBrand<Name, Tag, Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>;

// Fieldful schema (Schema.Class) has a `fields` property
type FieldfulSchema = Schema.Schema.Any & { readonly fields: Schema.Struct.Fields };

type PayloadFieldsType<C extends OperationDef> = C extends {
  readonly payload: infer F extends Schema.Struct.Fields;
}
  ? { readonly [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Schema.Any ? F[K] : never> }
  : C extends { readonly payload: infer P extends FieldfulSchema }
    ? Schema.Schema.Type<P>
    : C extends { readonly payload: infer P extends Schema.Schema.Any }
      ? { readonly _payload: Schema.Schema.Type<P> }
      : {};

type OperationConstructorPayload<C extends OperationDef> = C extends {
  readonly payload: infer F extends Schema.Struct.Fields;
}
  ? {} extends {
      [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Schema.Any ? F[K] : never>;
    }
    ? []
    : [
        payload: {
          readonly [K in keyof F]: Schema.Schema.Type<
            F[K] extends Schema.Schema.Any ? F[K] : never
          >;
        },
      ]
  : C extends { readonly payload: infer P extends FieldfulSchema }
    ? [payload: Schema.Schema.Type<P>]
    : C extends { readonly payload: infer P extends Schema.Schema.Any }
      ? [payload: Schema.Schema.Type<P>]
      : [];

type OperationConstructor<Name extends string, Tag extends string, C extends OperationDef> = (
  ...args: OperationConstructorPayload<C>
) => OperationValue<Name, Tag, C>;

// ── Union of all OperationValues for an actor ──────────────────────────────

type OperationUnion<Name extends string, Defs extends OperationDefs> = {
  [Tag in keyof Defs & string]: OperationValue<Name, Tag, Defs[Tag]>;
}[keyof Defs & string];

// ── ActorRef — value-dispatch ref ──────────────────────────────────────────

export interface ActorRef<Name extends string, Defs extends OperationDefs> {
  readonly call: <V extends OperationUnion<Name, Defs>>(
    op: V,
  ) => Effect.Effect<OperationOutput<V>, OperationError<V>>;
  readonly cast: <V extends OperationUnion<Name, Defs>>(
    op: V,
  ) => Effect.Effect<ExecId<OperationOutput<V>, OperationError<V>>>;
}

// ── Handler types ──────────────────────────────────────────────────────────

type HandlerRequest<Tag extends string, C extends OperationDef> = {
  readonly operation: { readonly _tag: Tag } & PayloadFieldsType<C>;
  readonly request: unknown;
};

type ActorHandlers<Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: (req: HandlerRequest<Tag, Defs[Tag]>) => Effect.Effect<
    Schema.Schema.Type<SuccessOf<Defs[Tag]>>,
    Schema.Schema.Type<ErrorOf<Defs[Tag]>>,
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- handler requirements must be open
    any
  >;
};

export interface HandlerOptions {
  readonly spanAttributes?: Record<string, string>;
  readonly maxIdleTime?: number;
  readonly concurrency?: number | "unbounded";
  readonly mailboxCapacity?: number | "unbounded";
}

// ── ActorMeta — internal metadata ──────────────────────────────────────────

export interface ActorMeta<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> {
  readonly name: Name;
  readonly definitions: Defs;
  readonly entity: ClusterEntity.Entity<Name, Rpcs>;
}

// ── ActorClientService — phantom type for Context tag ──────────────────────

declare const ActorClientServiceId: unique symbol;

interface ActorClientService<Name extends string, Defs extends OperationDefs> {
  readonly [ActorClientServiceId]: {
    readonly name: Name;
    readonly defs: Defs;
  };
}

type ActorClientFactory<Name extends string, Defs extends OperationDefs> = (
  entityId: string,
) => Effect.Effect<ActorRef<Name, Defs>>;

// ── ActorObject — the unified return type ──────────────────────────────────

type ActorConstructors<Name extends string, Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: OperationConstructor<Name, Tag, Defs[Tag]>;
};

export type ActorObject<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> = ActorConstructors<Name, Defs> & {
  readonly _tag: "ActorObject";
  readonly _meta: ActorMeta<Name, Defs, Rpcs>;
  readonly Context: Context.Tag<ActorClientService<Name, Defs>, ActorClientFactory<Name, Defs>>;
  readonly actor: (
    entityId: string,
  ) => Effect.Effect<ActorRef<Name, Defs>, never, ActorClientService<Name, Defs>>;
  readonly peek: <S, E>(
    execId: ExecId<S, E>,
  ) => Effect.Effect<
    PeekResult<S, E>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | Sharding.Sharding
  >;
  readonly watch: <S, E>(
    execId: ExecId<S, E>,
    options?: { readonly interval?: Duration.DurationInput },
  ) => Stream.Stream<
    PeekResult<S, E>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | Sharding.Sharding
  >;
  readonly interrupt: (entityId: string) => Effect.Effect<void, never, Sharding.Sharding>;
  readonly $is: <Tag extends keyof Defs & string>(
    tag: Tag,
  ) => (value: unknown) => value is OperationValue<Name, Tag, Defs[Tag]>;
};

// ── Compile runtime ────────────────────────────────────────────────────────

const compileRpc = (actorName: string, tag: string, def: OperationDef): Rpc.Any => {
  const options: Record<string, unknown> = {};
  const payload = def["payload"];
  const pkFn = def["primaryKey"];
  const daFn = def["deliverAt"];

  if (payload) {
    if (Schema.isSchema(payload)) {
      options["payload"] = payload;
    } else {
      const fields = payload as Schema.Struct.Fields;

      const Base = Schema.Class<Record<string, unknown>>(
        `effect-encore/${actorName}/${tag}/Payload`,
      )(fields);

      class PayloadClass extends Base {}

      const proto = PayloadClass.prototype as Record<string | symbol, unknown>;

      if (pkFn) {
        proto[PrimaryKey.symbol] = function (this: unknown) {
          return (pkFn as Function)(this) as string;
        };
      }

      if (daFn) {
        proto[DeliverAt.symbol] = function (this: unknown) {
          return (daFn as Function)(this) as DateTime.DateTime;
        };
      }

      options["payload"] = PayloadClass;
    }
  } else if (pkFn) {
    // Zero-payload operations still need PrimaryKey.symbol for storage indexing
    const Base = Schema.Class<Record<string, unknown>>(`effect-encore/${actorName}/${tag}/Payload`)(
      {},
    );

    class EmptyPayloadClass extends Base {}

    (EmptyPayloadClass.prototype as Record<string | symbol, unknown>)[PrimaryKey.symbol] =
      function () {
        return (pkFn as Function)(undefined) as string;
      };

    options["payload"] = EmptyPayloadClass;
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

// ── peek — internal implementation ───────────────────────────────────────

const parseExecId = (execId: string) => {
  const firstSep = execId.indexOf("\x00");
  const secondSep = firstSep >= 0 ? execId.indexOf("\x00", firstSep + 1) : -1;
  return {
    entityId: firstSep >= 0 ? execId.slice(0, firstSep) : execId,
    tag:
      secondSep >= 0
        ? execId.slice(firstSep + 1, secondSep)
        : firstSep >= 0
          ? execId.slice(firstSep + 1)
          : execId,
    primaryKey: secondSep >= 0 ? execId.slice(secondSep + 1) : execId,
  };
};

const peekImpl = (
  actorName: string,
  execId: string,
  definitions?: OperationDefs,
): Effect.Effect<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const parsed = parseExecId(execId);

  return Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    const storage = yield* MessageStorage.MessageStorage;

    const entityId = EntityId.make(parsed.entityId);
    const entityType = actorName as unknown as EntityType.EntityType;
    const shardId = sharding.getShardId(entityId, entityType);

    const address = EntityAddress.make({
      entityType,
      entityId,
      shardId,
    });

    const maybeRequestId = yield* storage.requestIdForPrimaryKey({
      address,
      tag: parsed.tag,
      id: parsed.primaryKey,
    });

    if (Option.isNone(maybeRequestId)) {
      return Pending as PeekResult;
    }

    const replies = yield* storage.repliesForUnfiltered<Rpc.Any>([maybeRequestId.value]);
    const last = replies[replies.length - 1];

    if (!last || last._tag !== "WithExit") {
      return Pending as PeekResult;
    }

    const def = definitions?.[parsed.tag];
    return yield* mapCauseEncodedToPeekResult(last.exit as ExitEncodedShape, def);
  });
};

// ── v3 CauseEncoded → PeekResult mapping ─────────────────────────────────

type CauseEncodedShape =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Fail"; readonly error: unknown }
  | { readonly _tag: "Die"; readonly defect: unknown }
  | { readonly _tag: "Interrupt"; readonly fiberId: unknown }
  | {
      readonly _tag: "Sequential";
      readonly left: CauseEncodedShape;
      readonly right: CauseEncodedShape;
    }
  | {
      readonly _tag: "Parallel";
      readonly left: CauseEncodedShape;
      readonly right: CauseEncodedShape;
    };

type ExitEncodedShape =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly cause: CauseEncodedShape };

const decodeValue = (
  schema: Schema.Schema.Any | Schema.Schema.All | undefined,
  value: unknown,
): Effect.Effect<unknown> => {
  if (!schema) return Effect.succeed(value);
  const decode = Schema.decodeUnknown(schema as Schema.Schema<unknown, unknown, never>)(
    value,
  ) as Effect.Effect<unknown, unknown>;
  return Effect.catchAll(decode, () => Effect.succeed(value));
};

const mapCauseEncodedToPeekResult = (
  exit: ExitEncodedShape,
  def?: OperationDef,
): Effect.Effect<PeekResult> => {
  if (exit._tag === "Success") {
    return Effect.map(decodeValue(def?.success, exit.value), Success);
  }

  const first = findFirstCause(exit.cause);
  if (!first) return Effect.succeed(Pending);

  switch (first._tag) {
    case "Fail":
      return Effect.map(decodeValue(def?.error, first.error), Failure);
    case "Die":
      return Effect.succeed(Defect(first.defect));
    case "Interrupt":
      return Effect.succeed(Interrupted);
    default:
      return Effect.succeed(Pending);
  }
};

const findFirstCause = (
  cause: CauseEncodedShape,
):
  | { _tag: "Fail"; error: unknown }
  | { _tag: "Die"; defect: unknown }
  | { _tag: "Interrupt"; fiberId: unknown }
  | null => {
  switch (cause._tag) {
    case "Fail":
    case "Die":
    case "Interrupt":
      return cause;
    case "Empty":
      return null;
    case "Sequential":
    case "Parallel":
      return findFirstCause(cause.left) ?? findFirstCause(cause.right);
  }
};

// ── watch — internal implementation ──────────────────────────────────────

// Workflow poll returns a real Exit.Exit, not encoded — walk Cause tree
const mapExitToWorkflowPeekResult = (exit: Exit.Exit<unknown, unknown>): PeekResult => {
  if (Exit.isSuccess(exit)) {
    return Success(exit.value);
  }
  const cause = exit.cause;
  const errorOpt = Cause.failureOption(cause);
  if (Option.isSome(errorOpt)) return Failure(errorOpt.value);

  const defectOpt = Cause.dieOption(cause);
  if (Option.isSome(defectOpt)) return Defect(defectOpt.value);

  if (Cause.isInterruptedOnly(cause)) return Interrupted;

  return Pending;
};

const watchImpl = (
  actorName: string,
  execId: string,
  definitions?: OperationDefs,
  options?: { readonly interval?: Duration.DurationInput },
): Stream.Stream<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const interval = options?.interval ?? Duration.millis(200);
  return Stream.repeatEffectWithSchedule(
    peekImpl(actorName, execId, definitions),
    Schedule.spaced(interval),
  ).pipe(Stream.changesWith(peekResultEquals), Stream.takeUntil(isTerminal));
};

const peekResultEquals = (a: PeekResult, b: PeekResult): boolean => {
  if (a._tag !== b._tag) return false;
  if (a._tag === "Success" && b._tag === "Success") return a.value === b.value;
  if (a._tag === "Failure" && b._tag === "Failure") return a.error === b.error;
  if (a._tag === "Defect" && b._tag === "Defect") return a.cause === b.cause;
  return true;
};

// ── Actor.fromEntity ──────────────────────────────────────────────────────

const fromEntity = <const Name extends string, const Defs extends OperationDefs>(
  name: Name,
  definitions: AssertNoReservedKeys<Defs>,
): ActorObject<Name, Defs> => {
  for (const tag of Object.keys(definitions)) {
    if (RESERVED_KEYS.has(tag)) {
      throw new Error(
        `effect-encore: operation "${tag}" collides with reserved property. Reserved: ${[...RESERVED_KEYS].join(", ")}`,
      );
    }
  }

  const rpcs = Object.entries(definitions).map(([tag, def]) =>
    compileRpc(name, tag, def as OperationDef),
  );

  const entity = Entity.make(name, rpcs as Array<DefRpcs<Defs>>);

  const constructors: Record<string, Function> = {};
  for (const tag of Object.keys(definitions)) {
    const def = definitions[tag] as OperationDef;
    const opaque = def.payload !== undefined && isOpaquePayload(def.payload);
    constructors[tag] = (input?: unknown) =>
      opaque
        ? { _tag: tag, _payload: input }
        : { _tag: tag, ...(input != null && typeof input === "object" ? input : {}) };
  }

  const contextTag = Context.GenericTag<
    ActorClientService<Name, Defs>,
    ActorClientFactory<Name, Defs>
  >(`effect-encore/${name}/Client`);

  const $is =
    (tag: string) =>
    (value: unknown): boolean =>
      value != null &&
      typeof value === "object" &&
      "_tag" in value &&
      (value as Record<string, unknown>)["_tag"] === tag;

  const actorFn = (entityId: string) => Effect.flatMap(contextTag, (factory) => factory(entityId));

  const peekFn = <S, E>(execId: ExecId<S, E>) =>
    peekImpl(name, execId, definitions) as Effect.Effect<
      PeekResult<S, E>,
      PersistenceError | MalformedMessage,
      MessageStorage.MessageStorage | Sharding.Sharding
    >;

  const watchFn = <S, E>(
    execId: ExecId<S, E>,
    options?: { readonly interval?: Duration.DurationInput },
  ) =>
    watchImpl(name, execId, definitions, options) as Stream.Stream<
      PeekResult<S, E>,
      PersistenceError | MalformedMessage,
      MessageStorage.MessageStorage | Sharding.Sharding
    >;

  const interruptFn = (_entityId: string) =>
    Effect.die(
      new Error(
        `effect-encore: entity interrupt for "${name}" is not supported — Sharding.passivate is not a public API`,
      ),
    );

  const actor = {
    _tag: "ActorObject" as const,
    _meta: { name, definitions, entity },
    Context: contextTag,
    actor: actorFn,
    peek: peekFn,
    watch: watchFn,
    interrupt: interruptFn,
    $is,
    ...constructors,
  };

  return actor as unknown as ActorObject<Name, Defs>;
};

// ── Actor.toLayer ──────────────────────────────────────────────────────────

// Client-only layer (producer): Actor.toLayer(actor)
// Consumer + producer layer: Actor.toLayer(actor, handlers)

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
>(
  actor: ActorObject<Name, Defs, Rpcs>,
): Layer.Layer<ActorClientService<Name, Defs>, never, Scope.Scope | Rpc.MiddlewareClient<Rpcs>>;

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
>(
  actor: ActorObject<Name, Defs, Rpcs>,
  build: ActorHandlers<Defs> | Effect.Effect<ActorHandlers<Defs>, never, RX>,
  options?: HandlerOptions,
  /* eslint-disable typescript-eslint/no-explicit-any -- overload requires any */
): Layer.Layer<ActorClientService<Name, Defs>, never, any>;

// Workflow overload
function toLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
>(
  actor: WorkflowActorObject<Name, Payload, Success, Error>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    executionId: string,
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
): Layer.Layer<ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>, never, any>;

function toLayer(
  actor: any,
  build?: unknown,
  options?: HandlerOptions,
): Layer.Layer<any, any, any> {
  /* eslint-enable typescript-eslint/no-explicit-any */
  if (isWorkflowActor(actor) && build !== undefined) {
    return workflowToLayer(actor, build as Function);
  }

  const clientLayer = Layer.effect(
    actor.Context,
    Effect.map(
      actor._meta.entity.client,
      (makeClient: Function) => (entityId: string) =>
        Effect.succeed(
          buildActorRef(
            actor._meta.name,
            entityId,
            actor._meta.definitions,
            makeClient(entityId) as RpcClient.RpcClient<Rpc.Any, never>,
          ),
        ),
    ),
  );

  if (build === undefined) {
    return clientLayer;
  }

  const transformed = transformHandlers(build, actor._meta.definitions);
  const handlerLayer = actor._meta.entity.toLayer(transformed as never, {
    spanAttributes: options?.spanAttributes,
    maxIdleTime: options?.maxIdleTime,
    concurrency: options?.concurrency,
    mailboxCapacity: options?.mailboxCapacity,
  });

  return Layer.merge(handlerLayer, clientLayer);
}

// ── Actor.toTestLayer ─────────────────────────────────────────────────────

// Entity overload
function toTestLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
>(
  actor: ActorObject<Name, Defs, Rpcs>,
  build: ActorHandlers<Defs> | Effect.Effect<ActorHandlers<Defs>, never, RX>,
  options?: HandlerOptions,
): Layer.Layer<ActorClientService<Name, Defs>>;

// Workflow overload
function toTestLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
>(
  actor: WorkflowActorObject<Name, Payload, Success, Error>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    executionId: string,
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
): Layer.Layer<ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>> | WorkflowEngine>;

/* eslint-disable typescript-eslint/no-explicit-any -- overload implementation */
function toTestLayer(
  actor: any,
  build: unknown,
  options?: HandlerOptions,
): Layer.Layer<any, any, any> {
  /* eslint-enable typescript-eslint/no-explicit-any */
  if (isWorkflowActor(actor)) {
    return workflowToTestLayer(actor, build as Function);
  }

  const transformed = transformHandlers(build, actor._meta.definitions);
  const handlerLayer = actor._meta.entity.toLayer(transformed as never, {
    spanAttributes: options?.spanAttributes,
    maxIdleTime: options?.maxIdleTime,
    concurrency: options?.concurrency,
    mailboxCapacity: options?.mailboxCapacity,
  });

  return Layer.effect(
    actor.Context,
    Effect.map(
      Entity.makeTestClient(actor._meta.entity, handlerLayer as never),
      (makeClient: Function) =>
        (entityId: string): Effect.Effect<ActorRef<string, OperationDefs>> =>
          Effect.map(
            makeClient(entityId) as Effect.Effect<RpcClient.RpcClient<Rpc.Any, never>>,
            (rpcClient) =>
              buildActorRef(actor._meta.name, entityId, actor._meta.definitions, rpcClient),
          ),
    ),
  );
}

// ── Transform handlers from operation-first to request-first ───────────────

const transformHandlers = (build: unknown, definitions?: OperationDefs): unknown => {
  if (build != null && typeof build === "object" && !Effect.isEffect(build)) {
    const handlers = build as Record<string, Function>;
    const transformed: Record<string, Function> = {};
    for (const tag of Object.keys(handlers)) {
      const handler = handlers[tag];
      if (!handler) continue;
      const def = definitions?.[tag];
      const opaque = def?.payload !== undefined && isOpaquePayload(def.payload);
      transformed[tag] = (request: Record<string, unknown>) => {
        const raw = request["payload"];
        const operation = opaque
          ? { _tag: tag, _payload: raw }
          : { _tag: tag, ...((raw ?? {}) as object) };
        return handler({ operation, request });
      };
    }
    return transformed;
  }
  return Effect.map(build as Effect.Effect<unknown>, (b) => transformHandlers(b, definitions));
};

// ── buildActorRef — value-dispatch ref ─────────────────────────────────────

const buildActorRef = <Name extends string, Defs extends OperationDefs>(
  _actorName: Name,
  _entityId: string,
  definitions: Defs,
  rpcClient: RpcClient.RpcClient<Rpc.Any, never>,
): ActorRef<Name, Defs> => {
  const client = rpcClient as unknown as Record<string, Function>;

  const rpcArg = (
    op: { readonly _tag: string; readonly [key: string]: unknown },
    def: OperationDef | undefined,
  ) => {
    if (!def?.payload) return undefined;
    if (isOpaquePayload(def.payload)) return op["_payload"];
    return op;
  };

  return {
    call: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const tag = op["_tag"];
      const fn = client[tag];
      if (!fn)
        return Effect.die(
          new Error(`effect-encore: unknown operation "${tag}" on actor "${_actorName}"`),
        );
      const def = definitions[tag] as OperationDef | undefined;
      const arg = rpcArg(op, def);
      return arg !== undefined ? fn(arg) : fn();
    },
    cast: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const tag = op["_tag"];
      const fn = client[tag];
      if (!fn)
        return Effect.die(
          new Error(`effect-encore: unknown operation "${tag}" on actor "${_actorName}"`),
        );
      const def = definitions[tag] as OperationDef | undefined;
      const arg = rpcArg(op, def);
      const discardCall =
        arg !== undefined ? fn(arg, { discard: true }) : fn(undefined, { discard: true });
      const pkFn = def?.["primaryKey"] as ((p: unknown) => string) | undefined;
      const pkInput = def?.payload && isOpaquePayload(def.payload) ? op["_payload"] : op;
      const primaryKey = pkFn ? pkFn(pkInput) : tag;
      const execId = `${_entityId}\x00${tag}\x00${primaryKey}`;
      return Effect.map(discardCall ?? Effect.void, () => makeExecId(execId));
    },
  } as ActorRef<Name, Defs>;
};

// ── Workflow Definition ────────────────────────────────────────────────────

export interface WorkflowDef<
  Payload extends Schema.Struct.Fields = Schema.Struct.Fields,
  Success extends Schema.Schema.Any = typeof Schema.Void,
  Error extends Schema.Schema.All = typeof Schema.Never,
> {
  readonly payload: Payload;
  readonly success?: Success;
  readonly error?: Error;
  readonly idempotencyKey: (payload: {
    readonly [K in keyof Payload]: Schema.Schema.Type<
      Payload[K] extends Schema.Schema.Any ? Payload[K] : never
    >;
  }) => string;
}

type WorkflowPayloadType<Payload extends Schema.Struct.Fields> = {
  readonly [K in keyof Payload]: Schema.Schema.Type<
    Payload[K] extends Schema.Schema.Any ? Payload[K] : never
  >;
};

type WorkflowRunDefs<
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
> = {
  readonly Run: {
    readonly payload: Schema.Struct<Payload>;
    readonly success: Success;
    readonly error: Error;
    readonly primaryKey: (payload: never) => string;
  };
};

export type WorkflowActorObject<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
> = {
  readonly _tag: "WorkflowActorObject";
  readonly _meta: {
    readonly name: Name;
    readonly workflow: UpstreamWorkflow.Workflow<Name, Schema.Struct<Payload>, Success, Error>;
  };
  readonly Context: Context.Tag<
    ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>,
    ActorClientFactory<Name, WorkflowRunDefs<Payload, Success, Error>>
  >;
  readonly Run: (
    payload: WorkflowPayloadType<Payload>,
  ) => { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
    OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;
  readonly actor: (
    entityId: string,
  ) => Effect.Effect<
    ActorRef<Name, WorkflowRunDefs<Payload, Success, Error>>,
    never,
    ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>
  >;
  readonly peek: <S, E>(
    execId: ExecId<S, E>,
  ) => Effect.Effect<PeekResult<S, E>, never, WorkflowEngine>;
  readonly watch: <S, E>(
    execId: ExecId<S, E>,
    options?: { readonly interval?: Duration.DurationInput },
  ) => Stream.Stream<PeekResult<S, E>, never, WorkflowEngine>;
  readonly interrupt: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly executionId: (payload: WorkflowPayloadType<Payload>) => Effect.Effect<string>;
  readonly withCompensation: UpstreamWorkflow.Workflow<
    Name,
    Schema.Struct<Payload>,
    Success,
    Error
  >["withCompensation"];
  readonly $is: (tag: "Run") => (value: unknown) => boolean;
};

// ── Actor.fromWorkflow ────────────────────────────────────────────────────

const fromWorkflow = <
  const Name extends string,
  const Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any = typeof Schema.Void,
  Error extends Schema.Schema.All = typeof Schema.Never,
>(
  name: Name,
  def: WorkflowDef<Payload, Success, Error>,
): WorkflowActorObject<Name, Payload, Success, Error> => {
  const workflowOptions: Record<string, unknown> = {
    name,
    payload: def.payload,
    idempotencyKey: def.idempotencyKey,
  };
  if (def.success) workflowOptions["success"] = def.success;
  if (def.error) workflowOptions["error"] = def.error;

  const wf = (UpstreamWorkflow.make as Function)(workflowOptions) as UpstreamWorkflow.Workflow<
    Name,
    Schema.Struct<Payload>,
    Success,
    Error
  >;

  type WfDefs = WorkflowRunDefs<Payload, Success, Error>;

  const contextTag = Context.GenericTag<
    ActorClientService<Name, WfDefs>,
    ActorClientFactory<Name, WfDefs>
  >(`effect-encore/${name}/Client`);

  const Run = (payload: WorkflowPayloadType<Payload>) =>
    ({ _tag: "Run", ...payload }) as { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
      OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;

  const actorFn = (entityId: string) => Effect.flatMap(contextTag, (factory) => factory(entityId));

  const peekFn = <S, E>(execId: ExecId<S, E>) =>
    Effect.map(
      wf.poll(execId) as Effect.Effect<unknown, never, WorkflowEngine>,
      (pollResult): PeekResult<S, E> => {
        if (pollResult == null) return Pending as PeekResult<S, E>;
        const result = pollResult as {
          _tag: string;
          exit?: Exit.Exit<unknown, unknown>;
        };
        if (result._tag === "Suspended") return Suspended as PeekResult<S, E>;
        if (result._tag === "Complete" && result.exit) {
          return mapExitToWorkflowPeekResult(result.exit) as PeekResult<S, E>;
        }
        return Pending as PeekResult<S, E>;
      },
    ) as Effect.Effect<PeekResult<S, E>, never, WorkflowEngine>;

  const watchFn = <S, E>(
    execId: ExecId<S, E>,
    options?: { readonly interval?: Duration.DurationInput },
  ) => {
    const interval = options?.interval ?? Duration.millis(200);
    return Stream.repeatEffectWithSchedule(peekFn(execId), Schedule.spaced(interval)).pipe(
      Stream.changesWith(peekResultEquals as (a: PeekResult<S, E>, b: PeekResult<S, E>) => boolean),
      Stream.takeUntil(isTerminal as (r: PeekResult<S, E>) => boolean),
    ) as Stream.Stream<PeekResult<S, E>, never, WorkflowEngine>;
  };

  const $is =
    (tag: string) =>
    (value: unknown): boolean =>
      value != null &&
      typeof value === "object" &&
      "_tag" in value &&
      (value as Record<string, unknown>)["_tag"] === tag;

  return {
    _tag: "WorkflowActorObject" as const,
    _meta: { name, workflow: wf },
    Context: contextTag,
    Run,
    actor: actorFn,
    peek: peekFn,
    watch: watchFn,
    interrupt: (executionId: string) => wf.interrupt(executionId),
    resume: (executionId: string) => wf.resume(executionId),
    executionId: (payload: WorkflowPayloadType<Payload>) => wf.executionId(payload as never),
    withCompensation: wf.withCompensation.bind(wf) as WorkflowActorObject<
      Name,
      Payload,
      Success,
      Error
    >["withCompensation"],
    $is,
  } as WorkflowActorObject<Name, Payload, Success, Error>;
};

// ── Workflow-aware helpers ────────────────────────────────────────────────

/* eslint-disable typescript-eslint/no-explicit-any */
const isWorkflowActor = (
  actor: unknown,
): actor is WorkflowActorObject<
  string,
  Schema.Struct.Fields,
  Schema.Schema.Any,
  Schema.Schema.Any
> =>
  actor != null &&
  typeof actor === "object" &&
  "_tag" in actor &&
  (actor as Record<string, unknown>)["_tag"] === "WorkflowActorObject";

const workflowToLayer = (
  actor: WorkflowActorObject<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const wf = actor._meta.workflow;
  const handlerLayer = wf.toLayer(handler as any);
  const clientLayer = Layer.effect(
    actor.Context,
    Effect.succeed((entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, entityId))),
  );
  return Layer.merge(handlerLayer, clientLayer);
};

const workflowToTestLayer = (
  actor: WorkflowActorObject<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const wf = actor._meta.workflow;
  const handlerLayer = Layer.provide(wf.toLayer(handler as any), workflowEngineLayerMemory);
  const clientLayer = Layer.effect(
    actor.Context,
    Effect.succeed((entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, entityId))),
  );
  return Layer.provideMerge(Layer.merge(clientLayer, workflowEngineLayerMemory), handlerLayer);
};

const buildWorkflowActorRef = (
  actor: WorkflowActorObject<any, any, any, any>,
  _entityId: string,
): ActorRef<any, any> => {
  const wf = actor._meta.workflow;
  return {
    call: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = op;
      return wf.execute(payload as any);
    },
    cast: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = op;
      return Effect.map(
        wf.execute(payload as any, { discard: true }) as Effect.Effect<string>,
        (execId) => makeExecId(execId),
      );
    },
  } as ActorRef<any, any>;
};
/* eslint-enable typescript-eslint/no-explicit-any */

// ── Escape hatch: raw Rpc definitions ──────────────────────────────────────

export const fromRpcs = <const Name extends string, const Rpcs extends ReadonlyArray<Rpc.Any>>(
  name: Name,
  rpcs: Rpcs,
): {
  readonly _tag: "RawActorDefinition";
  readonly name: Name;
  readonly entity: ClusterEntity.Entity<Name, Rpcs[number]>;
} => ({
  _tag: "RawActorDefinition",
  name,
  entity: Entity.make(name, rpcs as unknown as Array<Rpcs[number]>),
});

// ── Public API ─────────────────────────────────────────────────────────────

export const Actor = {
  fromEntity,
  fromWorkflow,
  fromRpcs,
  toLayer,
  toTestLayer,
} as const;
