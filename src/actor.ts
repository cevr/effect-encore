import {
  ClusterSchema,
  type Entity as ClusterEntity,
  Entity,
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
  type ShardingConfig,
  Snowflake,
} from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
import { CurrentAddress, type CurrentRunnerAddress } from "effect/unstable/cluster/Entity";
import type {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  MalformedMessage,
  PersistenceError,
} from "effect/unstable/cluster/ClusterError";
import type { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc";
import { Rpc as RpcMod } from "effect/unstable/rpc";
import { Workflow as UpstreamWorkflow } from "effect/unstable/workflow";
import { ActorAddressResolver, ActorAddressResolverLayer } from "./actor-address-resolver.js";
import { assembleActorRuntime, attachFreshService } from "./actor-runtime.js";
import { ActorDefect } from "./actor-defect.js";
import type { MailboxError, ActorMailboxShape } from "./actor-mailbox.js";
import { ActorMailbox, ActorMailboxLayer } from "./actor-mailbox.js";
import type { Execution } from "effect/unstable/workflow/Workflow";
import {
  WorkflowEngine,
  type WorkflowInstance,
  layerMemory as workflowEngineLayerMemory,
} from "effect/unstable/workflow/WorkflowEngine";
import {
  Context,
  Cause,
  Data,
  Duration,
  Effect,
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
import type {
  CompensationDecision,
  CompensationNotPendingError,
  PendingCompensation,
  SignalDefs,
  WorkflowSignal,
  WorkflowStepContext,
} from "./step.js";
import {
  decideCompensation,
  makeSignal,
  makeWorkflowExecution,
  pendingCompensation,
} from "./step.js";
import type { ExecId, PeekResult } from "./receipt.js";
import {
  ExecIdCodec,
  Pending,
  Suspended,
  isTerminal,
  makeExecId,
  mapExitToWorkflowPeekResult,
  peekStoredReply,
} from "./receipt.js";
import { MessageDeletion } from "./storage.js";
import {
  Client,
  clientServiceLayer,
  makeTestMailboxImpl,
  resolveEntityAddress,
  layer as ClientLayer,
} from "./client.js";
import type { EntityIdReturn, OperationDef, OperationDefs } from "./operation.js";
import {
  compileInvocation,
  isOpaquePayload,
  makeOperationValue,
  payloadFromOperation,
  resolveId,
} from "./operation.js";
import {
  ActorStateRegistry,
  listStateEntityIds,
  registerState,
  stateOf,
  watchStateOf,
} from "./actor-state.js";
import type { ActorStateUnavailable } from "./actor-state.js";
import * as State from "./state.js";
import { entityIdCodec } from "./entity-id-codec.js";

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Raised by `Op.sendAndAwait` when the entity's reply does not become terminal
 * within the required `timeout`. Carries the `entityType` + `execId` of the
 * awaited operation and the normalized `timeout` that elapsed.
 */
export class SendAndAwaitTimeout extends Data.TaggedError(
  "effect-encore/actor/SendAndAwaitTimeout",
)<{
  readonly entityType: string;
  readonly execId: string;
  readonly timeout: Duration.Duration;
}> {}

// ── Layer passthrough (v4 polyfill — v3 has Layer.passthrough) ────────────
// Adds the layer's input requirements to its output so provided services
// flow through to program code. Same as Layer.passthrough in v3.
const layerPassthrough = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut | RIn, E, RIn> =>
  Layer.merge(Layer.effectContext(Effect.context<RIn>()), layer);

// Payload classification (`isOpaquePayload`) and the id-fn resolver
// (`resolveId`) live in `client.ts` alongside the transport seam so the runtime
// dependency stays one-directional (`actor.ts` → `client.ts`). They are
// imported at the top of this file.

// ── Operation DSL ──────────────────────────────────────────────────────────

/**
 * Result of an entity operation's `id` fn. Either:
 * - `string` — entityId AND primaryKey use this value (the common case).
 * - `{entityId, primaryKey?}` — divergent case where the dedup key differs
 *   from the mailbox address (e.g., PagerDuty: dedup_key for routing, but
 *   `${dedup_key}:${event_action}` for dedup so distinct event actions on
 *   the same key get distinct execIds). primaryKey defaults to entityId
 *   when omitted.
 *
 * Defined in the internal Operation module and re-exported here.
 */
export type { EntityIdReturn, OperationDef, OperationDefs };

/**
 * Requirement bundle for hosts that send messages to actors.
 *
 * Producer-side `.send` composes into a single transport Tag — the deep
 * `Client` seam (ADR-0002) — which owns the
 * wire-envelope builder and the mailbox/resolver/snowflake strategy internally.
 * Use `Actor.SenderContext` in `R` instead of re-listing the former
 * `MessageStorage | ActorAddressResolver | Sharding` triad at every producer-op
 * signature.
 *
 * Wire ONE `Client.layer.*` adapter (`fromConfig` / `fromSharding` / `memory` /
 * `test`) at the host boundary to satisfy it.
 */
export type SenderContext = Client;

// ── Reserved key guard ─────────────────────────────────────────────────────

type ReservedKeys =
  | "_tag"
  | "_meta"
  | "$is"
  | "Context"
  | "Control"
  | "State"
  | "name"
  | "type"
  | "of"
  | "getState"
  | "watchState"
  | "waitForState"
  | "listStateEntityIds"
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
  "Control",
  "State",
  "name",
  "type",
  "of",
  "getState",
  "watchState",
  "waitForState",
  "listStateEntityIds",
  "interrupt",
  "flush",
  "redeliver",
  "pipe",
]);

const ACTIVATE_TAG = "__effectEncoreActivate";

const ActivatePayload = Schema.Struct({ entityId: Schema.String });

type ActivatePayloadType = Schema.Schema.Type<typeof ActivatePayload>;

const ActivateOperation = {
  payload: ActivatePayload,
  success: Schema.Void,
  id: (payload: ActivatePayloadType) => ({
    entityId: payload.entityId,
    primaryKey: "activate",
  }),
} satisfies OperationDef;

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

type ActorHandlers<Defs extends OperationDefs, R = never> = {
  readonly [Tag in keyof Defs & string]: (
    req: HandlerRequest<Tag, Defs[Tag]>,
  ) => Effect.Effect<
    Schema.Schema.Type<SuccessOf<Defs[Tag]>>,
    Schema.Schema.Type<ErrorOf<Defs[Tag]>>,
    R
  >;
};

export interface HandlerOptions {
  readonly spanAttributes?: Record<string, string>;
  readonly maxIdleTime?: number;
  readonly concurrency?: number | "unbounded";
  readonly mailboxCapacity?: number | "unbounded";
}

/**
 * Options for `Actor.toLayer` / `Actor.toTestLayer` that extend
 * `HandlerOptions` with a per-call scope builder.
 *
 * `withScope` runs before every handler invocation. It receives the resolved
 * `EntityAddress` for the activation and returns a `Context` that is merged
 * into the handler's runtime via `Effect.provide`. Tags declared in that
 * Context become available to handlers via `yield* Tag`.
 *
 * Use this to derive per-entity services from the entity id (e.g. parse a
 * tuple key, then build a workspace-scoped Context) without threading them
 * as handler parameters or polluting the actor's outer Layer requirements.
 */
export interface ToLayerOptions<S = never, ES = never, RS = never> extends HandlerOptions {
  readonly withScope?: (
    address: EntityAddress.EntityAddress,
  ) => Effect.Effect<Context.Context<S>, ES, RS>;
}

// ── ActorMeta — internal metadata ──────────────────────────────────────────

