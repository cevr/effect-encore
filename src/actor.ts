import {
  type Entity as ClusterEntity,
  Entity,
  type EntityAddress,
  MessageStorage,
  type Sharding,
  type ShardingConfig,
  Snowflake,
} from "effect/cluster";
import { CurrentAddress, CurrentRunnerAddress } from "effect/cluster/Entity";
import type {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  MalformedMessage,
  PersistenceError,
} from "effect/cluster/ClusterError";
import type { Rpc, RpcClient, RpcGroup } from "effect/rpc";
import { ActorAddressResolver, ActorAddressResolverLayer } from "./actor-address-resolver.js";
import { ActorDefect } from "./actor-defect.js";
import type { MailboxError, ActorMailboxService } from "./actor-mailbox.js";
import { ActorMailbox, ActorMailboxLayer } from "./actor-mailbox.js";
import type { Execution } from "effect/workflow/Workflow";
import type { WorkflowEngine, WorkflowInstance } from "effect/workflow/WorkflowEngine";
import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Pipeable,
  Predicate,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { Schedule } from "effect";
import { dual } from "effect/Function";
import type { SignalDefs, WorkflowStepContext } from "./step.js";
import type { ExecId, PeekResult } from "./receipt.js";
import { ExecIdCodec } from "./receipt.js";
import {
  Client,
  clientServiceLayer,
  makeTestMailboxImpl,
  resolveEntityAddress,
  layer as ClientLayer,
} from "./client.js";
import type {
  EntityIdReturn,
  OperationDef,
  OperationDefs,
} from "./internal/invocation-compiler.js";
import {
  compileInvocation,
  compileRpc,
  isOpaquePayload,
  makeOperationValue,
  payloadFromOperation,
  resolveId,
  unwrapOpaquePayload,
} from "./internal/invocation-compiler.js";
import {
  waitFor as waitForExecution,
  watch as watchExecution,
} from "./internal/execution-observation.js";
import {
  ActorStateRegistry,
  listStateEntityIds,
  makeActorStateObservation,
  registerState,
} from "./actor-state.js";
import type { ActorStateUnavailable } from "./actor-state.js";
import * as State from "./state.js";
import { entityIdCodec } from "./entity-id-codec.js";
import {
  compileWorkflowActor,
  isWorkflowActor as isCompiledWorkflowActor,
  workflowToLayer as compiledWorkflowToLayer,
  workflowToTestLayer as compiledWorkflowToTestLayer,
} from "./internal/workflow-actor.js";
import type {
  WorkflowActor,
  WorkflowPayloadType,
  WorkflowRunDefs,
} from "./internal/workflow-actor.js";

export type { WorkflowActor, WorkflowDef } from "./internal/workflow-actor.js";

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

// ── Layer passthrough ─────────────────────────────────────────────────────
// Adds the layer's input requirements to its output so provided services
// flow through to program code.
const layerPassthrough = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut | RIn, E, RIn> =>
  Layer.merge(Layer.effectContext(Effect.context<RIn>()), layer);

const attachFreshService = <Support, Service, E, R, ServiceR>(
  support: Layer.Layer<Support, E, R>,
  service: Layer.Layer<Service, never, ServiceR>,
): Layer.Layer<Support | Service, E, R | Exclude<ServiceR, Support>> =>
  Layer.merge(support, Layer.provide(Layer.fresh(service), support));

const assembleActorRuntime = <Base, State, Control, E, R, StateR, ControlR>(
  base: Layer.Layer<Base, E, R>,
  state: Layer.Layer<State, never, StateR>,
  control: Layer.Layer<Control, never, ControlR>,
): Layer.Layer<Base | State | Control, E, R | Exclude<StateR, Base> | Exclude<ControlR, Base>> =>
  Layer.mergeAll(base, Layer.provide(state, base), Layer.provide(control, base));

// Payload classification and identity rules live in the internal Invocation
// compiler. Actor and Client consume the same compiled facts.

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
  readonly maxIdleTime?: Duration.Input;
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

function provideCapturedLayerBuildContext<A, E, R>(
  build: Effect.Effect<A, E, R>,
  context: Context.Context<Exclude<R, ActorLayerBuildContextExclusions>>,
): Effect.Effect<A, E, Extract<R, ActorLayerBuildContextExclusions>>;
function provideCapturedLayerBuildContext<A, E, R>(
  build: Effect.Effect<A, E, R>,
  context: Context.Context<Exclude<R, ActorLayerBuildContextExclusions>>,
): unknown {
  return Effect.provideContext(build, context);
}

