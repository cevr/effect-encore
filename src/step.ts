/* eslint-disable typescript-eslint/no-explicit-any -- workflow types require open `any` for Effect requirements */
import {
  Workflow as UpstreamWorkflow,
  Activity as UpstreamActivity,
  DurableDeferred as UpstreamDeferred,
  DurableClock as UpstreamClock,
} from "effect/unstable/workflow";
import { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
import type { Cause, Duration, Exit, Scope } from "effect";
import {
  Array as Arr,
  Cause as CauseModule,
  Effect,
  Exit as ExitModule,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";

// ── WorkflowSignalToken ─────────────────────────────────────────────────

export type WorkflowSignalToken = UpstreamDeferred.Token;

// ── WorkflowSignal ──────────────────────────────────────────────────────

export interface WorkflowSignal<
  Payload extends UpstreamWorkflow.AnyStructSchema,
  S extends Schema.Top = typeof Schema.Void,
  E extends Schema.Top = typeof Schema.Never,
> {
  readonly name: string;
  readonly deferred: UpstreamDeferred.DurableDeferred<S, E>;
  readonly await: Effect.Effect<
    S["Type"],
    E["Type"],
    WorkflowEngine | WorkflowInstance | S["DecodingServices"] | E["DecodingServices"]
  >;
  readonly token: Effect.Effect<WorkflowSignalToken, never, WorkflowInstance>;
  readonly tokenFromExecutionId: (executionId: string) => WorkflowSignalToken;
  readonly tokenFromPayload: (
    payload: Payload["~type.make.in"],
  ) => Effect.Effect<WorkflowSignalToken>;
  readonly succeedAt: (
    executionId: string,
    value: S["Type"],
  ) => Effect.Effect<void, never, WorkflowEngine | S["EncodingServices"]>;
  readonly failAt: (
    executionId: string,
    error: E["Type"],
  ) => Effect.Effect<void, never, WorkflowEngine | E["EncodingServices"]>;
  readonly succeed: (opts: {
    token: WorkflowSignalToken;
    value: S["Type"];
  }) => Effect.Effect<void, never, WorkflowEngine | S["EncodingServices"]>;
  readonly fail: (opts: {
    token: WorkflowSignalToken;
    error: E["Type"];
  }) => Effect.Effect<void, never, WorkflowEngine | E["EncodingServices"]>;
  readonly failCause: (opts: {
    token: WorkflowSignalToken;
    cause: Cause.Cause<E["Type"]>;
  }) => Effect.Effect<void, never, WorkflowEngine | E["EncodingServices"]>;
  readonly done: (opts: {
    token: WorkflowSignalToken;
    exit: Exit.Exit<S["Type"], E["Type"]>;
  }) => Effect.Effect<void, never, WorkflowEngine | S["EncodingServices"] | E["EncodingServices"]>;
  readonly into: <R>(
    effect: Effect.Effect<S["Type"], E["Type"], R>,
  ) => Effect.Effect<
    S["Type"],
    E["Type"],
    R | WorkflowEngine | WorkflowInstance | S["DecodingServices"] | E["DecodingServices"]
  >;
}

// ── Signal definition types ────────────────────────────────────────────

export interface SignalDef<
  S extends Schema.Top = typeof Schema.Void,
  E extends Schema.Top = typeof Schema.Never,
> {
  readonly success?: S;
  readonly error?: E;
}

export type SignalDefs = Record<string, SignalDef<Schema.Top, Schema.Top>>;

// ── Step run options ────────────────────────────────────────────────────

export interface StepRunOptions<
  S extends Schema.Top = typeof Schema.Void,
  E extends Schema.Top = typeof Schema.Never,
  R = never,
  R2 = never,
  WE = never,
> {
  readonly do: Effect.Effect<S["Type"], E["Type"], R>;
  readonly undo?: (value: S["Type"], cause: Cause.Cause<WE>) => Effect.Effect<void, WE, R2>;
  readonly success?: S;
  readonly error?: E;
  readonly retry?: { readonly times: number };
}

// ── WorkflowStepContext ─────────────────────────────────────────────────

export interface WorkflowStepContext<WorkflowError extends Schema.Top> {
  readonly executionId: string;

  readonly run: {
    // Full options
    <
      S extends Schema.Top = typeof Schema.Void,
      E extends Schema.Top = typeof Schema.Never,
      R = never,
      R2 = never,
    >(
      id: string,
      options: StepRunOptions<S, E, R, R2, WorkflowError["Type"]>,
    ): Effect.Effect<
      S["Type"],
      E["Type"],
      | S["DecodingServices"]
      | E["DecodingServices"]
      | Exclude<R, WorkflowInstance | WorkflowEngine | Scope.Scope>
      | R2
      | WorkflowEngine
      | WorkflowInstance
    >;

    // Shorthand with undo — infallible only
    <A, R, R2>(
      id: string,
      execute: Effect.Effect<A, never, R>,
      undo: (
        value: A,
        cause: Cause.Cause<WorkflowError["Type"]>,
      ) => Effect.Effect<void, WorkflowError["Type"], R2>,
    ): Effect.Effect<
      A,
      never,
      | Exclude<R, WorkflowInstance | WorkflowEngine | Scope.Scope>
      | R2
      | WorkflowEngine
      | WorkflowInstance
    >;

    // Shorthand — infallible only
    <A, R>(
      id: string,
      execute: Effect.Effect<A, never, R>,
    ): Effect.Effect<
      A,
      never,
      | Exclude<R, WorkflowInstance | WorkflowEngine | Scope.Scope>
      | WorkflowEngine
      | WorkflowInstance
    >;
  };

  readonly sleep: (
    id: string,
    duration: Duration.Input,
    options?: { readonly inMemoryThreshold?: Duration.Input },
  ) => Effect.Effect<void, never, WorkflowEngine | WorkflowInstance>;

  readonly race: <
    const Steps extends Arr.NonEmptyReadonlyArray<{
      readonly name: string;
      readonly execute: Effect.Effect<any, any, any>;
      readonly success?: Schema.Top;
      readonly error?: Schema.Top;
    }>,
  >(
    id: string,
    steps: Steps,
  ) => Effect.Effect<
    Effect.Success<Steps[number]["execute"]>,
    Effect.Error<Steps[number]["execute"]>,
    Effect.Services<Steps[number]["execute"]> | WorkflowEngine | WorkflowInstance
  >;

  readonly raceSignals: <S extends Schema.Top, E extends Schema.Top>(
    name: string,
    options: {
      readonly success: S;
      readonly error: E;
      readonly effects: Arr.NonEmptyReadonlyArray<Effect.Effect<S["Type"], E["Type"], any>>;
    },
  ) => Effect.Effect<
    S["Type"],
    E["Type"],
    | WorkflowEngine
    | WorkflowInstance
    | S["DecodingServices"]
    | S["EncodingServices"]
    | E["DecodingServices"]
    | E["EncodingServices"]
  >;

  readonly idempotencyKey: (
    name: string,
    options?: { readonly includeAttempt?: boolean },
  ) => Effect.Effect<string, never, WorkflowInstance>;

  readonly attempt: Effect.Effect<number>;
  readonly suspend: Effect.Effect<never, never, WorkflowInstance>;
  readonly scope: Effect.Effect<Scope.Scope, never, WorkflowInstance>;
  readonly provideScope: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Scope.Scope> | WorkflowInstance>;
  readonly addFinalizer: <R>(
    f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, WorkflowInstance | R>;
}

export interface WorkflowExecution<WorkflowError extends Schema.Top> {
  readonly step: WorkflowStepContext<WorkflowError>;
  readonly compensate: (
    cause: Cause.Cause<WorkflowError["Type"]>,
  ) => Effect.Effect<
    void,
    never,
    | WorkflowEngine
    | WorkflowInstance
    | WorkflowError["DecodingServices"]
    | WorkflowError["EncodingServices"]
  >;
}

export type CompensationDecision = "Retry" | "Stop";

export const CompensationDecision = Schema.Literals(["Retry", "Stop"]);

export class PendingCompensation extends Schema.Class<PendingCompensation>(
  "effect-encore/PendingCompensation",
)({
  stepId: Schema.String,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

export class CompensationNotPendingError extends Schema.TaggedError<CompensationNotPendingError>()(
  "CompensationNotPendingError",
  {},
) {}

export class CompensationDecisionConflictError extends Schema.TaggedError<CompensationDecisionConflictError>()(
  "CompensationDecisionConflictError",
  {
    stepId: Schema.String,
    attempt: Schema.Finite,
    acceptedDecision: Schema.Option(CompensationDecision),
  },
) {}

export type CompensationDecisionError =
  | CompensationNotPendingError
  | CompensationDecisionConflictError;

const CompensationPlan = Schema.Array(Schema.String);
const compensationPlan = UpstreamDeferred.make("CompensationPlan", {
  success: CompensationPlan,
});

const encodeCompensationActivityName = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Literals(["Compensate"]), Schema.String])),
);

const encodeCompensationDecisionName = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Literals(["CompensationDecision"]), Schema.String, Schema.Finite]),
  ),
);