export interface ActorMeta<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> {
  readonly name: Name;
  readonly definitions: Defs;
  readonly internalDefinitions?: OperationDefs;
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

export interface ActorStateOptions<E = never, R = never> {
  readonly materialize?: Effect.Effect<unknown, E, R>;
}

declare const ActorStateClientServiceId: unique symbol;

export interface ActorStateClientService<Name extends string> {
  readonly [ActorStateClientServiceId]: {
    readonly name: Name;
  };
}

export interface ActorStateClient<State, Error = never> {
  readonly get: <MaterializeError = never, MaterializeRequirements = never>(
    entityId: string,
    options?: ActorStateOptions<MaterializeError, MaterializeRequirements>,
  ) => Effect.Effect<
    State,
    Error | MaterializeError | ActorStateUnavailable,
    MaterializeRequirements
  >;
  readonly watch: <MaterializeError = never, MaterializeRequirements = never>(
    entityId: string,
    options?: ActorStateOptions<MaterializeError, MaterializeRequirements>,
  ) => Stream.Stream<
    State,
    Error | MaterializeError | ActorStateUnavailable,
    MaterializeRequirements
  >;
  readonly waitFor: <MaterializeError = never, MaterializeRequirements = never>(
    entityId: string,
    predicate: (state: State) => boolean,
    options?: ActorStateOptions<MaterializeError, MaterializeRequirements>,
  ) => Effect.Effect<
    State,
    Error | MaterializeError | ActorStateUnavailable,
    MaterializeRequirements
  >;
  readonly listEntityIds: Effect.Effect<ReadonlyArray<string>>;
}

declare const ActorControlClientServiceId: unique symbol;

export interface ActorControlClientService<Name extends string> {
  readonly [ActorControlClientServiceId]: {
    readonly name: Name;
  };
}

export interface ActorControlClient {
  /**
   * Stop accepting more pending work for this actor id by clearing its mailbox.
   * In-flight handler cancellation depends on cluster passivation support.
   */
  readonly interrupt: (entityId: string) => Effect.Effect<void, PersistenceError>;
  /**
   * Clear pending persisted work for this actor id.
   */
  readonly flush: (entityId: string) => Effect.Effect<void, PersistenceError>;
  /**
   * Mark persisted pending work for this actor id as redeliverable.
   */
  readonly redeliver: (entityId: string) => Effect.Effect<void, PersistenceError>;
}

export type ActorLayerBuildContextExclusions =
  | Scope.Scope
  | CurrentAddress
  | CurrentRunnerAddress
  | ActorStateRegistry;

export const provideLayerBuildContext = <A, E, R>(
  build: Effect.Effect<A, E, R>,
): Effect.Effect<
  Effect.Effect<A, E, Extract<R, ActorLayerBuildContextExclusions>>,
  never,
  Exclude<R, ActorLayerBuildContextExclusions>
> =>
  Effect.context<Exclude<R, ActorLayerBuildContextExclusions>>().pipe(
    Effect.map(
      (ctx) =>
        Effect.provideContext(build, ctx) as Effect.Effect<
          A,
          E,
          Extract<R, ActorLayerBuildContextExclusions>
        >,
    ),
  );

/**
 * Typed state declaration for an entity. When supplied via `fromEntity`'s
 * options, `getState` / `watchState` / `waitForState` infer their return
 * State and Error channels — callers no longer pass `<State>` generics at
 * every call site.
 *
 * The `schema` is type-only — it is not used at runtime to validate the
 * registered handle's emissions. Encore relies on the handle returning the
 * declared type honestly; treat the schema as a typing contract, not a
 * boundary parse.
 */
export interface ActorStateDef {
  readonly schema?: Schema.Top;
  readonly error?: Schema.Top;
}

export type StateOf<S extends ActorStateDef | undefined> = S extends {
  readonly schema: infer Sch extends Schema.Top;
}
  ? Schema.Schema.Type<Sch>
  : unknown;

export type StateErrorOf<S extends ActorStateDef | undefined> = S extends {
  readonly error: infer E extends Schema.Top;
}
  ? Schema.Schema.Type<E>
  : never;

export interface FromEntityOptions<S extends ActorStateDef | undefined = undefined> {
  readonly state?: S;
}

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
    | MailboxError
    | PersistenceError
    | MailboxFull
    | AlreadyProcessingMessage
    | EntityNotAssignedToRunner,
    Client
  >;
  /**
   * Fire a durable `send` and then poll the persisted reply until it becomes
   * terminal, returning the applied result. Composes `send` + `peek` so a
   * sender-only host can block on an entity's outcome.
   *
   * Semantics:
   * 1. Works **without local Sharding** — usable from a `Client.layer.memory` /
   *    `Client.layer.fromConfig` sender host (the `Client` transport seam +
   *    `MessageStorage` for the `peek` loop), unlike `.execute` which requires
   *    `ActorClientService`.
   * 2. Dedup: if a prior `send` with the same `primaryKey` already has a
   *    terminal persisted reply, the mailbox dedups and `sendAndAwait` returns
   *    that persisted result immediately (matches `send`/`peek` semantics).
   * 3. Ops with a future `deliverAt` poll until delivery + processing — the
   *    `timeout` must exceed the `deliverAt` delay.
   * 4. The default poll interval is `makeWaitFor`'s 200ms `Schedule.spaced`;
   *    override via `schedule`.
   *
   * A persisted `Failure` reply surfaces in the error channel; `Defect` and
   * `Interrupted` replies die; exceeding the (required) `timeout` fails with
   * `SendAndAwaitTimeout`.
   */
  readonly sendAndAwait: (
    payload: PayloadInput<C>,
    options: {
      readonly timeout: Duration.Input; // REQUIRED — unbounded sender-side polling in a request-scoped host is a foot-gun
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => Effect.Effect<
    Schema.Schema.Type<SuccessOf<C>>,
    | Schema.Schema.Type<ErrorOf<C>>
    | MailboxError
    | PersistenceError
    | MailboxFull
    | AlreadyProcessingMessage
    | EntityNotAssignedToRunner
    | MalformedMessage
    | SendAndAwaitTimeout,
    Client | MessageStorage.MessageStorage | ActorAddressResolver
  >;
  readonly executionId: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<ExecId<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>>;
  readonly peek: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | ActorAddressResolver
  >;
  readonly watch: (
    payload: PayloadInput<C>,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    MessageStorage.MessageStorage | ActorAddressResolver
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
    MessageStorage.MessageStorage | ActorAddressResolver
  >;
  readonly rerun: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<void, PersistenceError, MessageDeletion | ActorAddressResolver>;
  readonly make: (payload: PayloadInput<C>) => OperationValue<Name, Tag, C>;
}

// ── EntityActor — the unified return type ──────────────────────────────────

type ActorOperationHandles<Name extends string, Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: OperationHandle<Name, Tag, Defs[Tag], Defs>;
};

export type EntityActor<
  Name extends string,
  Defs extends OperationDefs,
  State = unknown,
  StateError = never,
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
    readonly Control: Context.Service<ActorControlClientService<Name>, ActorControlClient>;
    readonly State: Context.Service<
      ActorStateClientService<Name>,
      ActorStateClient<State, StateError>
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
    readonly interrupt: (entityId: string) => Effect.Effect<void, PersistenceError, Client>;
    readonly flush: (actorId: string) => Effect.Effect<void, PersistenceError, Client>;
    readonly redeliver: (actorId: string) => Effect.Effect<void, PersistenceError, Client>;
    readonly of: <R>(handlers: ActorHandlers<Defs, R>) => ActorHandlers<Defs, R>;
    readonly getState: <MaterializeError = never, MaterializeRequirements = never>(
      entityId: string,
      options?: ActorStateOptions<MaterializeError, MaterializeRequirements>,
    ) => Effect.Effect<
      State,
      StateError | MaterializeError | ActorStateUnavailable,
      | ActorAddressResolver
      | ActorStateRegistry
      | ActorClientService<Name, Defs>
      | MaterializeRequirements
    >;
    readonly watchState: <MaterializeError = never, MaterializeRequirements = never>(
      entityId: string,
      options?: ActorStateOptions<MaterializeError, MaterializeRequirements>,
    ) => Stream.Stream<
      State,
      StateError | MaterializeError | ActorStateUnavailable,
      | ActorAddressResolver
      | ActorStateRegistry
      | ActorClientService<Name, Defs>
      | MaterializeRequirements
    >;
    readonly waitForState: <MaterializeError = never, MaterializeRequirements = never>(
      entityId: string,
      predicate: (state: State) => boolean,
      options?: ActorStateOptions<MaterializeError, MaterializeRequirements>,
    ) => Effect.Effect<
      State,
      StateError | MaterializeError | ActorStateUnavailable,
      | ActorAddressResolver
      | ActorStateRegistry
      | ActorClientService<Name, Defs>
      | MaterializeRequirements
    >;
    readonly listStateEntityIds: () => Effect.Effect<
      ReadonlyArray<string>,
      never,
      ActorStateRegistry
    >;
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
      const fields = payload;

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
//
// The OutgoingRequest builder (`buildOutgoingRequestForSend`), the test-mailbox
// router (`makeTestMailboxImpl`), the address helper (`resolveEntityAddress`),
// and the `flush`/`redeliver` storage ops all moved INSIDE the `Client` seam
// (`client.ts`, ADR-0002). `actor.ts` imports the ones it still needs
// directly (`resolveEntityAddress` for the state/rerun ops) and routes
// dispatch + control through the `Client` Tag.

// ── rerun — surgical per-invocation deletion ──────────────────────────────

const rerunImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  def: OperationDef | undefined,
  tag: string,
  payload: unknown,
): Effect.Effect<void, PersistenceError, MessageDeletion | ActorAddressResolver> =>
  Effect.gen(function* () {
    const { entityId, primaryKey } = resolveId(def, payload, tag);
    const deletion = yield* MessageDeletion;
    const resolver = yield* ActorAddressResolver;
    const address = resolveEntityAddress(resolver, entity, entityId);
    yield* deletion.deleteInvocation({
      address,
      tag,
      primaryKey,
    });
  });

const peekImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  execId: string,
  definitions?: OperationDefs,
): Effect.Effect<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | ActorAddressResolver
> => peekStoredReply(entity, execId, definitions);

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
  MessageStorage.MessageStorage | ActorAddressResolver
