import type { Entity as ClusterEntity } from "@effect/cluster";
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
import type { Rpc, RpcClient, RpcGroup } from "@effect/rpc";
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
  Pipeable,
  PrimaryKey,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { DateTime, Scope } from "effect";
import { dual } from "effect/Function";
import type { SignalDefs, WorkflowSignal, WorkflowStepContext } from "./step.js";
import { makeSignal, makeStepContext } from "./step.js";
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

// ── Layer passthrough polyfill ─────────────────────────────────────────────
// Layer.passthrough was removed in Effect 3.x. Polyfill it so input services
// appear in the output — same semantics as the original.
const layerPassthrough = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut | RIn, E, RIn> =>
  Layer.merge(Layer.effectContext(Effect.context<RIn>()), layer);

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

type ReservedKeys =
  | "_tag"
  | "_meta"
  | "$is"
  | "Context"
  | "ref"
  | "name"
  | "type"
  | "of"
  | "peek"
  | "watch"
  | "waitFor"
  | "interrupt"
  | "executionId"
  | "flush"
  | "redeliver"
  | "pipe";

type AssertNoReservedKeys<Defs extends OperationDefs> =
  Extract<keyof Defs, ReservedKeys> extends never ? Defs : never;

const RESERVED_KEYS = new Set<string>([
  "_tag",
  "_meta",
  "$is",
  "Context",
  "ref",
  "name",
  "type",
  "of",
  "peek",
  "watch",
  "waitFor",
  "interrupt",
  "executionId",
  "flush",
  "redeliver",
  "pipe",
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
  readonly execute: <V extends OperationUnion<Name, Defs>>(
    op: V,
  ) => Effect.Effect<OperationOutput<V>, OperationError<V>>;
  readonly send: <V extends OperationUnion<Name, Defs>>(
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

export interface ActorClientService<Name extends string, Defs extends OperationDefs> {
  readonly [ActorClientServiceId]: {
    readonly name: Name;
    readonly defs: Defs;
  };
}

export type ActorClientFactory<Name extends string, Defs extends OperationDefs> = (
  entityId: string,
) => Effect.Effect<ActorRef<Name, Defs>>;

// ── EntityActor — the unified return type ──────────────────────────────────

type ActorConstructors<Name extends string, Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: OperationConstructor<Name, Tag, Defs[Tag]>;
};

export type EntityActor<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> = ActorConstructors<Name, Defs> &
  Pipeable.Pipeable & {
    readonly _tag: "EntityActor";
    readonly name: Name;
    readonly type: Name;
    readonly _meta: ActorMeta<Name, Defs, Rpcs>;
    readonly Context: Context.Tag<ActorClientService<Name, Defs>, ActorClientFactory<Name, Defs>>;
    readonly ref: (
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
    readonly waitFor: <S, E>(
      execId: ExecId<S, E>,
      options?: {
        readonly filter?: (result: PeekResult<S, E>) => boolean;
        // eslint-disable-next-line typescript-eslint/no-explicit-any
        readonly schedule?: Schedule.Schedule<any, unknown>;
      },
    ) => Effect.Effect<
      PeekResult<S, E>,
      PersistenceError | MalformedMessage,
      MessageStorage.MessageStorage | Sharding.Sharding
    >;
    readonly executionId: <V extends OperationUnion<Name, Defs>>(
      entityId: string,
      op: V,
    ) => Effect.Effect<ExecId<OperationOutput<V>, OperationError<V>>>;
    readonly interrupt: (entityId: string) => Effect.Effect<void, never, Sharding.Sharding>;
    readonly flush: (
      actorId: string,
    ) => Effect.Effect<void, PersistenceError, MessageStorage.MessageStorage | Sharding.Sharding>;
    readonly redeliver: (
      actorId: string,
    ) => Effect.Effect<void, PersistenceError, MessageStorage.MessageStorage | Sharding.Sharding>;
    readonly of: (handlers: ActorHandlers<Defs>) => ActorHandlers<Defs>;
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

// eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased at runtime
const resolveAddress = (entity: ClusterEntity.Entity<string, any>, actorId: string) =>
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    const entityId = EntityId.make(actorId);
    const shardId = sharding.getShardId(entityId, entity.getShardGroup(entityId));
    return EntityAddress.make({
      entityType: entity.type,
      entityId,
      shardId,
    });
  });

const flushImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  actorId: string,
): Effect.Effect<void, PersistenceError, MessageStorage.MessageStorage | Sharding.Sharding> =>
  Effect.gen(function* () {
    const storage = yield* MessageStorage.MessageStorage;
    const address = yield* resolveAddress(entity, actorId);
    yield* storage.clearAddress(address);
  });

const redeliverImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  actorId: string,
): Effect.Effect<void, PersistenceError, MessageStorage.MessageStorage | Sharding.Sharding> =>
  Effect.gen(function* () {
    const storage = yield* MessageStorage.MessageStorage;
    const address = yield* resolveAddress(entity, actorId);
    yield* storage.resetAddress(address);
  });

const peekImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  execId: string,
  definitions?: OperationDefs,
): Effect.Effect<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const parsed = parseExecId(execId);

  return Effect.gen(function* () {
    const storage = yield* MessageStorage.MessageStorage;
    const address = yield* resolveAddress(entity, parsed.entityId);

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
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
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
    peekImpl(entity, execId, definitions),
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

// ── waitFor helper ──────────���─────────────────────────────────────────────

/* eslint-disable typescript-eslint/no-explicit-any -- waitFor requires open types */
const defaultWaitSchedule = Schedule.spaced("200 millis");

const makeWaitFor = <S, E>(
  peekFn: (execId: ExecId<S, E>) => Effect.Effect<PeekResult<S, E>, any, any>,
  execId: ExecId<S, E>,
  options?: {
    readonly filter?: (result: PeekResult<S, E>) => boolean;
    readonly schedule?: Schedule.Schedule<any, unknown>;
  },
): Effect.Effect<PeekResult<S, E>, any, any> => {
  const filter = options?.filter ?? (isTerminal as (r: PeekResult<S, E>) => boolean);
  const sched = options?.schedule ?? defaultWaitSchedule;
  return peekFn(execId).pipe(
    Effect.repeat({
      schedule: sched as Schedule.Schedule<any, PeekResult<S, E>>,
      while: (result) => !filter(result),
    }),
  );
};

// ���─ Actor.fromEntity ──────────────���────────────────────────────────���──────

const fromEntity = <const Name extends string, const Defs extends OperationDefs>(
  name: Name,
  definitions: AssertNoReservedKeys<Defs>,
): EntityActor<Name, Defs> => {
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

  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity<Name> → Entity<string> widening
  const entityAny = entity as unknown as ClusterEntity.Entity<string, any>;

  const peekFn = <S, E>(execId: ExecId<S, E>) =>
    peekImpl(entityAny, execId, definitions) as Effect.Effect<
      PeekResult<S, E>,
      PersistenceError | MalformedMessage,
      MessageStorage.MessageStorage | Sharding.Sharding
    >;

  const watchFn = <S, E>(
    execId: ExecId<S, E>,
    options?: { readonly interval?: Duration.DurationInput },
  ) =>
    watchImpl(entityAny, execId, definitions, options) as Stream.Stream<
      PeekResult<S, E>,
      PersistenceError | MalformedMessage,
      MessageStorage.MessageStorage | Sharding.Sharding
    >;

  const flushFn = (actorId: string) => flushImpl(entityAny, actorId);
  const redeliverFn = (actorId: string) => redeliverImpl(entityAny, actorId);

  const executionIdFn = (
    entityId: string,
    op: { readonly _tag: string; readonly [key: string]: unknown },
  ) => {
    const tag = op["_tag"];
    const def = definitions[tag] as OperationDef | undefined;
    const pkFn = def?.["primaryKey"] as ((p: unknown) => string) | undefined;
    const pkInput = def?.payload && isOpaquePayload(def.payload) ? op["_payload"] : op;
    const primaryKey = pkFn ? pkFn(pkInput) : tag;
    return Effect.succeed(makeExecId(`${entityId}\x00${tag}\x00${primaryKey}`));
  };

  const interruptFn = (_entityId: string) =>
    Effect.die(
      new Error(
        `effect-encore: entity interrupt for "${name}" is not supported — Sharding.passivate is not a public API`,
      ),
    );

  const ofFn = <T>(handlers: T): T => handlers;

  const actor = Object.assign(Object.create(Pipeable.Prototype), {
    _tag: "EntityActor" as const,
    name,
    type: name,
    _meta: { name, definitions, entity },
    Context: contextTag,
    of: ofFn,
    ref: actorFn,
    peek: peekFn,
    watch: watchFn,
    waitFor: <S, E>(
      execId: ExecId<S, E>,
      options?: {
        readonly filter?: (result: PeekResult<S, E>) => boolean;
        // eslint-disable-next-line typescript-eslint/no-explicit-any
        readonly schedule?: Schedule.Schedule<any, unknown>;
      },
    ) => makeWaitFor(peekFn, execId, options),
    executionId: executionIdFn,
    interrupt: interruptFn,
    flush: flushFn,
    redeliver: redeliverFn,
    $is,
    ...constructors,
  });

  return actor as EntityActor<Name, Defs>;
};

// ── Actor.toLayer ──────────────────────────────────────────────────────────

// Client-only layer (producer): Actor.toLayer(actor)
// Consumer + producer layer: Actor.toLayer(actor, handlers)

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
>(
  actor: EntityActor<Name, Defs, Rpcs>,
): Layer.Layer<ActorClientService<Name, Defs>, never, Scope.Scope | Rpc.MiddlewareClient<Rpcs>>;

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
>(
  actor: EntityActor<Name, Defs, Rpcs>,
  build: ActorHandlers<Defs> | Effect.Effect<ActorHandlers<Defs>, never, RX>,
  options?: HandlerOptions,
  /* eslint-disable typescript-eslint/no-explicit-any -- implementation overload requires any */
): Layer.Layer<
  ActorClientService<Name, Defs>,
  never,
  RX | Scope.Scope | Rpc.MiddlewareClient<Rpcs>
>;

// Workflow overload
function toLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
  Signals extends SignalDefs,
  RX = never,
>(
  actor: WorkflowActor<Name, Payload, Success, Error, Signals>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    step: WorkflowStepContext<Error>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>, RX>,
): Layer.Layer<
  ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>,
  never,
  RX | WorkflowEngine
>;

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

  return layerPassthrough(Layer.merge(handlerLayer, clientLayer));
}

// ── Actor.toTestLayer ─────────────────────────────────────────────────────

// Entity overload
function toTestLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
>(
  actor: EntityActor<Name, Defs, Rpcs>,
  build: ActorHandlers<Defs> | Effect.Effect<ActorHandlers<Defs>, never, RX>,
  options?: HandlerOptions,
): Layer.Layer<ActorClientService<Name, Defs>>;

// Workflow overload
function toTestLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
  Signals extends SignalDefs,
>(
  actor: WorkflowActor<Name, Payload, Success, Error, Signals>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    step: WorkflowStepContext<Error>,
    // eslint-disable-next-line typescript-eslint/no-explicit-any
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>, any>,
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
    execute: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
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
    send: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
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

// ── Workflow reserved keys + signal constructors ─────────────────────────

const WORKFLOW_RESERVED_KEYS = new Set<string>([
  "_tag",
  "_meta",
  "$is",
  "Context",
  "ref",
  "name",
  "type",
  "of",
  "Run",
  "peek",
  "watch",
  "waitFor",
  "interrupt",
  "resume",
  "executionId",
  "pipe",
]);

type SignalConstructors<
  Payload extends UpstreamWorkflow.AnyStructSchema,
  Defs extends SignalDefs,
> = {
  readonly [K in keyof Defs & string]: WorkflowSignal<
    Payload,
    Defs[K] extends { success: infer S extends Schema.Schema.Any } ? S : typeof Schema.Void,
    Defs[K] extends { error: infer E extends Schema.Schema.All } ? E : typeof Schema.Never
  >;
};

// ── Workflow Definition ────────────────────────────────────────────────────

export interface WorkflowDef<
  Payload extends Schema.Struct.Fields = Schema.Struct.Fields,
  Success extends Schema.Schema.Any = typeof Schema.Void,
  Error extends Schema.Schema.All = typeof Schema.Never,
  Signals extends SignalDefs = {},
> {
  readonly payload: Payload;
  readonly success?: Success;
  readonly error?: Error;
  readonly idempotencyKey: (payload: {
    readonly [K in keyof Payload]: Schema.Schema.Type<
      Payload[K] extends Schema.Schema.Any ? Payload[K] : never
    >;
  }) => string;
  readonly signals?: Signals;
  // eslint-disable-next-line typescript-eslint/no-explicit-any
  readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown>;
  readonly captureDefects?: boolean;
  readonly suspendOnFailure?: boolean;
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

export type WorkflowActor<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
  Signals extends SignalDefs = {},
> = SignalConstructors<Schema.Struct<Payload>, Signals> & {
  readonly _tag: "WorkflowActor";
  readonly name: Name;
  readonly type: `Workflow/${Name}`;
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
  readonly ref: () => Effect.Effect<
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
  readonly waitFor: <S, E>(
    execId: ExecId<S, E>,
    options?: {
      readonly filter?: (result: PeekResult<S, E>) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => Effect.Effect<PeekResult<S, E>, never, WorkflowEngine>;
  readonly interrupt: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly executionId: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<ExecId<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>>;
  readonly $is: (tag: "Run") => (value: unknown) => boolean;
};

// ── Actor.fromWorkflow ────────────────────────────────────────────────────

const fromWorkflow = <
  const Name extends string,
  const Payload extends Schema.Struct.Fields,
  Success extends Schema.Schema.Any = typeof Schema.Void,
  Error extends Schema.Schema.All = typeof Schema.Never,
  const Signals extends SignalDefs = {},
>(
  name: Name,
  def: WorkflowDef<Payload, Success, Error, Signals>,
): WorkflowActor<Name, Payload, Success, Error, Signals> => {
  const workflowOptions: Record<string, unknown> = {
    name,
    payload: def.payload,
    idempotencyKey: def.idempotencyKey,
  };
  if (def.success) workflowOptions["success"] = def.success;
  if (def.error) workflowOptions["error"] = def.error;
  if (def.suspendedRetrySchedule)
    workflowOptions["suspendedRetrySchedule"] = def.suspendedRetrySchedule;

  let wf = (UpstreamWorkflow.make as Function)(workflowOptions) as UpstreamWorkflow.Workflow<
    Name,
    Schema.Struct<Payload>,
    Success,
    Error
  >;
  if (def.captureDefects !== undefined)
    wf = wf.annotate(UpstreamWorkflow.CaptureDefects, def.captureDefects);
  if (def.suspendOnFailure !== undefined)
    wf = wf.annotate(UpstreamWorkflow.SuspendOnFailure, def.suspendOnFailure);

  type WfDefs = WorkflowRunDefs<Payload, Success, Error>;

  const contextTag = Context.GenericTag<
    ActorClientService<Name, WfDefs>,
    ActorClientFactory<Name, WfDefs>
  >(`effect-encore/${name}/Client`);

  const Run = (payload: WorkflowPayloadType<Payload>) =>
    ({ _tag: "Run", ...payload }) as { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
      OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;

  const actorFn = () => Effect.flatMap(contextTag, (factory) => factory(""));

  // Build declarative signals
  /* eslint-disable typescript-eslint/no-explicit-any -- signal types are erased at runtime */
  const signals: Record<string, WorkflowSignal<any, any, any>> = {};
  /* eslint-enable typescript-eslint/no-explicit-any */
  for (const [sigName, sigDef] of Object.entries(def.signals ?? {})) {
    if (WORKFLOW_RESERVED_KEYS.has(sigName)) {
      throw new Error(
        `effect-encore: signal "${sigName}" collides with reserved property on workflow "${name}". Reserved: ${[...WORKFLOW_RESERVED_KEYS].join(", ")}`,
      );
    }
    // eslint-disable-next-line typescript-eslint/no-explicit-any
    signals[sigName] = makeSignal(wf as any, sigName, {
      success: sigDef.success,
      error: sigDef.error,
    });
  }

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
    ...signals,
    _tag: "WorkflowActor" as const,
    name,
    type: `Workflow/${name}` as const,
    _meta: { name, workflow: wf },
    Context: contextTag,
    Run,
    ref: actorFn,
    peek: peekFn,
    watch: watchFn,
    waitFor: <S, E>(
      execId: ExecId<S, E>,
      options?: {
        readonly filter?: (result: PeekResult<S, E>) => boolean;
        // eslint-disable-next-line typescript-eslint/no-explicit-any
        readonly schedule?: Schedule.Schedule<any, unknown>;
      },
    ) =>
      makeWaitFor(peekFn, execId, options) as Effect.Effect<
        PeekResult<S, E>,
        never,
        WorkflowEngine
      >,
    interrupt: (executionId: string) => wf.interrupt(executionId),
    resume: (executionId: string) => wf.resume(executionId),
    executionId: (payload: WorkflowPayloadType<Payload>) =>
      Effect.map(wf.executionId(payload as never), (id) => makeExecId(id)),
    $is,
  } as WorkflowActor<Name, Payload, Success, Error, Signals>;
};

// ── Workflow-aware helpers ─────────────���────────────────────────────��─────

/* eslint-disable typescript-eslint/no-explicit-any */
const isWorkflowActor = (
  actor: unknown,
): actor is WorkflowActor<string, Schema.Struct.Fields, Schema.Schema.Any, Schema.Schema.Any> =>
  actor != null &&
  typeof actor === "object" &&
  "_tag" in actor &&
  (actor as Record<string, unknown>)["_tag"] === "WorkflowActor";

const wrapWorkflowHandler = (actor: WorkflowActor<any, any, any, any>, handler: Function) => {
  const wf = actor._meta.workflow;
  return (payload: any, executionId: string) => {
    const step = makeStepContext(wf, executionId);
    return handler(payload, step);
  };
};

const workflowToLayer = (
  actor: WorkflowActor<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const wf = actor._meta.workflow;
  const handlerLayer = wf.toLayer(wrapWorkflowHandler(actor, handler) as any);
  const clientLayer = Layer.effect(
    actor.Context,
    Effect.succeed((entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, entityId))),
  );
  // handlerLayer requires WorkflowEngine and registers the workflow.
  // clientLayer has no requirements but ref.execute/send need WorkflowEngine at runtime.
  // Use passthrough so WorkflowEngine stays in the output for program code.
  return layerPassthrough(Layer.merge(handlerLayer, clientLayer));
};

const workflowToTestLayer = (
  actor: WorkflowActor<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const wf = actor._meta.workflow;
  const handlerLayer = Layer.provide(
    wf.toLayer(wrapWorkflowHandler(actor, handler) as any),
    workflowEngineLayerMemory,
  );
  const clientLayer = Layer.effect(
    actor.Context,
    Effect.succeed((entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, entityId))),
  );
  return Layer.provideMerge(Layer.merge(clientLayer, workflowEngineLayerMemory), handlerLayer);
};

const buildWorkflowActorRef = (
  actor: WorkflowActor<any, any, any, any>,
  _entityId: string,
): ActorRef<any, any> => {
  const wf = actor._meta.workflow;
  return {
    execute: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = op;
      return wf.execute(payload as any);
    },
    send: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
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

// ── Protocol transform ────────────────────────────────────────────────────

type WithProtocolDataLast = {
  (
    transform: <Rpcs extends Rpc.Any>(protocol: RpcGroup.RpcGroup<Rpcs>) => RpcGroup.RpcGroup<Rpcs>,
  ): <Name extends string, Defs extends OperationDefs, Rpcs extends Rpc.Any>(
    actor: EntityActor<Name, Defs, Rpcs>,
  ) => EntityActor<Name, Defs, Rpcs>;
  <RpcsIn extends Rpc.Any, RpcsOut extends Rpc.Any>(
    transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
  ): <Name extends string, Defs extends OperationDefs>(
    actor: EntityActor<Name, Defs, RpcsIn>,
  ) => EntityActor<Name, Defs, RpcsOut>;
};

type WithProtocolDataFirst = <
  Name extends string,
  Defs extends OperationDefs,
  RpcsIn extends Rpc.Any,
  RpcsOut extends Rpc.Any,
>(
  actor: EntityActor<Name, Defs, RpcsIn>,
  transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
) => EntityActor<Name, Defs, RpcsOut>;

type WithProtocol = WithProtocolDataLast & WithProtocolDataFirst;

const withProtocolImpl = <
  Name extends string,
  Defs extends OperationDefs,
  RpcsIn extends Rpc.Any,
  RpcsOut extends Rpc.Any,
>(
  actor: EntityActor<Name, Defs, RpcsIn>,
  transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
): EntityActor<Name, Defs, RpcsOut> => {
  const newEntity = Entity.fromRpcGroup(actor._meta.name, transform(actor._meta.entity.protocol));
  return Object.assign(Object.create(Pipeable.Prototype), actor, {
    _meta: { ...actor._meta, entity: newEntity },
  }) as EntityActor<Name, Defs, RpcsOut>;
};

export const withProtocol: WithProtocol = dual(2, withProtocolImpl);

// ── Any types + Type Guards ───────────────────────────────────────────────

// eslint-disable-next-line typescript-eslint/no-explicit-any
export type AnyEntityActor = EntityActor<any, any, any>;
// eslint-disable-next-line typescript-eslint/no-explicit-any
export type AnyWorkflowActor = WorkflowActor<any, any, any, any, any>;
export type AnyActor = AnyEntityActor | AnyWorkflowActor;

const isEntity = (actor: AnyActor): actor is AnyEntityActor => actor._tag === "EntityActor";

const isWorkflow = (actor: AnyActor): actor is AnyWorkflowActor => actor._tag === "WorkflowActor";

// ── Public API ─────────────────────────────────────────────────────────────

export const Actor = {
  fromEntity,
  fromWorkflow,
  fromRpcs,
  withProtocol,
  toLayer,
  toTestLayer,
  isEntity,
  isWorkflow,
} as const;