const encodeCompensationFailureName = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Literals(["CompensationFailure"]), Schema.String, Schema.Finite]),
  ),
);

const encodeSignalName = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Literals(["Signal"]), Schema.String])),
);

const compensationActivityName = (stepId: string): string =>
  encodeCompensationActivityName(["Compensate", stepId]);

// Activity storage adds CurrentAttempt to its key. Durable Deferred storage
// does not. The decision name must carry the attempt.
const compensationDecision = (stepId: string, attempt: number) =>
  UpstreamDeferred.make(encodeCompensationDecisionName(["CompensationDecision", stepId, attempt]), {
    success: CompensationDecision,
  });

const compensationFailure = (stepId: string, attempt: number) =>
  UpstreamDeferred.make(encodeCompensationFailureName(["CompensationFailure", stepId, attempt]), {
    success: PendingCompensation,
  });

const readDeferredAt = <S extends Schema.Constraint>(
  workflow: UpstreamWorkflow.Any,
  executionId: string,
  deferred: UpstreamDeferred.DurableDeferred<S>,
): Effect.Effect<Option.Option<S["Type"]>, never, WorkflowEngine> =>
  WorkflowEngine.pipe(
    Effect.flatMap((engine) =>
      engine
        .deferredResult(deferred)
        .pipe(
          Effect.provideService(WorkflowInstance, WorkflowInstance.initial(workflow, executionId)),
        ),
    ),
    Effect.map(
      Option.flatMap((exit) => {
        if (ExitModule.isSuccess(exit)) return Option.some(exit.value);
        return Option.none();
      }),
    ),
  );