> => {
  const interval = options?.interval ?? Duration.millis(200);
  return Stream.fromEffectSchedule(
    peekImpl(entity, execId, definitions),
    Schedule.spaced(interval),
  ).pipe(Stream.changesWith(peekResultEquals), Stream.takeUntil(isTerminal));
};

const peekResultEquals = <A, E>(a: PeekResult<A, E>, b: PeekResult<A, E>): boolean => {
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
const makeWaitFor = <S, E, PE, PR>(
  peekFn: (execId: ExecId<S, E>) => Effect.Effect<PeekResult<S, E>, PE, PR>,
  execId: ExecId<S, E>,
  options?: {
    readonly filter?: (result: PeekResult<S, E>) => boolean;
    readonly schedule?: Schedule.Schedule<any, unknown>;
  },
): Effect.Effect<PeekResult<S, E>, PE, PR> => {
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

const fromEntity = <
  const Name extends string,
  const Defs extends OperationDefs,
  const StateDef extends ActorStateDef | undefined = undefined,
>(
  name: Name,
  definitions: AssertNoReservedKeys<Defs>,
  options?: FromEntityOptions<StateDef>,
): EntityActor<Name, Defs, StateOf<StateDef>, StateErrorOf<StateDef>> => {
  for (const tag of Object.keys(definitions)) {
    if (RESERVED_KEYS.has(tag)) {
      throw new ActorDefect({
        message: `effect-encore: operation "${tag}" collides with reserved property. Reserved: ${[...RESERVED_KEYS].join(", ")}`,
      });
    }
  }

  const internalDefinitions = {
    ...definitions,
    [ACTIVATE_TAG]: ActivateOperation,
  } satisfies OperationDefs;

  const rpcs = Object.entries(internalDefinitions).map(([tag, def]) => compileRpc(name, tag, def));

  const entity = Entity.make(name, rpcs as Array<DefRpcs<Defs>>);

  // Build the raw OperationValue for a given tag/payload — used by `make`
  // escape hatch and internally by execute/send to feed buildActorRef.
  const buildOpValue = (tag: string, payload: unknown) =>
    makeOperationValue(internalDefinitions[tag], tag, payload);

  class ActorClientContext extends Context.Service<
    ActorClientContext,
    ActorClientFactory<Name, Defs>
  >()(`effect-encore/${name}/Client`) {}

  const contextTag = ActorClientContext as unknown as Context.Service<
    ActorClientService<Name, Defs>,
    ActorClientFactory<Name, Defs>
  >;

  class ActorStateContext extends Context.Service<
    ActorStateContext,
    ActorStateClient<StateOf<StateDef>, StateErrorOf<StateDef>>
  >()(`effect-encore/${name}/State`) {}

  const stateTag = ActorStateContext as unknown as Context.Service<
    ActorStateClientService<Name>,
    ActorStateClient<StateOf<StateDef>, StateErrorOf<StateDef>>
  >;

  class ActorControlContext extends Context.Service<ActorControlContext, ActorControlClient>()(
    `effect-encore/${name}/Control`,
  ) {}

  const controlTag = ActorControlContext as unknown as Context.Service<
    ActorControlClientService<Name>,
    ActorControlClient
  >;

  const $is =
    (tag: string) =>
    (value: unknown): boolean =>
      value != null &&
      typeof value === "object" &&
      "_tag" in value &&
      (value as Record<string, unknown>)["_tag"] === tag;

  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity<Name> → Entity<string> widening
  const entityAny = entity as unknown as ClusterEntity.Entity<string, any>;

  // flush/redeliver/interrupt route through the deep `Client` seam (decision
  // #1: the control ops moved inside the Client). The host wires ONE
  // `Client.layer.*` adapter; the requirement collapses to the single `Client`
  // Tag.
  const flushFn = (actorId: string) => Client.use((client) => client.flush(entityAny, actorId));
  const redeliverFn = (actorId: string) =>
    Client.use((client) => client.redeliver(entityAny, actorId));

  // interrupt — rewired from Effect.die to flush. Distinct intent from
  // flush ("stop accepting more work" vs "clean slate"). Programmatic
  // in-flight cancellation requires Sharding.passivate (not yet public).
  const interruptFn = (entityId: string) =>
    Client.use((client) => client.flush(entityAny, entityId));

  const ofFn = <T>(handlers: T): T => handlers;
  const activateFn = (
    entityId: string,
  ): Effect.Effect<void, unknown, ActorClientService<Name, Defs>> =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      const ref = yield* factory(entityId);
      return yield* ref.execute(buildOpValue(ACTIVATE_TAG, { entityId }) as never);
    });

  const stateSchema = options?.state?.schema;
  const errorSchema = options?.state?.error;
  const decodeState = (raw: unknown): Effect.Effect<unknown, unknown> => {
    if (stateSchema === undefined) return Effect.succeed(raw);
    return Schema.decodeUnknownEffect(stateSchema)(raw) as Effect.Effect<unknown, unknown>;
  };
  const decodeFailure = (cause: unknown): Effect.Effect<never, unknown> => {
    // No error schema, or a nullish cause, passes straight through undecoded.
    if (errorSchema === undefined || cause === undefined || cause === null) {
      return Effect.fail(cause);
    }
    const decoded = Schema.decodeUnknownEffect(errorSchema)(cause) as Effect.Effect<
      unknown,
      unknown
    >;
    return Effect.flatMap(decoded, (value) => Effect.fail(value));
  };

  const getStateFn = (
    entityId: string,
    stateOptions?: ActorStateOptions<unknown, unknown>,
  ): Effect.Effect<
    unknown,
    unknown,
    ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs> | unknown
  > =>
    Effect.gen(function* () {
      if (stateOptions?.materialize !== undefined) {
        yield* stateOptions.materialize;
      } else {
        yield* activateFn(entityId);
      }
      const resolver = yield* ActorAddressResolver;
      const raw = yield* stateOf(resolveEntityAddress(resolver, entityAny, entityId)).pipe(
        Effect.catch(decodeFailure),
      );
      return yield* decodeState(raw);
    });

  const watchStateFn = (
    entityId: string,
    stateOptions?: ActorStateOptions<unknown, unknown>,
  ): Stream.Stream<
    unknown,
    unknown,
    ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs> | unknown
  > =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (stateOptions?.materialize !== undefined) {
          yield* stateOptions.materialize;
        } else {
          yield* activateFn(entityId);
        }
        const resolver = yield* ActorAddressResolver;
        return watchStateOf(resolveEntityAddress(resolver, entityAny, entityId)).pipe(
          Stream.catch((cause: unknown) => Stream.fromEffect(decodeFailure(cause))),
          Stream.mapEffect(decodeState),
        );
      }),
    );

  const waitForStateFn = (
    entityId: string,
    predicate: (state: unknown) => boolean,
    stateOptions?: ActorStateOptions<unknown, unknown>,
  ): Effect.Effect<
    unknown,
    unknown,
    ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs> | unknown
  > =>
    Effect.gen(function* () {
      if (stateOptions?.materialize !== undefined) {
        yield* stateOptions.materialize;
      } else {
        yield* activateFn(entityId);
      }
      const resolver = yield* ActorAddressResolver;
      const address = resolveEntityAddress(resolver, entityAny, entityId);
      const decoded = watchStateOf(address).pipe(
        Stream.catch((cause: unknown) => Stream.fromEffect(decodeFailure(cause))),
        Stream.mapEffect(decodeState),
        Stream.filter(predicate),
        Stream.runHead,
      );
      const option = yield* decoded;
      return yield* Option.match(option, {
        onNone: () =>
          Effect.die(
            new Error(
              `effect-encore/waitForState: state stream ended before predicate matched for ${String(address.entityType)}:${String(address.entityId)}`,
            ),
          ),
        onSome: Effect.succeed,
      });
    });

  const listStateEntityIdsFn = () => listStateEntityIds(String(entityAny.type));

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
      definitions: internalDefinitions,
      contextTag: contextTag as unknown as Context.Service<
        ActorClientService<Name, OperationDefs>,
        ActorClientFactory<Name, OperationDefs>
      >,
      entityAny,
    });
  }

  const actor = Object.assign(Object.create(Pipeable.Prototype), {
    _tag: "EntityActor" as const,
    name,
    type: name,
    _meta: { name, definitions, internalDefinitions, entity },
    Context: contextTag,
    Control: controlTag,
    State: stateTag,
    of: ofFn,
    interrupt: interruptFn,
    flush: flushFn,
    redeliver: redeliverFn,
    $is,
    ...handles,
    getState: getStateFn,
    watchState: watchStateFn,
    waitForState: waitForStateFn,
    listStateEntityIds: listStateEntityIdsFn,
  });

  return actor as EntityActor<Name, Defs, StateOf<StateDef>, StateErrorOf<StateDef>>;
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
}): OperationHandle<Name, Tag, C> => {
  const { name, tag, def, definitions, contextTag, entityAny } = args;

  const invocationOf = (payload: unknown) => compileInvocation(entityAny, tag, def, payload);

  // .send dispatches through the deep `Client` seam (ADR-0002). The Client
  // owns the wire-envelope builder + the mailbox/resolver/snowflake strategy
  // internally, so the producer-side requirement collapses from the former
  // `ActorMailbox | ActorAddressResolver | Snowflake.Generator` triad to a
  // single `Client` Tag. The host wires ONE `Client.layer.*` adapter
  // (`fromConfig` producer / `fromSharding` consumer / `memory` / `test`).
  // Extracted as a local so `sendAndAwait` can reuse it.
  const sendFn = (payload: unknown) =>
    Effect.gen(function* () {
      const client = yield* Client;
      return yield* client.send(invocationOf(payload));
    });

  // eslint-disable-next-line typescript-eslint/no-explicit-any -- handle types erased
  const handle: OperationHandle<Name, Tag, C> = {
    _tag: "OperationHandle" as const,
    name: tag,
    execute: ((payload: unknown) =>
      Effect.gen(function* () {
        const factory = yield* contextTag;
        const invocation = invocationOf(payload);
        const ref = yield* factory(invocation.identity.entityId);
        return yield* ref.execute(invocation.operation as never);
      })) as never,
    send: sendFn as never,
    sendAndAwait: ((
      payload: unknown,
      options: {
        readonly timeout: Duration.Input;
        // eslint-disable-next-line typescript-eslint/no-explicit-any
        readonly schedule?: Schedule.Schedule<any, unknown>;
      },
    ) =>
      Effect.gen(function* () {
        const eid = yield* sendFn(payload);
        const result = yield* Effect.timeoutOrElse(
          makeWaitFor((e) => peekImpl(entityAny, e as string, definitions), eid, {
            schedule: options.schedule,
          } as never),
          {
            duration: options.timeout,
            orElse: () =>
              Effect.fail(
                new SendAndAwaitTimeout({
                  entityType: String(entityAny.type),
                  execId: eid as string,
                  timeout: Duration.fromInputUnsafe(options.timeout),
                }),
              ),
          },
        );
        switch (result._tag) {
          case "Success":
            return result.value;
          case "Failure":
            return yield* Effect.fail(result.error);
          case "Defect":
            return yield* Effect.die(result.cause);
          case "Interrupted":
            return yield* Effect.die(
              new Error(`effect-encore/sendAndAwait: ${String(eid)} was interrupted`),
            );
          default:
            return yield* Effect.die(
              new Error("effect-encore/sendAndAwait: waitFor returned a non-terminal result"),
            );
        }
      })) as never,
    executionId: ((payload: unknown) =>
      Effect.succeed(invocationOf(payload).identity.execId)) as never,
    peek: ((payload: unknown) =>
      peekImpl(entityAny, invocationOf(payload).identity.execId, definitions) as never) as never,
    watch: ((payload: unknown, options?: { readonly interval?: Duration.Input }) =>
      watchImpl(
        entityAny,
        invocationOf(payload).identity.execId,
        definitions,
        options,
      ) as never) as never,
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
        invocationOf(payload).identity.execId,
        options as never,
      )) as never,
    rerun: ((payload: unknown) => rerunImpl(entityAny, def, tag, payload)) as never,
    make: ((payload: unknown) => invocationOf(payload).operation as never) as never,
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
  State,
  StateError,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