export const provideLayerBuildContext = <A, E, R>(
  build: Effect.Effect<A, E, R>,
): Effect.Effect<
  Effect.Effect<A, E, Extract<R, ActorLayerBuildContextExclusions>>,
  never,
  Exclude<R, ActorLayerBuildContextExclusions>
> =>
  Effect.context<Exclude<R, ActorLayerBuildContextExclusions>>().pipe(
    Effect.map((context) =>
      provideCapturedLayerBuildContext(build, omitLayerBuildContextExclusions(context)),
    ),
  );

/**
 * The layer-build context is captured wherever the actor layer is built. When
 * that happens inside another actor's handler (a nested composition root), the
 * fiber context carries that outer actor's `CurrentAddress`, runner address,
 * state registry, and scope. Those must not shadow the values the entity
 * manager provides to the handler build, or the inner actor would read the
 * outer entity's identity.
 */
function omitLayerBuildContextExclusions<R>(
  context: Context.Context<Exclude<R, ActorLayerBuildContextExclusions>>,
): Context.Context<Exclude<R, ActorLayerBuildContextExclusions>>;
function omitLayerBuildContextExclusions<R>(
  context: Context.Context<Exclude<R, ActorLayerBuildContextExclusions>>,
): unknown {
  return Context.omit(
    Scope.Scope,
    CurrentAddress,
    CurrentRunnerAddress,
    ActorStateRegistry,
  )(context);
}

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

export type StateOf<S extends ActorStateDef | void> = S extends {
  readonly schema: infer Sch extends Schema.Top;
}
  ? Schema.Schema.Type<Sch>
  : unknown;

export type StateErrorOf<S extends ActorStateDef | void> = S extends {
  readonly error: infer E extends Schema.Top;
}
  ? Schema.Schema.Type<E>
  : never;

export interface FromEntityOptions<S extends ActorStateDef | void = void> {
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
   * 4. The default poll interval is 200ms;
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
    Client
  >;
  readonly executionId: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<ExecId<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>>;
  readonly peek: (
    payload: PayloadInput<C>,
  ) => Effect.Effect<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    Client
  >;
  readonly watch: (
    payload: PayloadInput<C>,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<
    PeekResult<Schema.Schema.Type<SuccessOf<C>>, Schema.Schema.Type<ErrorOf<C>>>,
    PersistenceError | MalformedMessage,
    Client
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
    Client
  >;
  readonly rerun: (payload: PayloadInput<C>) => Effect.Effect<void, PersistenceError, Client>;
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
    ) => <Value>(value: Value) => value is Value & OperationValue<Name, Tag, Defs[Tag]>;
  };

// ── Compile runtime ────────────────────────────────────────────────────────

/* oxlint-disable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening, effect/noUnknownParameters, effect/noUnsafeDictionaryType -- This compiler erases schema-specific RPC types once and restores the public generic actor interface through overloads. */

// ── peek — internal implementation ───────────────────────────────────────
//
// The outgoing request compiler, the test-mailbox
// router (`makeTestMailboxImpl`), the address helper (`resolveEntityAddress`),
// and the `flush`/`redeliver` storage ops all moved INSIDE the `Client` seam
// (`client.ts`, ADR-0002). `actor.ts` imports the ones it still needs
// directly (`resolveEntityAddress` for the state/rerun ops) and routes
// dispatch + control through the `Client` Tag.

// ── rerun — surgical per-invocation deletion ──────────────────────────────

const peekImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  execId: string,
  definitions?: OperationDefs,
): Effect.Effect<PeekResult, PersistenceError | MalformedMessage, Client> =>
  Client.use((client) => client.peek(entity, execId, definitions));

// ── watch — internal implementation ──────────────────────────────────────

const watchImpl = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs type erased
  entity: ClusterEntity.Entity<string, any>,
  execId: string,
  definitions?: OperationDefs,
  options?: { readonly interval?: Duration.Input },
): Stream.Stream<PeekResult, PersistenceError | MalformedMessage, Client> =>
  watchExecution(peekImpl(entity, execId, definitions), options);

// ── Actor.fromEntity ──────────────────────────────────────────────────────

const fromEntity = <
  const Name extends string,
  const Defs extends OperationDefs,
  const StateDef extends ActorStateDef | void = void,