const pendingForStep = (
  workflow: UpstreamWorkflow.Any,
  executionId: string,
  stepId: string,
  attempt: number,
): Effect.Effect<Option.Option<PendingCompensation>, never, WorkflowEngine> =>
  readDeferredAt(workflow, executionId, compensationFailure(stepId, attempt)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (pending) =>
          readDeferredAt(workflow, executionId, compensationDecision(stepId, attempt)).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedSome(pending),
                onSome: (decision) => {
                  if (decision === "Stop") return Effect.succeedNone;
                  return pendingForStep(workflow, executionId, stepId, attempt + 1);
                },
              }),
            ),
          ),
      }),
    ),
  );

/** Read the exact failed compensation attempt that awaits an operator decision. */
export const pendingCompensation = <
  Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  workflow: UpstreamWorkflow.Workflow<Name, Payload, Success, Error>,
  executionId: string,
): Effect.Effect<
  Option.Option<PendingCompensation>,
  never,
  WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  workflow.poll(executionId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (result) => {
          if (result._tag === "Complete") return Effect.succeedNone;
          return readDeferredAt(workflow, executionId, compensationPlan).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (plan) =>
                  Effect.reduce(
                    plan,
                    () => Option.none<PendingCompensation>(),
                    (pending, stepId) => {
                      if (Option.isSome(pending)) return Effect.succeed(pending);
                      return pendingForStep(workflow, executionId, stepId, 1);
                    },
                  ),
              }),
            ),
          );
        },
      }),
    ),
  );

