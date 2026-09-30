/* oxlint-disable effect/noAs, effect/noChainedTypeAssertions, effect/noKnownValueWidening, effect/noUnknownParameters, effect/noUnsafeDictionaryType -- This module is the single erased boundary between upstream Workflow runtime types and Encore's schema-derived actor interface. */
/* eslint-disable typescript-eslint/no-explicit-any -- upstream Workflow and Rpc dispatch are erased at this compiler boundary */
import type { PersistenceError } from "effect/cluster/ClusterError";
import { Workflow as UpstreamWorkflow } from "effect/workflow";
import {
  WorkflowEngine,
  layerMemory as workflowEngineLayerMemory,
} from "effect/workflow/WorkflowEngine";
import type { Duration, Schedule, Schema } from "effect";
import { Cause, Context, Effect, Layer, Option, Predicate, Stream } from "effect";
import { ActorDefect } from "../actor-defect.js";
import { Client } from "../client.js";
import { Pending, Suspended, makeExecId, mapExitToWorkflowPeekResult } from "../receipt.js";
import type { ExecId, PeekResult } from "../receipt.js";
import {
  decideCompensation,
  decidePendingCompensation,
  makeSignal,
  makeWorkflowExecution,
  pendingCompensation,
} from "../step.js";
import type {
  CompensationDecision,
  CompensationDecisionError,
  PendingCompensation,
  SignalDefs,
  WorkflowSignal,
} from "../step.js";
import { waitFor, watch } from "./execution-observation.js";
import type { ActorClientFactory, ActorClientService, ActorRef, OperationBrand } from "../actor.js";
import type { EntityIdReturn } from "./invocation-compiler.js";

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

// ── Workflow types ────────────────────────────────────────────────────────

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

export type WorkflowPayloadType<Payload extends Schema.Struct.Fields> = {
  readonly [K in keyof Payload]: Schema.Schema.Type<
    Payload[K] extends Schema.Top ? Payload[K] : never
  >;
};

export type WorkflowRunDefs<
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
   * completed) with the Client lifecycle operation (wipes run reply +
   * cached activity replies stored at the workflow's `EntityAddress`).
   *
   * Caveat: rerun-while-running interrupts the fiber and clears state, but
   * cleanup is best-effort eventual — the next `.execute(samePayload)` may
   * queue behind the interrupted fiber's wind-down. No data corruption, just
   * transient ordering.
   */
  readonly rerun: (
    payload: WorkflowPayloadType<Payload>,
  ) => Effect.Effect<void, PersistenceError, Client | WorkflowEngine>;
  /** Remove one completed workflow execution and its durable clock state. */
  readonly prune: (executionId: string) => Effect.Effect<void, PersistenceError, Client>;
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
    ) => Effect.Effect<void, CompensationDecisionError, WorkflowReadServices<Success, Error>>;
    readonly decidePending: (
      executionId: string,
      decision: CompensationDecision,
    ) => Effect.Effect<void, CompensationDecisionError, WorkflowReadServices<Success, Error>>;
    readonly retry: (
      executionId: string,
      stepId: string,
      attempt: number,
    ) => Effect.Effect<void, CompensationDecisionError, WorkflowReadServices<Success, Error>>;
    readonly stop: (
      executionId: string,
      stepId: string,
      attempt: number,
    ) => Effect.Effect<void, CompensationDecisionError, WorkflowReadServices<Success, Error>>;
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
  readonly $is: (tag: "Run") => <Value>(value: Value) => boolean;
};