>(
  actor: EntityActor<Name, Defs, State, StateError, Rpcs>,
): Layer.Layer<
  | ActorClientService<Name, Defs>
  | ActorControlClientService<Name>
  | ActorStateClientService<Name>
  | Client
  | ActorMailbox
  | ActorAddressResolver
  | ActorStateRegistry
  | Snowflake.Generator,
  never,
  MessageStorage.MessageStorage | Sharding.Sharding | Rpc.MiddlewareClient<Rpcs>
>;

function toLayer<
  Name extends string,
  Defs extends OperationDefs,
  State,
  StateError,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
  RH = never,
  S = never,
  ES = never,
  RS = never,
>(
  actor: EntityActor<Name, Defs, State, StateError, Rpcs>,
  build: ActorHandlers<Defs, RH> | Effect.Effect<ActorHandlers<Defs, RH>, never, RX>,
  options?: ToLayerOptions<S, ES, RS>,
  /* eslint-disable typescript-eslint/no-explicit-any -- implementation overload requires any */
): Layer.Layer<
  | ActorClientService<Name, Defs>
  | ActorControlClientService<Name>
  | ActorStateClientService<Name>
  | Client
  | ActorMailbox
  | ActorAddressResolver
  | ActorStateRegistry
  | Snowflake.Generator,
  never,
  | Exclude<RX, Scope.Scope | CurrentAddress | CurrentRunnerAddress | ActorStateRegistry>
  | Exclude<RH, Scope.Scope | CurrentAddress | CurrentRunnerAddress | ActorStateRegistry | S>
  | Exclude<RS, Scope.Scope | CurrentAddress | CurrentRunnerAddress | S>
  | MessageStorage.MessageStorage
  | Sharding.Sharding
  | Rpc.MiddlewareClient<Rpcs>
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
  options?: ToLayerOptions<unknown, unknown, unknown>,
): Layer.Layer<any, any, any> {
  /* eslint-enable typescript-eslint/no-explicit-any */
  if (isWorkflowActor(actor) && build !== undefined) {
    return workflowToLayer(actor, build as Function);
  }

  const actorDefinitions = actor._meta.internalDefinitions ?? actor._meta.definitions;

  const clientLayer = Layer.effect(
    actor.Context,
    Effect.gen(function* () {
      const boundContext = yield* Effect.context<never>();
      const makeClient = (yield* actor._meta.entity.client) as Function;
      return (entityId: string) =>
        Effect.succeed(
          buildActorRef(
            actor._meta.name,
            entityId,
            actorDefinitions,
            makeClient(entityId) as RpcClient.RpcClient<Rpc.Any, never>,
            boundContext,
          ),
        );
    }),
  );

  // Consumer hosts already have full `Sharding.Sharding` from
  // `ClusterRunnerSocket.layer` / similar — wire ActorMailbox + ActorAddressResolver
  // from that. Producer-only hosts must wire `Client.layer.fromConfig` explicitly
  // at the runtime root.
  //
  // `Snowflake.layerGenerator` is needed by `Client.send` to build the
  // `OutgoingRequest`. `Sharding.layer` consumes it internally but doesn't
  // expose it, so we provide a fresh generator at this surface.
  //
  // The deep `Client` Tag is composed over those same transport siblings
  // (`clientServiceLayer` requires `ActorMailbox | ActorAddressResolver |
  // Snowflake | MessageStorage`; the first three come from this merge, the last
  // from the consumer's Sharding stack), AND the raw transport Tags stay
  // exposed because `peek`/`getState`/`rerun` still require
  // `MessageStorage | ActorAddressResolver` directly.
  const transportSupportLayers = Layer.mergeAll(
    ActorMailboxLayer.fromSharding,
    ActorAddressResolverLayer.fromSharding,
    ActorStateRegistry.Live,
    Snowflake.layerGenerator,
  );
  // `Layer.fresh` for the same reason as in `toTestLayer`: the shared
  // module-level `clientServiceLayer` must be rebuilt per-actor over THIS
  // actor's transport, not memoized to the first build.
  const consumerSupportLayers = attachFreshService(transportSupportLayers, clientServiceLayer);

  const stateLayer = makeActorStateLayer(actor);
  const controlLayer = makeActorControlLayer(actor);

  if (build === undefined) {
    const baseLayer = Layer.merge(clientLayer, consumerSupportLayers);
    return assembleActorRuntime(baseLayer, stateLayer, controlLayer);
  }

  const transformed = transformHandlers(build, actorDefinitions, options?.withScope);
  const handlerLayer = actor._meta.entity.toLayer(transformed as never, {
    spanAttributes: options?.spanAttributes,
    maxIdleTime: options?.maxIdleTime,
    concurrency: options?.concurrency,
    mailboxCapacity: options?.mailboxCapacity,
  });
  const supportedHandlerLayer = Layer.provide(handlerLayer, transportSupportLayers);

  const baseLayer = layerPassthrough(
    Layer.merge(Layer.merge(supportedHandlerLayer, clientLayer), consumerSupportLayers),
  );

  return assembleActorRuntime(baseLayer, stateLayer, controlLayer);
}