const commitCompensationDecision = (
  workflow: UpstreamWorkflow.Any,
  executionId: string,
  stepId: string,
  attempt: number,
  decision: CompensationDecision,
): Effect.Effect<void, CompensationDecisionConflictError, WorkflowEngine> =>
  Effect.gen(function* () {
    const deferred = compensationDecision(stepId, attempt);
    const accepted = yield* readDeferredAt(workflow, executionId, deferred);
    if (Option.isSome(accepted)) {
      if (accepted.value === decision) return;
      return yield* CompensationDecisionConflictError.make({
        stepId,
        attempt,
        acceptedDecision: accepted,
      });
    }

    const token = UpstreamDeferred.tokenFromExecutionId(deferred, { workflow, executionId });
    yield* UpstreamDeferred.succeed(deferred, { token, value: decision });
    const awaitAccepted = (): Effect.Effect<CompensationDecision, never, WorkflowEngine> =>
      readDeferredAt(workflow, executionId, deferred).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(awaitAccepted))),
            onSome: Effect.succeed,
          }),
        ),
      );
    const winner = yield* awaitAccepted();
    if (winner === decision) return;
    return yield* CompensationDecisionConflictError.make({
      stepId,
      attempt,
      acceptedDecision: Option.some(winner),
    });
  });

/**
 * Persist an operator decision for the exact pending compensation attempt.
 *
 * This waits until the cluster exposes the durable winning decision. Apply
 * `Effect.timeout` at the application boundary when the request needs a bound.
 */
export const decideCompensation = <
  Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  workflow: UpstreamWorkflow.Workflow<Name, Payload, Success, Error>,
  executionId: string,
  stepId: string,
  attempt: number,
  decision: CompensationDecision,
): Effect.Effect<
  void,
  CompensationDecisionError,
  WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.gen(function* () {
    const pending = yield* pendingCompensation(workflow, executionId);
    if (Option.isNone(pending)) {
      const accepted = yield* readDeferredAt(
        workflow,
        executionId,
        compensationDecision(stepId, attempt),
      );
      if (Option.isNone(accepted)) return yield* CompensationNotPendingError.make();
      if (accepted.value === decision) return;
      return yield* CompensationDecisionConflictError.make({
        stepId,
        attempt,
        acceptedDecision: accepted,
      });
    }
    if (pending.value.stepId !== stepId || pending.value.attempt !== attempt) {
      return yield* CompensationDecisionConflictError.make({
        stepId,
        attempt,
        acceptedDecision: Option.none(),
      });
    }
    return yield* commitCompensationDecision(workflow, executionId, stepId, attempt, decision);
  });

/** Persist a decision for the compensation attempt that is pending now. */
export const decidePendingCompensation = <
  Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  workflow: UpstreamWorkflow.Workflow<Name, Payload, Success, Error>,
  executionId: string,
  decision: CompensationDecision,
): Effect.Effect<
  void,
  CompensationDecisionError,
  WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.gen(function* () {
    const pending = yield* pendingCompensation(workflow, executionId);
    if (Option.isNone(pending)) return yield* CompensationNotPendingError.make();
    return yield* commitCompensationDecision(
      workflow,
      executionId,
      pending.value.stepId,
      pending.value.attempt,
      decision,
    );
  });

// ── makeSignal ──────────────────────────────────────────────────────────

export const makeSignal = <
  Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  WorkflowSuccess extends Schema.Top,
  WorkflowError extends Schema.Top,
  S extends Schema.Top = typeof Schema.Void,
  E extends Schema.Top = typeof Schema.Never,