export const compileWorkflowActor = <
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
    idempotencyKey: def.id,
  };
  if (def.success) workflowOptions["success"] = def.success;
  if (def.error) workflowOptions["error"] = def.error;
  if (def.suspendedRetrySchedule)
    workflowOptions["suspendedRetrySchedule"] = def.suspendedRetrySchedule;

  let workflow = (UpstreamWorkflow.make as Function)(
    name,
    workflowOptions,
  ) as UpstreamWorkflow.Workflow<Name, Schema.Struct<Payload>, Success, Error>;
  const captureDefects = Option.fromNullishOr(def.captureDefects);
  if (Option.isSome(captureDefects))
    workflow = workflow.annotate(UpstreamWorkflow.CaptureDefects, captureDefects.value);
  const suspendOnFailure = Option.fromNullishOr(def.suspendOnFailure);
  if (Option.isSome(suspendOnFailure))
    workflow = workflow.annotate(UpstreamWorkflow.SuspendOnFailure, suspendOnFailure.value);

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

  const signals: Record<string, WorkflowSignal<any, any, any>> = {};
  for (const [signalName, signalDef] of Object.entries(def.signals ?? {})) {
    if (WORKFLOW_RESERVED_KEYS.has(signalName)) {
      // oxlint-disable-next-line effect/noThrowStatement -- The synchronous compiler must reject invalid definitions at module initialization.
      throw new ActorDefect({
        message: `effect-encore: signal "${signalName}" collides with reserved property on workflow "${name}". Reserved: ${[...WORKFLOW_RESERVED_KEYS].join(", ")}`,
      });
    }
    signals[signalName] = makeSignal(workflow, signalName, {
      success: signalDef.success,
      error: signalDef.error,
    });
  }

  const executionIdFor = (payload: WorkflowPayloadType<Payload>): Effect.Effect<string> =>
    workflow.executionId(payload as never);

  type RawPeek = WorkflowPeekResult<Success, Error>;

  const peekAt = (
    executionId: string,
  ): Effect.Effect<RawPeek, never, WorkflowReadServices<Success, Error>> =>
    Effect.map(workflow.poll(executionId), (result) =>
      Option.match(result, {
        onNone: () => Pending,
        onSome: (value) => {
          if (value._tag === "Suspended") return Suspended;
          return mapExitToWorkflowPeekResult(value.exit);
        },
      }),
    );

  const watchAt = (executionId: string, options?: { readonly interval?: Duration.Input }) =>
    watch(peekAt(executionId), options);

  const waitForAt = (
    executionId: string,
    options?: {
      readonly filter?: (result: RawPeek) => boolean;
      readonly schedule?: Schedule.Schedule<any, unknown>;
    },
  ) => waitFor(peekAt(executionId), options);

  const compensation = {
    pending: (executionId: string) => pendingCompensation(workflow, executionId),
    decide: (
      executionId: string,
      stepId: string,
      attempt: number,
      decision: CompensationDecision,
    ) => decideCompensation(workflow, executionId, stepId, attempt, decision),
    decidePending: (executionId: string, decision: CompensationDecision) =>
      decidePendingCompensation(workflow, executionId, decision),
    retry: (executionId: string, stepId: string, attempt: number) =>
      decideCompensation(workflow, executionId, stepId, attempt, "Retry"),
    stop: (executionId: string, stepId: string, attempt: number) =>
      decideCompensation(workflow, executionId, stepId, attempt, "Stop"),
  };

  const signal = <
    S extends Schema.Top = typeof Schema.Void,
    E extends Schema.Top = typeof Schema.Never,
  >(
    signalName: string,
    options?: { readonly success?: S; readonly error?: E },
  ): WorkflowSignal<Schema.Struct<Payload>, S, E> => makeSignal(workflow, signalName, options);

  const prune = (executionId: string) =>
    Client.use((client) => client.pruneWorkflow(workflow, executionId));

  const rerun = (
    payload: WorkflowPayloadType<Payload>,
  ): Effect.Effect<void, PersistenceError, Client | WorkflowEngine> =>
    Effect.gen(function* () {
      const executionId = yield* executionIdFor(payload);
      yield* workflow.interrupt(executionId);
      yield* prune(executionId);
    });

  const execute = (payload: WorkflowPayloadType<Payload>) =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      const executionId = yield* executionIdFor(payload);
      const ref = yield* factory(executionId);
      return yield* ref.execute(make(payload) as never);
    }) as unknown as Effect.Effect<
      Schema.Schema.Type<Success>,
      Schema.Schema.Type<Error>,
      ActorClientService<Name, WfDefs>
    >;

  const send = (payload: WorkflowPayloadType<Payload>) =>
    Effect.gen(function* () {
      const factory = yield* contextTag;
      const executionId = yield* executionIdFor(payload);
      const ref = yield* factory(executionId);
      return yield* ref.send(make(payload) as never);
    }) as unknown as Effect.Effect<
      ExecId<Schema.Schema.Type<Success>, Schema.Schema.Type<Error>>,
      never,
      ActorClientService<Name, WfDefs>
    >;

  return {
    ...signals,
    _tag: "WorkflowActor",
    name,
    type: `Workflow/${name}`,
    _meta: { name, workflow },
    Context: contextTag,
    signal,
    execute,
    send,
    executionId: (payload: WorkflowPayloadType<Payload>) =>
      Effect.map(workflow.executionId(payload as never), makeExecId),
    peek: (payload: WorkflowPayloadType<Payload>) =>
      Effect.flatMap(executionIdFor(payload), peekAt),
    peekAt,
    watch: (
      payload: WorkflowPayloadType<Payload>,
      options?: { readonly interval?: Duration.Input },
    ) =>
      Stream.unwrap(
        Effect.map(executionIdFor(payload), (executionId) => watchAt(executionId, options)),
      ),
    watchAt,
    waitFor: (
      payload: WorkflowPayloadType<Payload>,
      options?: {
        readonly filter?: (result: RawPeek) => boolean;
        readonly schedule?: Schedule.Schedule<any, unknown>;
      },
    ) => Effect.flatMap(executionIdFor(payload), (executionId) => waitForAt(executionId, options)),
    waitForAt,
    rerun,
    prune,
    interrupt: (executionId: string) => workflow.interrupt(executionId),
    resume: (executionId: string) => workflow.resume(executionId),
    compensation,
    make,
    $is: (tag: "Run") => (value: unknown) =>
      Predicate.hasProperty(value, "_tag") && value["_tag"] === tag,
  } as unknown as WorkflowActor<Name, Payload, Success, Error, Signals>;
};

