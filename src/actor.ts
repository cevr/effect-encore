import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import {
  ClusterSchema,
  Entity,
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
import type { MalformedMessage, PersistenceError } from "effect/unstable/cluster/ClusterError";
import type { Rpc, RpcClient, RpcGroup, RpcMessage } from "effect/unstable/rpc";
import { Rpc as RpcMod } from "effect/unstable/rpc";
import { Workflow as UpstreamWorkflow } from "effect/unstable/workflow";
import type { Execution } from "effect/unstable/workflow/Workflow";
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
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
import { EncoreMessageStorage } from "./storage.js";
import type { EncoreMessageStorageShape } from "./storage.js";

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

// ── id-fn resolver ─────────────────────────────────────────────────────────
// Internal helper: invoke `def.id(payload)` and normalize the result to a
// `{entityId, primaryKey}` pair. String returns map entityId === primaryKey;
// object returns may diverge, with primaryKey defaulting to entityId.
const resolveId = (
  def: OperationDef | undefined,
  payload: unknown,
  fallbackTag: string,
): { readonly entityId: string; readonly primaryKey: string } => {
  const idFn = def?.["id"] as ((p: unknown) => EntityIdReturn) | undefined;
  if (!idFn) {
    return { entityId: fallbackTag, primaryKey: fallbackTag };
  }
  const result = idFn(payload as never);
  if (typeof result === "string") {
    return { entityId: result, primaryKey: result };
  }
  return { entityId: result.entityId, primaryKey: result.primaryKey ?? result.entityId };
};

// ── Operation DSL ──────────────────────────────────────────────────────────

/**
 * Result of an entity operation's `id` fn. Either:
 * - `string` — entityId AND primaryKey use this value (the common case).
 * - `{entityId, primaryKey?}` — divergent case where the dedup key differs
 *   from the mailbox address (e.g., PagerDuty: dedup_key for routing, but
 *   `${dedup_key}:${event_action}` for dedup so distinct event actions on
 *   the same key get distinct execIds). primaryKey defaults to entityId
 *   when omitted.
 */
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

// ── Reserved key guard ─────────────────────────────────────────────────────

type ReservedKeys =
  | "_tag"
  | "_meta"
  | "$is"
  | "Context"
  | "name"
  | "type"
  | "of"
  | "interrupt"
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
  "name",
  "type",
  "of",
  "interrupt",
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

// ── OperationHandle — per-op payload-only dispatch surface ─────────────────

/**
 * `PayloadInput<C>` is the user-facing payload type for an operation. For
 * struct fields, it's the readonly struct; for opaque/scalar payload, it's
 * the raw scalar; for empty payload, it's `void`.
 */
export type PayloadInput<C extends OperationDef> = C extends {
  readonly payload: infer F extends Schema.Struct.Fields;
}
  ? {
      readonly [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never>;
    }
  : C extends { readonly payload: infer P extends FieldfulSchema }
    ? Schema.Schema.Type<P>
    : C extends { readonly payload: infer P extends Schema.Top }
      ? Schema.Schema.Type<P>
      : void;

/**
 * Per-operation handle. The dispatch surface for a single tag — replaces the
 * old `Actor.ref(id)` + `Actor.Op({...})` value-construction pattern with a
 * payload-only API. The `id` fn on the OperationDef is invoked internally to
 * derive `{entityId, primaryKey}` for routing and dedup.
 */
export interface OperationHandle<
  Name extends string,
  Tag extends string,
  C extends OperationDef,
  Defs extends OperationDefs = OperationDefs,
> {
  readonly _tag: "OperationHandle";
  readonly name: Tag;
  readonly execute: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<
    Schema.Schema.Type<SuccessOf<C>>,
    Schema.Schema.Type<ErrorOf<C>>,
    ActorClientService<Name, Defs>
  >;
  readonly send: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<
    ExecId<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    never,
    ActorClientService<Name, Defs>
  >;
  readonly executionId: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<ExecId<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>>;
  readonly peek: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | Sharding.Sharding
  >;
  readonly watch: (
    payload: PayloadInput<C>,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | Sharding.Sharding
  >;
  readonly waitFor: (
    payload: PayloadInput<C>,
    options?: {
      readonly filter?: (
        result: PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
      ) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => Effect.Effect<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | Sharding.Sharding
  >;
  readonly rerun: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<void, PersistenceError, EncoreMessageStorageShape | Sharding.Sharding>;
  readonly make: (payload: PayloadInput<C>) => OperationValue<Name, Tag, C>;
}

// ── EntityActor — the unified return type ──────────────────────────────────

type ActorOperationHandles<Name extends string, Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: OperationHandle<Name, Tag, Defs[Tag], Defs>;
};

export type EntityActor<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> = ActorOperationHandles<Name, Defs> &
  Pipeable.Pipeable & {
    readonly _tag: "EntityActor";
    readonly name: Name;
    readonly type: Name;
    readonly _meta: ActorMeta<Name, Defs, Rpcs>;
    readonly Context: Context.Service<
      ActorClientService<Name, Defs>,
      ActorClientFactory<Name, Defs>
    >;
    /**
     * Stop accepting more work for this entity — clears the pending mailbox.
     * Distinct intent from `flush` ("clean slate"): use `interrupt` when you
     * want the entity to stop processing new messages but want to preserve
     * the conceptual "I asked the actor to stop" semantics.
     *
     * Programmatic in-flight fiber cancellation requires `Sharding.passivate`,
     * which is not yet a public API in effect-cluster. In practice, in-flight
     * handlers run to completion; only queued/pending work is cleared.
     */
    readonly interrupt: (
      entityId: string,
    ) => Effect.Effect<void, PersistenceError, MessageStorage.MessageStorage | Sharding.Sharding>;
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
  const daFn = def["deliverAt"];

  // PrimaryKey.symbol returns the dedup key cluster uses for message dedup.
  // That's the `primaryKey` portion of resolveId — for string-form `id`,
  // primaryKey === entityId; for object-form, divergent. `id` is required
  // on every OperationDef.
  const pkOf = (p: unknown) => resolveId(def, p, tag).primaryKey;

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

      proto[PrimaryKey.symbol] = function (this: unknown) {
        return pkOf(this);
      };

      if (daFn) {
        proto[DeliverAt.symbol] = function (this: unknown) {
          return (daFn as Function)(this) as DateTime.DateTime;
        };
      }

      options["payload"] = PayloadClass;
    }
  } else {
    // Zero-payload operations still need PrimaryKey.symbol for storage indexing
    const Base = Schema.Class<Record<string, unknown>>(`effect-encore/${actorName}/${tag}/Payload`)(
      {},
    );

    class EmptyPayloadClass extends Base {}

    (EmptyPayloadClass.prototype as Record<string | symbol, unknown>)[PrimaryKey.symbol] =
      function () {
        return pkOf(undefined);
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

// ── rerun — surgical per-execId clear via deleteEnvelope ─────────────────

const rerunImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  def: OperationDef | undefined,
  tag: string,
  payload: unknown,
): Effect.Effect<void, PersistenceError, EncoreMessageStorageShape | Sharding.Sharding> =>
  Effect.gen(function* () {
    const { entityId, primaryKey } = resolveId(def, payload, tag);
    const storage = yield* EncoreMessageStorage;
    const address = yield* resolveAddress(entity, entityId);
    const maybeRequestId = yield* storage.requestIdForPrimaryKey({
      address,
      tag,
      id: primaryKey,
    });
    if (Option.isNone(maybeRequestId)) return;
    yield* storage.deleteEnvelope(maybeRequestId.value);
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

  // Build the raw OperationValue for a given tag/payload — used by `make`
  // escape hatch and internally by execute/send to feed buildActorRef.
  const buildOpValue = (tag: string, payload: unknown) => {
    const def = definitions[tag] as OperationDef | undefined;
    const opaque = def?.payload !== undefined && isOpaquePayload(def.payload);
    return opaque
      ? { _tag: tag, _payload: payload }
      : { _tag: tag, ...(payload != null && typeof payload === "object" ? payload : {}) };
  };

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

  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity<Name> → Entity<string> widening
  const entityAny = entity as unknown as ClusterEntity.Entity<string, any>;

  const flushFn = (actorId: string) => flushImpl(entityAny, actorId);
  const redeliverFn = (actorId: string) => redeliverImpl(entityAny, actorId);

  // interrupt — rewired from Effect.die to clearAddress. Distinct intent from
  // flush ("stop accepting more work" vs "clean slate"). Programmatic
  // in-flight cancellation requires Sharding.passivate (not yet public).
  const interruptFn = (entityId: string) => flushImpl(entityAny, entityId);

  const ofFn = <T>(handlers: T): T => handlers;

  // Build per-op handles. Each handle derives entityId/primaryKey from
  // payload via resolveId, and composes execute/send/peek/watch/waitFor/
  // executionId/rerun/make on top of the existing impls.
  const handles: Record<string, OperationHandle<Name, string, OperationDef>> = {};
  for (const tag of Object.keys(definitions)) {
    const def = definitions[tag] as OperationDef;
    handles[tag] = makeOperationHandle<Name, string, OperationDef>({
      name,
      tag,
      def,
      definitions,
      contextTag: contextTag as unknown as Context.Service<
        ActorClientService<Name, OperationDefs>,
        ActorClientFactory<Name, OperationDefs>
      >,
      entityAny,
      buildOpValue,
    });
  }

  const actor = Object.assign(Object.create(Pipeable.Prototype), {
    _tag: "EntityActor" as const,
    name,
    type: name,
    _meta: { name, definitions, entity },
    Context: contextTag,
    of: ofFn,
    interrupt: interruptFn,
    flush: flushFn,
    redeliver: redeliverFn,
    $is,
    ...handles,
  });

  return actor as EntityActor<Name, Defs>;
};

// ── makeOperationHandle — build a single OperationHandle ─────────────────

const makeOperationHandle = <
  Name extends string,
  Tag extends string,
  C extends OperationDef,
>(args: {
  readonly name: Name;
  readonly tag: Tag;
  readonly def: C;
  readonly definitions: OperationDefs;
  readonly contextTag: Context.Service<
    ActorClientService<Name, OperationDefs>,
    ActorClientFactory<Name, OperationDefs>
  >;
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity erased
  readonly entityAny: ClusterEntity.Entity<string, any>;
  readonly buildOpValue: (tag: string, payload: unknown) => Record<string, unknown>;
}): OperationHandle<Name, Tag, C> => {
  const { name, tag, def, definitions, contextTag, entityAny, buildOpValue } = args;

  const idOf = (payload: unknown): { readonly entityId: string; readonly primaryKey: string } =>
    resolveId(def, payload, tag);

  const execId = (payload: unknown) => {
    const { entityId, primaryKey } = idOf(payload);
    return makeExecId(`${entityId}\x00${tag}\x00${primaryKey}`);
  };

  // eslint-disable-next-line typescript-eslint/no-explicit-any -- handle types erased
  const handle: OperationHandle<Name, Tag, C> = {
    _tag: "OperationHandle" as const,
    name: tag,
    execute: ((payload: unknown) =>
      Effect.gen(function* () {
        const factory = yield* contextTag;
        const { entityId } = idOf(payload);
        const ref = yield* factory(entityId);
        return yield* ref.execute(buildOpValue(tag, payload) as never);
      })) as never,
    send: ((payload: unknown) =>
      Effect.gen(function* () {
        const factory = yield* contextTag;
        const { entityId } = idOf(payload);
        const ref = yield* factory(entityId);
        return yield* ref.send(buildOpValue(tag, payload) as never);
      })) as never,
    executionId: ((payload: unknown) => Effect.succeed(execId(payload))) as never,
    peek: ((payload: unknown) =>
      peekImpl(entityAny, execId(payload), definitions) as never) as never,
    watch: ((payload: unknown, options?: { readonly interval?: Duration.Input }) =>
      watchImpl(entityAny, execId(payload), definitions, options) as never) as never,
    waitFor: ((
      payload: unknown,
      options?: {
        readonly filter?: (result: PeekResult) => boolean;
        // eslint-disable-next-line typescript-eslint/no-explicit-any
        readonly schedule?: Schedule.Schedule<any, unknown>;
      },
    ) =>
      makeWaitFor(
        (eid) => peekImpl(entityAny, eid as string, definitions),
        execId(payload),
        options as never,
      )) as never,
    rerun: ((payload: unknown) => rerunImpl(entityAny, def, tag, payload)) as never,
    make: ((payload: unknown) => buildOpValue(tag, payload) as never) as never,
  };

  // Reference name to avoid unused warnings in some flows
  void name;
  return handle;
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
//
// Mirrors upstream `Workflow.toLayer`: excludes `WorkflowEngine | WorkflowInstance |
// Execution<Name> | Scope.Scope` from the handler's `R`, so callers don't see
// internal context tags injected by `step.run` leak into the layer's
// requirements. Without these excludes, a handler that calls `step.run(...)`
// causes the resulting Layer's `RIn` to include `WorkflowInstance`, which is
// unsatisfiable from user code.
function toLayer<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
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
  Exclude<RX, WorkflowEngine | WorkflowInstance | Execution<Name> | Scope.Scope> | WorkflowEngine
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
  Success extends Schema.Top,
  Error extends Schema.Top,
  Signals extends SignalDefs,
  RX = never,
>(
  actor: WorkflowActor<Name, Payload, Success, Error, Signals>,
  handler: (
    payload: WorkflowPayloadType<Payload>,
    step: WorkflowStepContext<Error>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>, RX>,
): Layer.Layer<
  ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>> | WorkflowEngine,
  never,
  Exclude<RX, WorkflowEngine | WorkflowInstance | Execution<Name> | Scope.Scope>
>;

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
      const pkInput = def?.payload && isOpaquePayload(def.payload) ? op["_payload"] : op;
      const { primaryKey } = resolveId(def, pkInput, tag);
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
  "name",
  "type",
  "of",
  "execute",
  "send",
  "peek",
  "watch",
  "waitFor",
  "rerun",
  "make",
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
  /**
   * Workflow `id` fn returns string only — workflows have no entity dimension,
   * so the divergent `{entityId, primaryKey}` form is rejected at the type
   * level. The string is used as the workflow's idempotency / execution key.
   */
  readonly id: (payload: {
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
    readonly id: (payload: never) => EntityIdReturn;
  };
};

// ── WorkflowActor ───────────────────────────────────────────────────

export type WorkflowActor<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Signals extends SignalDefs = {},
> = SignalConstructors<Schema.Struct<Payload>, Signals> & {
  readonly _tag: "WorkflowActor";
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
  /**
   * Run the workflow for the given payload, awaiting its terminal result.
   * Idempotent on `payload` — same payload yields same execution.
   */
  readonly execute: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<
    Schema.Schema.Type<Success>,
    Schema.Schema.Type<Error>,
    ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>
  >;
  /**
   * Fire-and-forget: enqueues the workflow run and returns its `ExecId`.
   */
  readonly send: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<
    ExecId<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
    never,
    ActorClientService<Name, WorkflowRunDefs<Payload, Success, Error>>
  >;
  /**
   * Pure derivation: compute the `ExecId` for a payload without enqueuing.
   */
  readonly executionId: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<ExecId<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>>;
  readonly peek: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<
    PeekResult<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
    never,
    WorkflowEngine
  >;
  readonly watch: (
    payload: WorkflowPayloadType<Payload>,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<
    PeekResult<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
    never,
    WorkflowEngine
  >;
  readonly waitFor: (
    payload: WorkflowPayloadType<Payload>,
    options?: {
      readonly filter?: (
        result: PeekResult<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
      ) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => Effect.Effect<
    PeekResult<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
    never,
    WorkflowEngine
  >;
  /**
   * Surgically clear this execution's cached run reply + activity replies so
   * the next `.execute(samePayload)` runs from scratch.
   *
   * Composes `WorkflowEngine.interrupt` (signals the running fiber, no-op if
   * completed) with `EncoreMessageStorage.clearAddress` (wipes run reply +
   * cached activity replies stored at the workflow's `EntityAddress`).
   *
   * Caveat: rerun-while-running interrupts the fiber and clears state, but
   * cleanup is best-effort eventual — the next `.execute(samePayload)` may
   * queue behind the interrupted fiber's wind-down. No data corruption, just
   * transient ordering.
   */
  readonly rerun: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<
    void,
    PersistenceError,
    EncoreMessageStorageShape | Sharding.Sharding | WorkflowEngine
  >;
  readonly interrupt: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  /**
   * Escape hatch: produce the underlying `OperationValue<"Run", ...>` for the
   * payload. Useful for external code that needs to round-trip the value
   * (e.g., admin UIs replaying a captured payload).
   */
  readonly make: (
    payload: WorkflowPayloadType<Payload>,
  ) => { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
    OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;
  readonly $is: (tag: "Run") => (value: unknown) => boolean;
};

// ── Workflow address resolver ─────────────────────────────────────────────
// Workflows live at EntityAddress(entityType=`Workflow/${name}`, entityId=executionId,
// shardId=getShardId(entityId, shardGroup)). Mirror of ClusterWorkflowEngine's
// `entityAddressFor` (`ClusterWorkflowEngine.js:84-92`). Activity replies and
// the run reply both persist at this address — clearing it wipes everything.
/* eslint-disable typescript-eslint/no-explicit-any -- workflow type erased */
const resolveWorkflowAddress = (
  workflow: UpstreamWorkflow.Workflow<any, any, any, any>,
  executionId: string,
) =>
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    const entityId = EntityId.make(executionId);
    const shardGroupFn = Context.get(workflow.annotations, ClusterSchema.ShardGroup);
    const shardGroup = shardGroupFn(entityId);
    return EntityAddress.make({
      entityType: EntityType.make(`Workflow/${workflow.name}`),
      entityId,
      shardId: sharding.getShardId(entityId, shardGroup),
    });
  });

// DurableClock sub-entity address. Mirrors upstream `clearClock` in
// `ClusterWorkflowEngine.js:124-134`: clock entityType is the constant
// `Workflow/-/DurableClock`, entityId is the parent workflow's executionId,
// shardId uses the parent workflow's shardGroup annotation. Required for
// `step.sleep` cleanup on rerun — without this, orphan clock entries remain
// in storage and fire later into a workflow that no longer expects them.
const resolveWorkflowClockAddress = (
  workflow: UpstreamWorkflow.Workflow<any, any, any, any>,
  executionId: string,
) =>
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    const entityId = EntityId.make(executionId);
    const shardGroupFn = Context.get(workflow.annotations, ClusterSchema.ShardGroup);
    const shardGroup = shardGroupFn(entityId);
    return EntityAddress.make({
      entityType: EntityType.make("Workflow/-/DurableClock"),
      entityId,
      shardId: sharding.getShardId(entityId, shardGroup),
    });
  });
/* eslint-enable typescript-eslint/no-explicit-any */

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
): WorkflowActor<Name, Payload, Success, Error, Signals> => {
  const workflowOptions: Record<string, unknown> = {
    name,
    payload: def.payload,
    // upstream UpstreamWorkflow takes `idempotencyKey`; encore exposes `id`.
    idempotencyKey: def.id,
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

  const make = (payload: WorkflowPayloadType<Payload>) =>
    ({ _tag: "Run", ...payload }) as { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
      OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;

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

  // Compute the workflow's actual executionId for a payload. Upstream derives
  // execId as `hash(name-idempotencyKey(payload))` (Workflow.js makeExecutionId);
  // peek/rerun MUST use that same id or they'll look at the wrong slot.
  const execIdFor = (payload: WorkflowPayloadType<Payload>): Effect.Effect<string> =>
    wf.executionId(payload as never);

  type RawPeek = PeekResult<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;

  const peekById = (executionId: string): Effect.Effect<RawPeek, never, WorkflowEngine> =>
    Effect.map(
      wf.poll(executionId) as Effect.Effect<Option.Option<unknown>, never, WorkflowEngine>,
      (optResult): RawPeek => {
        if (Option.isNone(optResult)) return Pending as RawPeek;
        const result = optResult.value as {
          _tag: string;
          exit?: Exit.Exit<unknown, unknown>;
        };
        if (result._tag === "Suspended") return Suspended as RawPeek;
        if (result._tag === "Complete" && result.exit) {
          return mapExitToWorkflowPeekResult(result.exit) as RawPeek;
        }
        return Pending as RawPeek;
      },
    );

  const peekFn = (payload: WorkflowPayloadType<Payload>) =>
    Effect.flatMap(execIdFor(payload), peekById);

  const watchFn = (
    payload: WorkflowPayloadType<Payload>,
    options?: { readonly interval?: Duration.Input },
  ): Stream.Stream<RawPeek, never, WorkflowEngine> => {
    const interval = options?.interval ?? Duration.millis(200);
    return Stream.unwrap(
      Effect.map(execIdFor(payload), (executionId) =>
        Stream.fromEffectSchedule(peekById(executionId), Schedule.spaced(interval)).pipe(
          Stream.changesWith(peekResultEquals as (a: RawPeek, b: RawPeek) => boolean),
          Stream.takeUntil(isTerminal as (r: RawPeek) => boolean),
        ),
      ),
    );
  };

  const waitForFn = (
    payload: WorkflowPayloadType<Payload>,
    options?: {
      readonly filter?: (result: RawPeek) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ): Effect.Effect<RawPeek, never, WorkflowEngine> =>
    Effect.flatMap(
      execIdFor(payload),
      (executionId) =>
        makeWaitFor(
          (eid) => peekById(eid as unknown as string),
          makeExecId(executionId) as ExecId<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
          options as never,
        ) as Effect.Effect<RawPeek, never, WorkflowEngine>,
    );

  const interruptFn = (executionId: string) => wf.interrupt(executionId);

  const resumeFn = (executionId: string) => wf.resume(executionId);

  const executionIdFn = (payload: WorkflowPayloadType<Payload>) =>
    Effect.map(wf.executionId(payload as never), (id) => makeExecId(id));

  // rerun(payload): WorkflowEngine.interrupt + clearAddress on the workflow's
  // EntityAddress AND on the DurableClock sub-entity. Wipes the run reply,
  // every cached activity reply (they all live at the workflow address —
  // confirmed in MessageStorage.d.ts:401 and ClusterWorkflowEngine.js where
  // activities use `requestIdForPrimaryKey` against the workflow's entity
  // address), and any pending step.sleep clock entries (mirror of upstream
  // `clearClock` in ClusterWorkflowEngine.js:124-134 — upstream only clears
  // the clock when a running fiber observes the InterruptSignal, which
  // doesn't happen if the workflow is suspended waiting on the clock). Required
  // so a workflow using step.sleep can be safely rerun without orphan clock
  // fires. interrupt() is a fiber signal and is a no-op if the workflow has
  // already completed (per ClusterWorkflowEngine.js:172-200); clearAddress()
  // then wipes persisted state regardless. Caveat: rerun-while-running
  // interrupts the fiber and clears state, but the fiber's wind-down may
  // queue behind the next execute; cleanup is best-effort eventual.
  const rerunFn = (
    payload: WorkflowPayloadType<Payload>,
  ): Effect.Effect<
    void,
    PersistenceError,
    EncoreMessageStorageShape | Sharding.Sharding | WorkflowEngine
  > =>
    Effect.gen(function* () {
      const executionId = yield* execIdFor(payload);
      yield* wf.interrupt(executionId);
      const storage = yield* EncoreMessageStorage;
      const address = yield* resolveWorkflowAddress(wf, executionId);
      yield* storage.clearAddress(address);
      const clockAddress = yield* resolveWorkflowClockAddress(wf, executionId);
      yield* storage.clearAddress(clockAddress);
    });

  const executeFn = (payload: WorkflowPayloadType<Payload>) =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      const executionId = yield* execIdFor(payload);
      const ref = yield* factory(executionId);
      return yield* ref.execute(make(payload) as never);
    }) as unknown as Effect.Effect<
      Schema.Schema.Type<Success>,
      Schema.Schema.Type<Error>,
      ActorClientService<Name, WfDefs>
    >;

  const sendFn = (payload: WorkflowPayloadType<Payload>) =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      const executionId = yield* execIdFor(payload);
      const ref = yield* factory(executionId);
      return yield* ref.send(make(payload) as never);
    }) as unknown as Effect.Effect<
      ExecId<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
      never,
      ActorClientService<Name, WfDefs>
    >;

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
    execute: executeFn,
    send: sendFn,
    executionId: executionIdFn,
    peek: peekFn,
    watch: watchFn,
    waitFor: waitForFn,
    rerun: rerunFn,
    interrupt: interruptFn,
    resume: resumeFn,
    make,
    $is,
  } as unknown as WorkflowActor<Name, Payload, Success, Error, Signals>;
};

// ── Workflow-aware toLayer/toTestLayer ─────────────────────────────────────

const isWorkflowActor = (
  actor: unknown,
): actor is WorkflowActor<string, Schema.Struct.Fields, Schema.Top, Schema.Top> =>
  actor != null &&
  typeof actor === "object" &&
  "_tag" in actor &&
  (actor as Record<string, unknown>)["_tag"] === "WorkflowActor";

/* eslint-disable typescript-eslint/no-explicit-any -- workflow toLayer needs dynamic dispatch */
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