// ── Actor.toTestLayer ─────────────────────────────────────────────────────

// Entity overload
function toTestLayer<
  Name extends string,
  Defs extends OperationDefs,
  State,
  StateError,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
  RX = never,
  RH = never,
  S = never,
  ES = never,
  RS = never,
>(
  actor: EntityActor<Name, Defs, State, StateError, Rpcs>,
  build: ActorHandlers<Defs, RH> | Effect.Effect<ActorHandlers<Defs, RH>, never, RX>,
  options?: ToLayerOptions<S, ES, RS>,
): Layer.Layer<
  | ActorClientService<Name, Defs>
  | ActorControlClientService<Name>
  | ActorStateClientService<Name>
  | Client
  | ActorMailbox
  | ActorAddressResolver
  | ActorStateRegistry
  | Snowflake.Generator,
  never,
  | Exclude<RX, Scope.Scope | CurrentAddress | CurrentRunnerAddress | ActorStateRegistry>
  | Exclude<RH, Scope.Scope | CurrentAddress | CurrentRunnerAddress | ActorStateRegistry | S>
  | Exclude<RS, Scope.Scope | CurrentAddress | CurrentRunnerAddress | S>
  | ShardingConfig.ShardingConfig
>;

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
  options?: ToLayerOptions<unknown, unknown, unknown>,
): Layer.Layer<any, any, any> {
  /* eslint-enable typescript-eslint/no-explicit-any */
  if (isWorkflowActor(actor)) {
    return workflowToTestLayer(actor, build as Function);
  }

  const actorDefinitions = actor._meta.internalDefinitions ?? actor._meta.definitions;
  const transformed = transformHandlers(build, actorDefinitions, options?.withScope);
  const handlerLayer = actor._meta.entity.toLayer(transformed as never, {
    spanAttributes: options?.spanAttributes,
    maxIdleTime: options?.maxIdleTime,
    concurrency: options?.concurrency,
    mailboxCapacity: options?.mailboxCapacity,
  });

  const supportLayers = Layer.mergeAll(
    ActorAddressResolverLayer.fromConfig,
    ActorStateRegistry.Live,
    MessageStorage.layerMemory,
    Snowflake.layerGenerator,
  );
  // Build the test rpcClient factory once and use it for BOTH the
  // ActorClientService (.execute path) AND the test ActorMailbox (.send path).
  // `Entity.makeTestClient` is a scoped resource — `Layer.scopedContext` hosts
  // it in the layer's build scope and we expose two services from one closure.
  //
  // Pure-data resolver + a fresh Snowflake.Generator complete the wiring so
  // OperationHandle.send can build OutgoingRequests.
  const factoryAndMailboxLayer = Layer.effectContext(
    Effect.gen(function* () {
      const registry = yield* ActorStateRegistry;
      const handlerLayerWithRegistry = Layer.provide(
        handlerLayer,
        Layer.succeed(ActorStateRegistry, registry),
      );
      const makeClient = (yield* Entity.makeTestClient(
        actor._meta.entity,
        handlerLayerWithRegistry as never,
      )) as (entityId: string) => Effect.Effect<RpcClient.RpcClient<Rpc.Any, never>>;

      const factory = (entityId: string): Effect.Effect<ActorRef<string, OperationDefs>> =>
        Effect.map(makeClient(entityId), (rpcClient) =>
          buildActorRef(actor._meta.name, entityId, actorDefinitions, rpcClient),
        );

      const mailboxImpl: ActorMailboxShape = makeTestMailboxImpl(makeClient);

      return Context.empty().pipe(
        Context.add(actor.Context, factory),
        Context.add(ActorMailbox, mailboxImpl),
      );
    }),
  );

  // The injected test `ActorMailbox` (`factoryAndMailboxLayer`) plus the
  // pure-data resolver/storage/snowflake in `supportLayers` satisfy the deep
  // `Client`'s requirements — so `.send` (now `Client`-channeled) resolves
  // through the test mailbox, routing the prebuilt request back through the
  // per-entity test rpcClient with `{ discard: true }`.
  const transportSupportLayers = Layer.merge(
    Layer.provide(factoryAndMailboxLayer, supportLayers),
    supportLayers,
  );
  // `Layer.fresh`: `clientServiceLayer` is a shared module-level Layer, so
  // without `fresh` Effect's identity-based memoization would build the deep
  // `Client` ONCE and reuse that build (capturing the FIRST actor's test
  // mailbox) across every `toTestLayer` in the same runtime — routing a
  // second actor's `.send` to the wrong per-entity rpcClient. `fresh` forces a
  // per-actor build over this actor's own transport.
  const baseLayer = attachFreshService(transportSupportLayers, clientServiceLayer);
  const stateLayer = makeActorStateLayer(actor);
  const controlLayer = makeActorControlLayer(actor);

  return assembleActorRuntime(baseLayer, stateLayer, controlLayer);
}