>(
  wf: UpstreamWorkflow.Workflow<Name, Payload, WorkflowSuccess, WorkflowError>,
  name: string,
  options?: { readonly success?: S; readonly error?: E },
): WorkflowSignal<Payload, S, E> => {
  const deferred = UpstreamDeferred.make(encodeSignalName(["Signal", name]), {
    success: options?.success,
    error: options?.error,
  });

  return {
    name,
    deferred,
    await: UpstreamDeferred.await(deferred),
    token: UpstreamDeferred.token(deferred),
    tokenFromExecutionId: (executionId: string) =>
      UpstreamDeferred.tokenFromExecutionId(deferred, { workflow: wf, executionId }),
    tokenFromPayload: (payload: Payload["~type.make.in"]) =>
      UpstreamDeferred.tokenFromPayload(deferred, { workflow: wf, payload: payload as never }),
    succeedAt: (executionId, value) =>
      UpstreamDeferred.succeed(deferred, {
        token: UpstreamDeferred.tokenFromExecutionId(deferred, { workflow: wf, executionId }),
        value,
      }),
    failAt: (executionId, error) =>
      UpstreamDeferred.fail(deferred, {
        token: UpstreamDeferred.tokenFromExecutionId(deferred, { workflow: wf, executionId }),
        error,
      }),
    succeed: (opts) => UpstreamDeferred.succeed(deferred, opts),
    fail: (opts) => UpstreamDeferred.fail(deferred, opts),
    failCause: (opts) => UpstreamDeferred.failCause(deferred, opts),
    done: (opts) => UpstreamDeferred.done(deferred, opts),
    into: (effect) => UpstreamDeferred.into(effect, deferred),
  };
};

// ── makeWorkflowExecution ───────────────────────────────────────────────

export const makeWorkflowExecution = <
  Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  WorkflowError extends Schema.Top,