export const isWorkflowActor = <Value>(actor: Value): boolean =>
  Predicate.hasProperty(actor, "_tag") && actor["_tag"] === "WorkflowActor";

const buildWorkflowActorRef = (
  actor: WorkflowActor<any, any, any, any>,
  engine: WorkflowEngine["Service"],
): ActorRef<any, any> => {
  const workflow = actor._meta.workflow;
  return {
    execute: (operation: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = operation;
      return workflow.execute(payload as any).pipe(Effect.provideService(WorkflowEngine, engine));
    },
    send: (operation: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const { _tag: _, ...payload } = operation;
      return Effect.map(
        workflow
          .execute(payload as any, { discard: true })
          .pipe(Effect.provideService(WorkflowEngine, engine)) as Effect.Effect<string>,
        makeExecId,
      );
    },
  } as ActorRef<any, any>;
};

const wrapWorkflowHandler = (actor: WorkflowActor<any, any, any, any>, handler: Function) => {
  const workflow = actor._meta.workflow;
  return (payload: any, executionId: string) => {
    const execution = makeWorkflowExecution(workflow, executionId);
    return Effect.catchCause(handler(payload, execution.step), (cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return execution.compensate(cause).pipe(Effect.andThen(Effect.failCause(cause)));
    });
  };
};

const layerPassthrough = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut | RIn, E, RIn> =>
  Layer.merge(Layer.effectContext(Effect.context<RIn>()), layer);

const makeWorkflowClientLayer = (actor: WorkflowActor<any, any, any, any>) =>
  Layer.effect(
    actor.Context,
    Effect.map(WorkflowEngine, (engine) => {
      const ref = buildWorkflowActorRef(actor, engine);
      return (_entityId: string) => Effect.succeed(ref);
    }),
  );

export const workflowToLayer = (
  actor: WorkflowActor<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const handlerLayer = actor._meta.workflow.toLayer(wrapWorkflowHandler(actor, handler) as any);
  const clientLayer = makeWorkflowClientLayer(actor);
  return layerPassthrough(Layer.merge(handlerLayer, clientLayer));
};

export const workflowToTestLayer = (
  actor: WorkflowActor<any, any, any, any>,
  handler: Function,
): Layer.Layer<any, any, any> => {
  const handlerLayer = actor._meta.workflow.toLayer(wrapWorkflowHandler(actor, handler) as any);
  const clientLayer = makeWorkflowClientLayer(actor);
  return Layer.provideMerge(Layer.merge(handlerLayer, clientLayer), workflowEngineLayerMemory);
};