>(
  name: Name,
  definitions: AssertNoReservedKeys<Defs>,
  options?: FromEntityOptions<StateDef>,
): EntityActor<Name, Defs, StateOf<StateDef>, StateErrorOf<StateDef>> => {
  for (const tag of Object.keys(definitions)) {
    if (RESERVED_KEYS.has(tag)) {
      // oxlint-disable-next-line effect/noThrowStatement -- This synchronous builder must reject invalid definitions at module initialization.
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
    <Value>(value: Value): boolean =>
      Predicate.hasProperty(value, "_tag") && value["_tag"] === tag;

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

  const stateSchema = Option.fromNullishOr(options?.state?.schema);
  const errorSchema = Option.fromNullishOr(options?.state?.error);
  const decodeState = (raw: unknown): Effect.Effect<unknown, unknown> => {
    if (Option.isNone(stateSchema)) return Effect.succeed(raw);
    return Schema.decodeUnknownEffect(stateSchema.value)(raw) as Effect.Effect<unknown, unknown>;
  };
  const decodeFailure = (cause: unknown): Effect.Effect<never, unknown> => {
    // No error schema, or a nullish cause, passes straight through undecoded.
    if (Option.isNone(errorSchema) || Option.isNone(Option.fromNullishOr(cause))) {
      return Effect.fail(cause);
    }
    const decoded = Schema.decodeEffect(errorSchema.value)(cause) as Effect.Effect<
      unknown,
      unknown
    >;
    return Effect.flatMap(decoded, (value) => Effect.fail(value));
  };
  const stateObservation = makeActorStateObservation({ decodeState, decodeFailure });

  const stateAddress = (entityId: string, stateOptions?: ActorStateOptions<unknown, unknown>) =>
    Effect.gen(function* () {
      const materialize = Option.fromNullishOr(stateOptions?.materialize);
      if (Option.isSome(materialize)) {
        yield* materialize.value;
      } else {
        yield* activateFn(entityId);
      }
      const resolver = yield* ActorAddressResolver;
      return resolveEntityAddress(resolver, entityAny, entityId);
    });

  const getStateFn = (
    entityId: string,
    stateOptions?: ActorStateOptions<unknown, unknown>,
  ): Effect.Effect<
    unknown,
    unknown,
    ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs> | unknown
  > => Effect.flatMap(stateAddress(entityId, stateOptions), stateObservation.get);

  const watchStateFn = (
    entityId: string,
    stateOptions?: ActorStateOptions<unknown, unknown>,
  ): Stream.Stream<
    unknown,
    unknown,
    ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs> | unknown
  > => Stream.unwrap(Effect.map(stateAddress(entityId, stateOptions), stateObservation.watch));

  const waitForStateFn = (
    entityId: string,
    predicate: (state: unknown) => boolean,
    stateOptions?: ActorStateOptions<unknown, unknown>,
  ): Effect.Effect<
    unknown,
    unknown,
    ActorAddressResolver | ActorStateRegistry | ActorClientService<Name, Defs> | unknown
  > =>
    Effect.flatMap(stateAddress(entityId, stateOptions), (address) =>
      stateObservation.waitFor(address, predicate),
    );

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
          waitForExecution(peekImpl(entityAny, eid, definitions), {
            schedule: options.schedule,
          }),
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
      waitForExecution(
        peekImpl(entityAny, invocationOf(payload).identity.execId, definitions),
        options as never,
      )) as never,
    rerun: ((payload: unknown) =>
      Client.use((client) => client.deleteInvocation(invocationOf(payload)))) as never,
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
  const buildOption = Option.fromNullishOr(build);
  if (isCompiledWorkflowActor(actor) && Option.isSome(buildOption)) {
    return compiledWorkflowToLayer(actor, buildOption.value as Function);
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

  if (Option.isNone(buildOption)) {
    const baseLayer = Layer.merge(clientLayer, consumerSupportLayers);
    return assembleActorRuntime(baseLayer, stateLayer, controlLayer);
  }

  const transformed = transformHandlers(buildOption.value, actorDefinitions, options?.withScope);
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
  if (isCompiledWorkflowActor(actor)) {
    return compiledWorkflowToTestLayer(actor, build as Function);
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

      const mailboxImpl: ActorMailboxService = makeTestMailboxImpl(makeClient);

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

const provideHandlerContext = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  context: Context.Context<R>,
): Effect.Effect<A, E> => Effect.provide(body, context);

const transformHandlers = (
  build: unknown,
  definitions?: OperationDefs,
  withScope?: (
    address: EntityAddress.EntityAddress,
  ) => Effect.Effect<Context.Context<unknown>, unknown, unknown>,
): unknown => {
  if (Predicate.isObject(build) && !Effect.isEffect(build)) {
    const handlers = build as Record<string, Function>;
    const transformed: Record<string, Function> = {};
    if (Option.isSome(Option.fromNullishOr(definitions?.[ACTIVATE_TAG]))) {
      transformed[ACTIVATE_TAG] = () => Effect.void;
    }
    for (const tag of Object.keys(handlers)) {
      const handler = handlers[tag];
      if (!handler) continue;
      const def = Option.fromNullishOr(definitions?.[tag]);
      const payload = Option.flatMap(def, (value) => Option.fromNullishOr(value.payload));
      const opaque = Option.isSome(payload) && isOpaquePayload(payload.value);
      transformed[tag] = (request: Record<string, unknown>) => {
        const raw = request["payload"];
        const buildOperation = (): Record<string, unknown> => {
          if (opaque) return { _tag: tag, _payload: unwrapOpaquePayload(raw) };
          return { _tag: tag, ...((raw ?? {}) as object) };
        };
        const operation = buildOperation();
        const body = handler({ operation, request }) as Effect.Effect<unknown, unknown, unknown>;
        const scope = Option.fromNullishOr(withScope);
        if (Option.isNone(scope)) return body;
        return Effect.gen(function* () {
          const address = yield* CurrentAddress;
          const context = yield* scope.value(address);
          return yield* provideHandlerContext(body, context);
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
  const boundContextOption = Option.fromNullishOr(boundContext);

  const bind = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    if (Option.isNone(boundContextOption)) return effect;
    return Effect.context<never>().pipe(
      Effect.flatMap((currentContext) =>
        Effect.provideContext(effect, Context.merge(boundContextOption.value, currentContext)),
      ),
    ) as Effect.Effect<A, E, R>;
  };

  const rpcArg = (
    op: { readonly _tag: string; readonly [key: string]: unknown },
    def: OperationDef | void,
  ): Option.Option<unknown> => {
    const payload = Option.fromNullishOr(def?.payload);
    if (Option.isNone(payload)) return Option.none();
    if (isOpaquePayload(payload.value)) return Option.some(op["_payload"]);
    return Option.some(op);
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
      const def = definitions[tag] as OperationDef | void;
      const arg = rpcArg(op, def);
      const call = (): unknown => {
        if (Option.isSome(arg)) return fn(arg.value);
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
      const def = definitions[tag] as OperationDef | void;
      const arg = rpcArg(op, def);
      const dispatchDiscarded = (): unknown => {
        if (Option.isSome(arg)) return fn(arg.value, { discard: true });
        return fn(Schema.Void.make(), { discard: true });
      };
      const discarded = dispatchDiscarded();
      let discardCall = Effect.void as Effect.Effect<unknown, unknown, unknown>;
      if (Effect.isEffect(discarded)) discardCall = discarded;
      const pkInput = payloadFromOperation(def, op);
      const { primaryKey } = resolveId(def, pkInput, tag);
      const execId = ExecIdCodec.encode({ entityId: _entityId, tag, primaryKey });
      return bind(Effect.map(discardCall, () => execId));
    },
  } as ActorRef<Name, Defs>;
};

/* oxlint-enable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening, effect/noUnknownParameters, effect/noUnsafeDictionaryType */

// ── Escape hatch: raw Rpc definitions ──────────────────────────────────────

/* oxlint-disable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening -- Raw Rpc and protocol transforms preserve upstream generic evidence through this explicit escape hatch. */

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
    state: State.ReadableState<A, Error, Requirements>,
  ) => Effect.Effect<void, never, ActorStateRegistry | CurrentAddress | Scope.Scope | Requirements>,
  entityIdCodec,
  State,
  Client,
  ClientLayer,
  fromEntity,
  fromWorkflow: compileWorkflowActor,
  fromRpcs,
  provideLayerBuildContext,
  withProtocol,
  toLayer,
  toTestLayer,
  isEntity,
  isWorkflow,
} as const;

/* oxlint-enable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening, effect/noUnknownParameters, effect/noUnsafeDictionaryType */