>(
  wf: UpstreamWorkflow.Workflow<Name, Payload, Schema.Top, WorkflowError>,
  executionId: string,
): WorkflowExecution<WorkflowError> => {
  const compensations: Array<{
    readonly stepId: string;
    readonly run: (
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<
      void,
      never,
      | WorkflowEngine
      | WorkflowInstance
      | WorkflowError["DecodingServices"]
      | WorkflowError["EncodingServices"]
    >;
  }> = [];

  // Workflow scope finalizers are uninterruptible. Keep compensation in the
  // workflow body so a failed undo can suspend on a Durable Deferred.
  const addCompensation = <A, E, R, R2>(
    stepId: string,
    activity: Effect.Effect<A, E, R>,
    undo: (
      value: A,
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<void, WorkflowError["Type"], R2>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R2>();
        const value = yield* restore(activity);
        compensations.push({
          stepId,
          run: (cause) =>
            runCompensation(
              stepId,
              value,
              cause,
              (result, workflowCause) => undo(result, workflowCause).pipe(Effect.provide(context)),
              1,
            ),
        });
        return value;
      }),
    );

  const runCompensation = <A>(
    stepId: string,
    value: A,
    workflowCause: Cause.Cause<WorkflowError["Type"]>,
    undo: (
      value: A,
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<void, WorkflowError["Type"]>,
    attempt: number,
  ): Effect.Effect<
    void,
    never,
    | WorkflowEngine
    | WorkflowInstance
    | WorkflowError["DecodingServices"]
    | WorkflowError["EncodingServices"]
  > => {
    const execute = undo(value, workflowCause).pipe(
      Effect.tapCause((cause) => {
        if (CauseModule.hasInterrupts(cause)) return Effect.void;
        return Effect.logError("Workflow compensation failed.", cause).pipe(
          Effect.annotateLogs({ executionId, stepId, attempt }),
        );
      }),
    );
    const activity = UpstreamActivity.make({
      name: compensationActivityName(stepId),
      execute,
      error: wf.errorSchema,
    }).pipe(Effect.provideService(UpstreamActivity.CurrentAttempt, attempt));

    return activity.pipe(
      Effect.catchCause((cause) => {
        // Once an undo starts, an interrupt discards every co-occurring failure and defect.
        if (CauseModule.hasInterrupts(cause)) {
          const interrupts = cause.reasons.filter(CauseModule.isInterruptReason);
          return Effect.failCause(CauseModule.fromReasons(interrupts));
        }
        const deferred = compensationDecision(stepId, attempt);
        const pending = PendingCompensation.make({ stepId, attempt });
        return UpstreamDeferred.into(
          Effect.succeed(pending),
          compensationFailure(stepId, attempt),
        ).pipe(
          Effect.andThen(UpstreamDeferred.await(deferred)),
          Effect.flatMap((decision) =>
            Match.value(decision).pipe(
              Match.when("Retry", () =>
                runCompensation(stepId, value, workflowCause, undo, attempt + 1),
              ),
              Match.when("Stop", () => Effect.void),
              Match.exhaustive,
            ),
          ),
        );
      }),
    );
  };

  const runImpl = (id: string, second: unknown, third?: unknown): Effect.Effect<any, any, any> => {
    // Arity 2 + second is plain object with `do` → full options
    if (Predicate.hasProperty(second, "do")) {
      const opts = second as StepRunOptions<any, any, any, any, WorkflowError["Type"]>;
      const activity = UpstreamActivity.make({
        name: id,
        success: opts.success,
        error: opts.error,
        execute: opts.do,
      });

      if (opts.retry) {
        const retried = UpstreamActivity.retry(activity, opts.retry);
        if (opts.undo) {
          return addCompensation(id, retried, opts.undo);
        }
        return retried;
      }
      if (opts.undo) {
        return addCompensation(id, activity, opts.undo);
      }
      return activity;
    }

    // Arity 3 + third is function → shorthand with undo
    if (Predicate.isFunction(third)) {
      const execute = second as Effect.Effect<any, never, any>;
      const undo = third as (
        value: any,
        cause: Cause.Cause<WorkflowError["Type"]>,
      ) => Effect.Effect<void, WorkflowError["Type"], any>;

      const activity = UpstreamActivity.make({
        name: id,
        success: Schema.Unknown,
        execute,
      });

      return addCompensation(id, activity, undo);
    }

    // Arity 2 + second is Effect → shorthand
    const execute = second as Effect.Effect<any, never, any>;
    const activity = UpstreamActivity.make({
      name: id,
      success: Schema.Unknown,
      execute,
    });
    return activity;
  };

  const step: WorkflowStepContext<WorkflowError> = {
    executionId,

    run: runImpl as WorkflowStepContext<WorkflowError>["run"],

    sleep: (id, duration, options) =>
      UpstreamClock.sleep({
        name: id,
        duration,
        inMemoryThreshold: options?.inMemoryThreshold,
      }),

    race: ((id, steps) => {
      const activities = Arr.map(steps, (step) =>
        UpstreamActivity.make({
          name: `${id}/${step.name}`,
          success: step.success ?? Schema.Unknown,
          error: step.error,
          execute: step.execute,
        }),
      );
      return UpstreamActivity.raceAll(id, activities);
    }) as WorkflowStepContext<WorkflowError>["race"],

    raceSignals: (name, options) => UpstreamDeferred.raceAll({ name, ...options }),

    idempotencyKey: UpstreamActivity.idempotencyKey,

    attempt: UpstreamActivity.CurrentAttempt,
    suspend: Effect.gen(function* () {
      const instance = yield* WorkflowInstance;
      return yield* UpstreamWorkflow.suspend(instance);
    }),
    scope: UpstreamWorkflow.scope,
    provideScope: UpstreamWorkflow.provideScope,
    addFinalizer: UpstreamWorkflow.addFinalizer,
  };

  return {
    step,
    compensate: (cause) => {
      const plan = Arr.reverse(compensations);
      return UpstreamDeferred.into(
        Effect.succeed(plan.map(({ stepId }) => stepId)),
        compensationPlan,
      ).pipe(
        Effect.andThen(
          Effect.forEach(plan, ({ run }) => run(cause), {
            discard: true,
          }),
        ),
      );
    },
  };
};