const makeActorControlLayer = <Name extends string, Defs extends OperationDefs>(
  actor: EntityActor<Name, Defs>,
): Layer.Layer<ActorControlClientService<Name>, never, Client> =>
  Layer.effect(
    actor.Control,
    Effect.gen(function* () {
      // The control ops route through the deep `Client` seam (ADR-0002), so
      // the layer captures the single `Client` Tag at build time and closes it
      // over each op — collapsing the requirement to `never` per method, in
      // lockstep with the rewired `actor.interrupt/flush/redeliver` (which now
      // require exactly `Client`).
      const client = yield* Client;

      const provideSupport = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, Exclude<R, Client>> =>
        effect.pipe(Effect.provideService(Client, client));

      return {
        interrupt: (entityId) => provideSupport(actor.interrupt(entityId)),
        flush: (entityId) => provideSupport(actor.flush(entityId)),
        redeliver: (entityId) => provideSupport(actor.redeliver(entityId)),
      } satisfies ActorControlClient;
    }),
  );

const makeActorStateLayer = <Name extends string, Defs extends OperationDefs, State, StateError>(
  actor: EntityActor<Name, Defs, State, StateError>,
): Layer.Layer<
  ActorStateClientService<Name>,
  never,
  ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs>
> =>
  Layer.effect(
    actor.State,
    Effect.gen(function* () {
      const resolver = yield* ActorAddressResolver;
      const registry = yield* ActorStateRegistry;
      const factory = yield* actor.Context;

      const provideEffectSupport = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<
        A,
        E,
        Exclude<R, ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs>>
      > =>
        effect.pipe(
          Effect.provideService(actor.Context, factory),
          Effect.provideService(ActorStateRegistry, registry),
          Effect.provideService(ActorAddressResolver, resolver),
        ) as Effect.Effect<
          A,
          E,
          Exclude<R, ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs>>
        >;

      const provideStreamSupport = <A, E, R>(
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<
        A,
        E,
        Exclude<R, ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs>>
      > =>
        stream.pipe(
          Stream.provideService(actor.Context, factory),
          Stream.provideService(ActorStateRegistry, registry),
          Stream.provideService(ActorAddressResolver, resolver),
        ) as Stream.Stream<
          A,
          E,
          Exclude<R, ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs>>
        >;

      return {
        get: (entityId, options) => provideEffectSupport(actor.getState(entityId, options)),
        watch: (entityId, options) => provideStreamSupport(actor.watchState(entityId, options)),
        waitFor: (entityId, predicate, options) =>
          provideEffectSupport(actor.waitForState(entityId, predicate, options)),
        listEntityIds: provideEffectSupport(actor.listStateEntityIds()),
      } satisfies ActorStateClient<State, StateError>;
    }),
  );

// ── Transform handlers from operation-first to request-first ───────────────

const transformHandlers = (
  build: unknown,
  definitions?: OperationDefs,
  withScope?: (
    address: EntityAddress.EntityAddress,
  ) => Effect.Effect<Context.Context<unknown>, unknown, unknown>,
): unknown => {
  if (build != null && typeof build === "object" && !Effect.isEffect(build)) {
    const handlers = build as Record<string, Function>;
    const transformed: Record<string, Function> = {};
    if (definitions?.[ACTIVATE_TAG] !== undefined) {
      transformed[ACTIVATE_TAG] = () => Effect.void;
    }
    for (const tag of Object.keys(handlers)) {
      const handler = handlers[tag];
      if (!handler) continue;
      const def = definitions?.[tag];
      const opaque = def?.payload !== undefined && isOpaquePayload(def.payload);
      transformed[tag] = (request: Record<string, unknown>) => {
        const raw = request["payload"];
        const buildOperation = (): Record<string, unknown> => {
          if (opaque) return { _tag: tag, _payload: raw };
          return { _tag: tag, ...((raw ?? {}) as object) };
        };
        const operation = buildOperation();
        const body = handler({ operation, request }) as Effect.Effect<unknown, unknown, unknown>;
        if (withScope === undefined) return body;
        return Effect.gen(function* () {
          const address = yield* CurrentAddress;
          const context = yield* withScope(address);
          return yield* Effect.provide(body, context);
        });
      };
    }
    return transformed;
  }
  return Effect.map(build as Effect.Effect<unknown>, (b) =>
    transformHandlers(b, definitions, withScope),
  );
};

// ── buildActorRef — value-dispatch ref ─────────────────────────────────────

const buildActorRef = <Name extends string, Defs extends OperationDefs>(
  _actorName: Name,
  _entityId: string,
  definitions: Defs,
  rpcClient: RpcClient.RpcClient<Rpc.Any, never>,
  boundContext?: Context.Context<never>,
): ActorRef<Name, Defs> => {
  const client = rpcClient as unknown as Record<string, Function>;

  const bind = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    if (boundContext === undefined) return effect;
    return Effect.context<never>().pipe(
      Effect.flatMap((currentContext) =>
        Effect.provideContext(effect, Context.merge(boundContext, currentContext)),
      ),
    ) as Effect.Effect<A, E, R>;
  };

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
          new ActorDefect({
            message: `effect-encore: unknown operation "${tag}" on actor "${_actorName}"`,
          }),
        );
      const def = definitions[tag] as OperationDef | undefined;
      const arg = rpcArg(op, def);
      const call = (): unknown => {
        if (arg !== undefined) return fn(arg);
        return fn();
      };
      return bind(call() as Effect.Effect<unknown, unknown, unknown>);
    },
    send: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const tag = op["_tag"];
      const fn = client[tag];
      if (!fn)
        return Effect.die(
          new ActorDefect({
            message: `effect-encore: unknown operation "${tag}" on actor "${_actorName}"`,
          }),
        );
      const def = definitions[tag] as OperationDef | undefined;
      const arg = rpcArg(op, def);
      const dispatchDiscarded = (): unknown => {
        if (arg !== undefined) return fn(arg, { discard: true });
        return fn(undefined, { discard: true });
      };
      const discardCall = dispatchDiscarded() as
        | Effect.Effect<unknown, unknown, unknown>
        | undefined;
      const pkInput = payloadFromOperation(def, op);
      const { primaryKey } = resolveId(def, pkInput, tag);
      const execId = ExecIdCodec.encode({ entityId: _entityId, tag, primaryKey });
      return bind(Effect.map(discardCall ?? Effect.void, () => execId));
    },
  } as ActorRef<Name, Defs>;
};

