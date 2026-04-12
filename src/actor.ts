import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import {
  ClusterSchema,
  Entity,
  EntityAddress,
  EntityId,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
import type { MalformedMessage, PersistenceError } from "effect/unstable/cluster/ClusterError";
import type { Rpc, RpcClient, RpcGroup, RpcMessage } from "effect/unstable/rpc";
import { Rpc as RpcMod } from "effect/unstable/rpc";
import { Workflow as UpstreamWorkflow } from "effect/unstable/workflow";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import { layerMemory as workflowEngineLayerMemory } from "effect/unstable/workflow/WorkflowEngine";
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

// ── Layer passthrough (v4 polyfill — v3 has Layer.passthrough) ────────────
// Adds the layer's input requirements to its output so provided services
// flow through to program code. Same as Layer.passthrough in v3.
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
  readonly payload?: Schema.Top | Schema.Struct.Fields;
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
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
  | "actor"
  | "name"
  | "type"
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
  "actor",
  "name",
  "type",
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
  readonly payload: infer P extends Schema.Top;
}
  ? P
  : C extends { readonly payload: infer F extends Schema.Struct.Fields }
    ? Schema.Struct<F>
    : typeof Schema.Void;

type SuccessOf<C extends OperationDef> = C extends {
  readonly success: infer S extends Schema.Top;
}
  ? S
  : typeof Schema.Void;