// ── Workflow reserved keys + signal constructors ─────────────────────────

const WORKFLOW_RESERVED_KEYS = new Set<string>([
  "_tag",
  "_meta",
  "$is",
  "Context",
  "compensation",
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
  "signal",
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

type WorkflowReadServices<Success extends Schema.Top, Error extends Schema.Top> =
  | WorkflowEngine
  | Success["DecodingServices"]
  | Error["DecodingServices"];

type WorkflowPeekResult<Success extends Schema.Top, Error extends Schema.Top> = PeekResult<
  Success["Type"],
  Error["Type"]
>;

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
  /** Create a durable signal whose name is selected at runtime. */
  readonly signal: <
    S extends Schema.Top = typeof Schema.Void,
    E extends Schema.Top = typeof Schema.Never,
  >(
    name: string,
    options?: { readonly success?: S; readonly error?: E },
  ) => WorkflowSignal<Schema.Struct<Payload>, S, E>;
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
    WorkflowPeekResult<Success, Error>,
    never,
    WorkflowReadServices<Success, Error>
  >;
  /** Inspect a workflow run by its durable execution identifier. */
  readonly peekAt: (
    executionId: string,
  ) => Effect.Effect<
    WorkflowPeekResult<Success, Error>,
    never,
    WorkflowReadServices<Success, Error>
  >;
  readonly watch: (
    payload: WorkflowPayloadType<Payload>,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<
    WorkflowPeekResult<Success, Error>,
    never,
    WorkflowReadServices<Success, Error>
  >;
  /**
   * Watch a workflow run by its durable execution identifier.
   * An unknown identifier stays Pending. Apply a stream timeout when the
   * caller cannot wait without a bound.
   */
  readonly watchAt: (
    executionId: string,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<
    WorkflowPeekResult<Success, Error>,
    never,
    WorkflowReadServices<Success, Error>
  >;
  readonly waitFor: (
    payload: WorkflowPayloadType<Payload>,
    options?: {
      readonly filter?: (result: WorkflowPeekResult<Success, Error>) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => Effect.Effect<
    WorkflowPeekResult<Success, Error>,
    never,
    WorkflowReadServices<Success, Error>
  >;
  /**
   * Wait for a workflow run selected by its durable execution identifier.
   * An unknown identifier stays Pending. Apply `Effect.timeout` when the
   * caller cannot wait without a bound.
   */
  readonly waitForAt: (
    executionId: string,
    options?: {
      readonly filter?: (result: WorkflowPeekResult<Success, Error>) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => Effect.Effect<
    WorkflowPeekResult<Success, Error>,
    never,
    WorkflowReadServices<Success, Error>
  >;
  /**
   * Surgically clear this execution's cached run reply + activity replies so
   * the next `.execute(samePayload)` runs from scratch.
   *
   * Composes `WorkflowEngine.interrupt` (signals the running fiber, no-op if
   * completed) with message deletion (wipes run reply +
   * cached activity replies stored at the workflow's `EntityAddress`).
   *
   * Caveat: rerun-while-running interrupts the fiber and clears state, but
   * cleanup is best-effort eventual — the next `.execute(samePayload)` may
   * queue behind the interrupted fiber's wind-down. No data corruption, just
   * transient ordering.
   */
  readonly rerun: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<void, PersistenceError, MessageDeletion | Sharding.Sharding | WorkflowEngine>;
  readonly interrupt: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly compensation: {
    readonly pending: (
      executionId: string,
    ) => Effect.Effect<
      Option.Option<PendingCompensation>,
      never,
      WorkflowReadServices<Success, Error>
    >;
    readonly decide: (
      executionId: string,
      stepId: string,
      attempt: number,
      decision: CompensationDecision,
    ) => Effect.Effect<void, CompensationNotPendingError, WorkflowReadServices<Success, Error>>;
    readonly retry: (
      executionId: string,
      stepId: string,
      attempt: number,
    ) => Effect.Effect<void, CompensationNotPendingError, WorkflowReadServices<Success, Error>>;
    readonly stop: (
      executionId: string,
      stepId: string,
      attempt: number,
    ) => Effect.Effect<void, CompensationNotPendingError, WorkflowReadServices<Success, Error>>;
  };
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
      entityType: EntityType.make(`Workflow/${workflow._tag}`),
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
    payload: def.payload,
    // upstream UpstreamWorkflow takes `idempotencyKey`; encore exposes `id`.
    idempotencyKey: def.id,
  };
  if (def.success) workflowOptions["success"] = def.success;
  if (def.error) workflowOptions["error"] = def.error;
  if (def.suspendedRetrySchedule)
    workflowOptions["suspendedRetrySchedule"] = def.suspendedRetrySchedule;

  let wf = (UpstreamWorkflow.make as Function)(name, workflowOptions) as UpstreamWorkflow.Workflow<
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

  class WorkflowClientContext extends Context.Service<
    WorkflowClientContext,
    ActorClientFactory<Name, WfDefs>
  >()(`effect-encore/${name}/Client`) {}

  const contextTag = WorkflowClientContext as unknown as Context.Service<
    ActorClientService<Name, WfDefs>,
    ActorClientFactory<Name, WfDefs>
  >;

  const make = (payload: WorkflowPayloadType<Payload>) =>
    ({ _tag: "Run", ...payload }) as { readonly _tag: "Run" } & WorkflowPayloadType<Payload> &
      OperationBrand<Name, "Run", Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>;

  // Build declarative signals
  /* eslint-disable typescript-eslint/no-explicit-any -- signal types are erased at runtime */
  const signals: Record<string, WorkflowSignal<any, any, any>> = {};
  /* eslint-enable typescript-eslint/no-explicit-any */
  for (const [sigName, sigDef] of Object.entries(def.signals ?? {})) {
    if (WORKFLOW_RESERVED_KEYS.has(sigName)) {
      throw new ActorDefect({
        message: `effect-encore: signal "${sigName}" collides with reserved property on workflow "${name}". Reserved: ${[...WORKFLOW_RESERVED_KEYS].join(", ")}`,
      });
    }
    // eslint-disable-next-line typescript-eslint/no-explicit-any
    signals[sigName] = makeSignal(wf, sigName, {
      success: sigDef.success,
      error: sigDef.error,
    });
  }

  // Compute the workflow's actual executionId for a payload. Upstream derives
  // execId as `hash(name-idempotencyKey(payload))` (Workflow.js makeExecutionId);
  // peek/rerun MUST use that same id or they'll look at the wrong slot.
  const execIdFor = (payload: WorkflowPayloadType<Payload>): Effect.Effect<string> =>
    wf.executionId(payload as never);

  type RawPeek = WorkflowPeekResult<Success, Error>;

  const peekAtFn = (
    executionId: string,
  ): Effect.Effect<RawPeek, never, WorkflowReadServices<Success, Error>> =>
    Effect.map(wf.poll(executionId), (result) =>
      Option.match(result, {
        onNone: () => Pending,
        onSome: (value) => {
          if (value._tag === "Suspended") return Suspended;
          return mapExitToWorkflowPeekResult(value.exit);
        },
      }),
    );

  const peekFn = (payload: WorkflowPayloadType<Payload>) =>
    Effect.flatMap(execIdFor(payload), peekAtFn);

  const watchAtFn = (
    executionId: string,
    options?: { readonly interval?: Duration.Input },
  ): Stream.Stream<RawPeek, never, WorkflowReadServices<Success, Error>> => {
    const interval = options?.interval ?? Duration.millis(200);
    return Stream.fromEffectSchedule(peekAtFn(executionId), Schedule.spaced(interval)).pipe(
      Stream.changesWith(peekResultEquals),
      Stream.takeUntil(isTerminal),
    );
  };

  const watchFn = (
    payload: WorkflowPayloadType<Payload>,
    options?: { readonly interval?: Duration.Input },
  ): Stream.Stream<RawPeek, never, WorkflowReadServices<Success, Error>> =>
    Stream.unwrap(Effect.map(execIdFor(payload), (executionId) => watchAtFn(executionId, options)));

  const waitForAtFn = (
    executionId: string,
    options?: {
      readonly filter?: (result: RawPeek) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ): Effect.Effect<RawPeek, never, WorkflowReadServices<Success, Error>> =>
    makeWaitFor(peekAtFn, makeExecId(executionId), options);

  const waitForFn = (
    payload: WorkflowPayloadType<Payload>,
    options?: {
      readonly filter?: (result: RawPeek) => boolean;
      // eslint-disable-next-line typescript-eslint/no-explicit-any
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ): Effect.Effect<RawPeek, never, WorkflowReadServices<Success, Error>> =>
    Effect.flatMap(execIdFor(payload), (executionId) => waitForAtFn(executionId, options));

  const interruptFn = (executionId: string) => wf.interrupt(executionId);

  const resumeFn = (executionId: string) => wf.resume(executionId);

  const compensation = {
    pending: (executionId: string) => pendingCompensation(wf, executionId),
    decide: (
      executionId: string,
      stepId: string,
      attempt: number,
      decision: CompensationDecision,
    ) => decideCompensation(wf, executionId, stepId, attempt, decision),
    retry: (executionId: string, stepId: string, attempt: number) =>
      decideCompensation(wf, executionId, stepId, attempt, "Retry"),
    stop: (executionId: string, stepId: string, attempt: number) =>
      decideCompensation(wf, executionId, stepId, attempt, "Stop"),
  };

  const signal = <
    S extends Schema.Top = typeof Schema.Void,
    E extends Schema.Top = typeof Schema.Never,
  >(
    signalName: string,
    options?: { readonly success?: S; readonly error?: E },
  ): WorkflowSignal<Schema.Struct<Payload>, S, E> => makeSignal(wf, signalName, options);

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
  ): Effect.Effect<void, PersistenceError, MessageDeletion | Sharding.Sharding | WorkflowEngine> =>
    Effect.gen(function* () {
      const executionId = yield* execIdFor(payload);
      yield* wf.interrupt(executionId);
      const deletion = yield* MessageDeletion;
      const address = yield* resolveWorkflowAddress(wf, executionId);
      yield* deletion.deleteAddress(address);
      const clockAddress = yield* resolveWorkflowClockAddress(wf, executionId);
      yield* deletion.deleteAddress(clockAddress);
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
    signal,
    execute: executeFn,
    send: sendFn,
    executionId: executionIdFn,
    peek: peekFn,
    peekAt: peekAtFn,
    watch: watchFn,
    watchAt: watchAtFn,
    waitFor: waitForFn,
    waitForAt: waitForAtFn,
    rerun: rerunFn,
    interrupt: interruptFn,
    resume: resumeFn,
    compensation,
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
    const execution = makeWorkflowExecution(wf, executionId);
    return Effect.catchCause(handler(payload, execution.step), (cause) => {
      // A pure interrupt ends the run. A mixed failure still needs compensation.
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return execution.compensate(cause).pipe(Effect.andThen(Effect.failCause(cause)));
    });
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
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      return (_entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, engine));
    }),
  );

  return layerPassthrough(Layer.merge(handlerLayer, clientLayer));
};

const workflowToTestLayer = (
  actor: WorkflowActor<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const wf = actor._meta.workflow;
  const handlerLayer = wf.toLayer(wrapWorkflowHandler(actor, handler) as any);

  const clientLayer = Layer.effect(
    actor.Context,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      return (_entityId: string) => Effect.succeed(buildWorkflowActorRef(actor, engine));
    }),
  );

  return Layer.provideMerge(Layer.merge(handlerLayer, clientLayer), workflowEngineLayerMemory);
};

const buildWorkflowActorRef = (
  actor: WorkflowActor<any, any, any, any>,
  engine: WorkflowEngine["Service"],
): ActorRef<any, any> => {
  const wf = actor._meta.workflow;

  return {
    execute: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = op;
      return wf.execute(payload as any).pipe(Effect.provideService(WorkflowEngine, engine));
    },
    send: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = op;
      return Effect.map(
        wf
          .execute(payload as any, { discard: true })
          .pipe(Effect.provideService(WorkflowEngine, engine)) as Effect.Effect<string>,
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
  ): <Name extends string, Defs extends OperationDefs, State, StateError, Rpcs extends Rpc.Any>(
    actor: EntityActor<Name, Defs, State, StateError, Rpcs>,
  ) => EntityActor<Name, Defs, State, StateError, Rpcs>;
  <RpcsIn extends Rpc.Any, RpcsOut extends Rpc.Any>(
    transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
  ): <Name extends string, Defs extends OperationDefs, State, StateError>(
    actor: EntityActor<Name, Defs, State, StateError, RpcsIn>,
  ) => EntityActor<Name, Defs, State, StateError, RpcsOut>;
};

type WithProtocolDataFirst = <
  Name extends string,
  Defs extends OperationDefs,
  State,
  StateError,
  RpcsIn extends Rpc.Any,
  RpcsOut extends Rpc.Any,
>(
  actor: EntityActor<Name, Defs, State, StateError, RpcsIn>,
  transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
) => EntityActor<Name, Defs, State, StateError, RpcsOut>;

type WithProtocol = WithProtocolDataLast & WithProtocolDataFirst;

const withProtocolImpl = <
  Name extends string,
  Defs extends OperationDefs,
  State,
  StateError,
  RpcsIn extends Rpc.Any,
  RpcsOut extends Rpc.Any,
>(
  actor: EntityActor<Name, Defs, State, StateError, RpcsIn>,
  transform: (protocol: RpcGroup.RpcGroup<RpcsIn>) => RpcGroup.RpcGroup<RpcsOut>,
): EntityActor<Name, Defs, State, StateError, RpcsOut> => {
  const newEntity = Entity.fromRpcGroup(actor._meta.name, transform(actor._meta.entity.protocol));
  return Object.assign(Object.create(Pipeable.Prototype), actor, {
    _meta: { ...actor._meta, entity: newEntity },
  }) as EntityActor<Name, Defs, State, StateError, RpcsOut>;
};

export const withProtocol: WithProtocol = dual(2, withProtocolImpl);

export { CurrentAddress };

// ── Any types + Type Guards ───────────────────────────────────────────────

// eslint-disable-next-line typescript-eslint/no-explicit-any
export type AnyEntityActor = EntityActor<any, any, any, any, any>;
// eslint-disable-next-line typescript-eslint/no-explicit-any
export type AnyWorkflowActor = WorkflowActor<any, any, any, any, any>;
export type AnyActor = AnyEntityActor | AnyWorkflowActor;

const isEntity = (actor: AnyActor): actor is AnyEntityActor => actor._tag === "EntityActor";

const isWorkflow = (actor: AnyActor): actor is AnyWorkflowActor => actor._tag === "WorkflowActor";

// ── Public API ─────────────────────────────────────────────────────────────

export const Actor = {
  CurrentAddress,
  registerState: registerState as <A, Error = never, Requirements = never>(
    state: State.State<A, Error, Requirements>,
  ) => Effect.Effect<void, never, ActorStateRegistry | CurrentAddress | Scope.Scope>,
  entityIdCodec,
  State,
  Client,
  ClientLayer,
  fromEntity,
  fromWorkflow,
  fromRpcs,
  provideLayerBuildContext,
  withProtocol,
  toLayer,
  toTestLayer,
  isEntity,
  isWorkflow,
} as const;