type ErrorOf<C extends OperationDef> = C extends {
  readonly error: infer E extends Schema.Top;
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
type FieldfulSchema = Schema.Top & { readonly fields: Schema.Struct.Fields };

type PayloadFieldsType<C extends OperationDef> = C extends {
  readonly payload: infer F extends Schema.Struct.Fields;
}
  ? { readonly [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never> }
  : C extends { readonly payload: infer P extends FieldfulSchema }
    ? Schema.Schema.Type<P>
    : C extends { readonly payload: infer P extends Schema.Top }
      ? { readonly _payload: Schema.Schema.Type<P> }
      : {};

type OperationConstructorPayload<C extends OperationDef> = C extends {
  readonly payload: infer F extends Schema.Struct.Fields;
}
  ? {} extends { [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never> }
    ? []
    : [
        payload: {
          readonly [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never>;
        },
      ]
  : C extends { readonly payload: infer P extends FieldfulSchema }
    ? [payload: Schema.Schema.Type<P>]
    : C extends { readonly payload: infer P extends Schema.Top }
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

// ── ActorObject — the unified return type ──────────────────────────────────

type ActorConstructors<Name extends string, Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: OperationConstructor<Name, Tag, Defs[Tag]>;
};

export type EntityActorObject<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> = ActorConstructors<Name, Defs> &
  Pipeable.Pipeable & {
    readonly _tag: "EntityActorObject";
    readonly name: Name;
    readonly type: Name;
    readonly _meta: ActorMeta<Name, Defs, Rpcs>;
    readonly Context: Context.Service<
      ActorClientService<Name, Defs>,
      ActorClientFactory<Name, Defs>
    >;
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
      options?: { readonly interval?: Duration.Input },
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

    const replies = yield* storage.repliesForUnfiltered([maybeRequestId.value]);
    const last = replies[replies.length - 1];

    if (!last || last._tag !== "WithExit") {
      return Pending as PeekResult;
    }

    const def = definitions?.[parsed.tag];
    return yield* mapExitToPeekResult(last.exit, def);
  });
};

const decodeValue = (schema: Schema.Top | undefined, value: unknown): Effect.Effect<unknown> => {
  if (!schema) return Effect.succeed(value);
  const decode = Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown>;
  return Effect.map(Effect.option(decode), (opt) => (Option.isSome(opt) ? opt.value : value));
};

const mapExitToPeekResult = (
  exit: RpcMessage.ExitEncoded<unknown, unknown>,
  def?: OperationDef,
): Effect.Effect<PeekResult> => {
  if (exit._tag === "Success") {
    return Effect.map(decodeValue(def?.success, exit.value), Success);
  }

  const cause = exit.cause[0];
  if (!cause) return Effect.succeed(Pending);

  switch (cause._tag) {
    case "Fail":
      return Effect.map(decodeValue(def?.error, cause.error), Failure);
    case "Die":
      return Effect.succeed(Defect(cause.defect));
    case "Interrupt":
      return Effect.succeed(Interrupted);
    default:
      return Effect.succeed(Pending);
  }
};

// Workflow poll returns a real Exit.Exit, not encoded — walk Cause tree
const mapExitToWorkflowPeekResult = (exit: Exit.Exit<unknown, unknown>): PeekResult => {
  if (Exit.isSuccess(exit)) {
    return Success(exit.value);
  }
  const cause = exit.cause;
  const errorOpt = Cause.findErrorOption(cause);
  if (Option.isSome(errorOpt)) return Failure(errorOpt.value);

  const defectResult = Cause.findDefect(cause);
  if (defectResult._tag === "Success") return Defect(defectResult.success);

  const interruptResult = Cause.findInterrupt(cause);
  if (interruptResult._tag === "Success") return Interrupted;

  return Pending;
};

// ── watch — internal implementation ──────────────────────────────────────

const watchImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  execId: string,
  definitions?: OperationDefs,
  options?: { readonly interval?: Duration.Input },
): Stream.Stream<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const interval = options?.interval ?? Duration.millis(200);
  return Stream.fromEffectSchedule(
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

// ── waitFor helper ────────────────────────────────────���───────────────────

/* eslint-disable-next-line typescript-eslint/no-explicit-any -- Schedule types are open */
const defaultWaitSchedule: Schedule.Schedule<any, unknown> = Schedule.spaced("200 millis");

/* eslint-disable typescript-eslint/no-explicit-any -- waitFor/signal require open types */
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

// ── Actor.fromEntity ──────────────────────────────────────────────────────

const fromEntity = <const Name extends string, const Defs extends OperationDefs>(
  name: Name,
  definitions: AssertNoReservedKeys<Defs>,
): EntityActorObject<Name, Defs> => {
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

  const contextTag = Context.Service<
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

  const actorFn = (entityId: string) =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      return yield* factory(entityId);
    });

  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity<Name> → Entity<string> widening
  const entityAny = entity as unknown as ClusterEntity.Entity<string, any>;

  const peekFn = <S, E>(execId: ExecId<S, E>) =>
    peekImpl(entityAny, execId, definitions) as Effect.Effect<
      PeekResult<S, E>,
      PersistenceError | MalformedMessage,
      MessageStorage.MessageStorage | Sharding.Sharding
    >;

  const watchFn = <S, E>(execId: ExecId<S, E>, options?: { readonly interval?: Duration.Input }) =>
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

  const actor = Object.assign(Object.create(Pipeable.Prototype), {
    _tag: "EntityActorObject" as const,
    name,
    type: name,
    _meta: { name, definitions, entity },
    Context: contextTag,
    actor: actorFn,
    peek: peekFn,
    watch: watchFn,
    waitFor: <S, E>(
      execId: ExecId<S, E>,
      options?: {
        readonly filter?: (result: PeekResult<S, E>) => boolean;
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

  return actor as EntityActorObject<Name, Defs>;
};

// ── Actor.toLayer ──────────────────────────────────────────────────────────

// Client-only layer (producer): Actor.toLayer(actor)
// Consumer + producer layer: Actor.toLayer(actor, handlers)

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
>(
  actor: EntityActorObject<Name, Defs, Rpcs>,
): Layer.Layer<ActorClientService<Name, Defs>, never, Scope.Scope | Rpc.MiddlewareClient<Rpcs>>;

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
>(
  actor: EntityActorObject<Name, Defs, Rpcs>,
  build: ActorHandlers<Defs> | Effect.Effect<ActorHandlers<Defs>, never, RX>,
  options?: HandlerOptions,
  /* eslint-disable typescript-eslint/no-explicit-any -- handler services are open */
): Layer.Layer<ActorClientService<Name, Defs>, never, any>;

// Workflow overload
function toLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Signals extends SignalDefs,
>(
  actor: WorkflowActorObject<Name, Payload, Success, Error, Signals>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    step: WorkflowStepContext<Error>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>, any>,
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
  actor: EntityActorObject<Name, Defs, Rpcs>,
  build: ActorHandlers<Defs> | Effect.Effect<ActorHandlers<Defs>, never, RX>,
  options?: HandlerOptions,
): Layer.Layer<ActorClientService<Name, Defs>>;

// Workflow overload
function toTestLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Signals extends SignalDefs,
>(
  actor: WorkflowActorObject<Name, Payload, Success, Error, Signals>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    step: WorkflowStepContext<Error>,
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- handler requirements are open
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
  "actor",
  "name",
  "type",
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
    Defs[K] extends { success: infer S extends Schema.Top } ? S : typeof Schema.Void,
    Defs[K] extends { error: infer E extends Schema.Top } ? E : typeof Schema.Never
  >;
};

// ── Workflow Definition ────────────────────────────────────────────────────

export interface WorkflowDef<
  Payload extends Schema.Struct.Fields = Schema.Struct.Fields,
  Success extends Schema.Top = typeof Schema.Void,
  Error extends Schema.Top = typeof Schema.Never,
  Signals extends SignalDefs = {},
> {
  readonly payload: Payload;
  readonly success?: Success;
  readonly error?: Error;
  readonly idempotencyKey: (payload: {
    readonly [K in keyof Payload]: Schema.Schema.Type<
      Payload[K] extends Schema.Top ? Payload[K] : never
    >;
  }) => string;
  readonly signals?: Signals;
  // eslint-disable-next-line typescript-eslint/no-explicit-any
  readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown>;
  readonly captureDefects?: boolean;
  readonly suspendOnFailure?: boolean;
}

// ── Workflow typed defs ───────────────────────────────────────────────────

type WorkflowPayloadType<Payload extends Schema.Struct.Fields> = {
  readonly [K in keyof Payload]: Schema.Schema.Type<
    Payload[K] extends Schema.Top ? Payload[K] : never
  >;
};

type WorkflowRunDefs<
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
> = {
  readonly Run: {
    readonly payload: Schema.Struct<Payload>;
    readonly success: Success;
    readonly error: Error;
    readonly primaryKey: (payload: never) => string;
  };
};

// ── WorkflowActorObject ───────────────────────────────────────────────────

export type WorkflowActorObject<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Signals extends SignalDefs = {},
> = SignalConstructors<Schema.Struct<Payload>, Signals> & {
  readonly _tag: "WorkflowActorObject";
  readonly name: Name;
  readonly type: `Workflow/${Name}`;
  readonly _meta: {
    readonly name: Name;
    readonly workflow: UpstreamWorkflow.Workflow<Name, Schema.Struct<Payload>, Success, Error>;
  };
  readonly Context: Context.Service<
    ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>,
    ActorClientFactory<Name, WorkflowRunDefs<Payload, Success, Error>>
  >;
  readonly Run: (
    payload: WorkflowPayloadType<Payload>,
  ) => { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
    OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;
  readonly actor: () => Effect.Effect<
    ActorRef<Name, WorkflowRunDefs<Payload, Success, Error>>,
    never,
    ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>
  >;
  readonly peek: <S, E>(
    execId: ExecId<S, E>,
  ) => Effect.Effect<PeekResult<S, E>, never, WorkflowEngine>;
  readonly watch: <S, E>(
    execId: ExecId<S, E>,
    options?: { readonly interval?: Duration.Input },
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
  Success extends Schema.Top = typeof Schema.Void,
  Error extends Schema.Top = typeof Schema.Never,
  const Signals extends SignalDefs = {},
>(
  name: Name,
  def: WorkflowDef<Payload, Success, Error, Signals>,
): WorkflowActorObject<Name, Payload, Success, Error, Signals> => {
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

  const contextTag = Context.Service<
    ActorClientService<Name, WfDefs>,
    ActorClientFactory<Name, WfDefs>
  >(`effect-encore/${name}/Client`);

  const Run = (payload: WorkflowPayloadType<Payload>) =>
    ({ _tag: "Run", ...payload }) as { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
      OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;

  const actorFn = () =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      return yield* factory("");
    });

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
      wf.poll(execId) as Effect.Effect<Option.Option<unknown>, never, WorkflowEngine>,
      (optResult): PeekResult<S, E> => {
        if (Option.isNone(optResult)) return Pending as PeekResult<S, E>;
        const result = optResult.value as {
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
    options?: { readonly interval?: Duration.Input },
  ) => {
    const interval = options?.interval ?? Duration.millis(200);
    return Stream.fromEffectSchedule(peekFn(execId), Schedule.spaced(interval)).pipe(
      Stream.changesWith(peekResultEquals as (a: PeekResult<S, E>, b: PeekResult<S, E>) => boolean),
      Stream.takeUntil(isTerminal as (r: PeekResult<S, E>) => boolean),
    ) as Stream.Stream<PeekResult<S, E>, never, WorkflowEngine>;
  };

  const interruptFn = (executionId: string) => wf.interrupt(executionId);

  const resumeFn = (executionId: string) => wf.resume(executionId);

  const executionIdFn = (payload: WorkflowPayloadType<Payload>) =>
    Effect.map(wf.executionId(payload as never), (id) => makeExecId(id));

  const $is =
    (tag: string) =>
    (value: unknown): boolean =>
      value != null &&
      typeof value === "object" &&
      "_tag" in value &&
      (value as Record<string, unknown>)["_tag"] === tag;

  return {
    ...signals,
    _tag: "WorkflowActorObject" as const,
    name,
    type: `Workflow/${name}` as const,
    _meta: { name, workflow: wf },
    Context: contextTag,
    Run,
    actor: actorFn,
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
    interrupt: interruptFn,
    resume: resumeFn,
    executionId: executionIdFn,
    $is,
  } as WorkflowActorObject<Name, Payload, Success, Error, Signals>;
};

// ── Workflow-aware toLayer/toTestLayer ─────────────────────────────────────

const isWorkflowActor = (
  actor: unknown,
): actor is WorkflowActorObject<string, Schema.Struct.Fields, Schema.Top, Schema.Top> =>
  actor != null &&
  typeof actor === "object" &&
  "_tag" in actor &&
  (actor as Record<string, unknown>)["_tag"] === "WorkflowActorObject";

/* eslint-disable typescript-eslint/no-explicit-any -- workflow toLayer needs dynamic dispatch */
const wrapWorkflowHandler = (actor: WorkflowActorObject<any, any, any, any>, handler: Function) => {
  const wf = actor._meta.workflow;
  return (payload: any, executionId: string) => {
    const step = makeStepContext(wf, executionId);
    return handler(payload, step);
  };
};

const workflowToLayer = (
  actor: WorkflowActorObject<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const wf = actor._meta.workflow;
  const handlerLayer = wf.toLayer(wrapWorkflowHandler(actor, handler) as any);

  const clientLayer = Layer.effect(
    actor.Context,
    Effect.succeed((entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, entityId))),
  );

  return layerPassthrough(Layer.merge(handlerLayer, clientLayer));
};

const workflowToTestLayer = (
  actor: WorkflowActorObject<any, any, any, any>,
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
  actor: WorkflowActorObject<any, any, any, any>,
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
    actor: EntityActorObject<Name, Defs, Rpcs>,
  ) => EntityActorObject<Name, Defs, Rpcs>;
  <RpcsIn extends Rpc.Any, RpcsOut extends Rpc.Any>(
    transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
  ): <Name extends string, Defs extends OperationDefs>(
    actor: EntityActorObject<Name, Defs, RpcsIn>,
  ) => EntityActorObject<Name, Defs, RpcsOut>;
};

type WithProtocolDataFirst = <
  Name extends string,
  Defs extends OperationDefs,
  RpcsIn extends Rpc.Any,
  RpcsOut extends Rpc.Any,
>(
  actor: EntityActorObject<Name, Defs, RpcsIn>,
  transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
) => EntityActorObject<Name, Defs, RpcsOut>;

type WithProtocol = WithProtocolDataLast & WithProtocolDataFirst;

const withProtocolImpl = <
  Name extends string,
  Defs extends OperationDefs,
  RpcsIn extends Rpc.Any,
  RpcsOut extends Rpc.Any,
>(
  actor: EntityActorObject<Name, Defs, RpcsIn>,
  transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
): EntityActorObject<Name, Defs, RpcsOut> => {
  const newEntity = Entity.fromRpcGroup(actor._meta.name, transform(actor._meta.entity.protocol));
  return Object.assign(Object.create(Pipeable.Prototype), actor, {
    _meta: { ...actor._meta, entity: newEntity },
  }) as EntityActorObject<Name, Defs, RpcsOut>;
};

export const withProtocol: WithProtocol = dual(2, withProtocolImpl);

// ── Type Guards ────────────────────────────────────────────────────────────

// eslint-disable-next-line typescript-eslint/no-explicit-any
type AnyEntityActor = EntityActorObject<any, any, any>;
// eslint-disable-next-line typescript-eslint/no-explicit-any
type AnyWorkflowActor = WorkflowActorObject<any, any, any, any, any>;
type AnyActor = AnyEntityActor | AnyWorkflowActor;

const isEntity = (actor: AnyActor): actor is AnyEntityActor => actor._tag === "EntityActorObject";

const isWorkflow = (actor: AnyActor): actor is AnyWorkflowActor =>
  actor._tag === "WorkflowActorObject";

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
