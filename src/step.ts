/* eslint-disable typescript-eslint/no-explicit-any -- workflow types require open `any` for Effect requirements */
import {
  Workflow as UpstreamWorkflow,
  Activity as UpstreamActivity,
  DurableDeferred as UpstreamDeferred,
  DurableClock as UpstreamClock,
} from "effect/unstable/workflow";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import { WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
import type { Cause, Duration, Exit, Scope } from "effect";
import { Array as Arr, Cause as CauseModule, Effect, Match, Schema } from "effect";

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
  WE = unknown,
> {
  readonly do: Effect.Effect<S["Type"], E["Type"], R>;
  readonly undo?: (value: S["Type"], cause: Cause.Cause<WE>) => Effect.Effect<void, never, R2>;
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
      undo: (value: A, cause: Cause.Cause<WorkflowError["Type"]>) => Effect.Effect<void, never, R2>,
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
  ) => Effect.Effect<void, never, WorkflowEngine | WorkflowInstance>;
}

export type CompensationDecision = "Retry" | "Stop";

const CompensationDecision = Schema.Literals(["Retry", "Stop"]);

const encodeCompensationActivityName = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Literals(["Compensate"]), Schema.String])),
);

const encodeCompensationDecisionName = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Literals(["CompensationDecision"]), Schema.String, Schema.Finite]),
  ),
);

const compensationActivityName = (stepId: string): string =>
  encodeCompensationActivityName(["Compensate", stepId]);

// Activity storage adds CurrentAttempt to its key. Durable Deferred storage
// does not. The decision name must carry the attempt.
const compensationDecision = (stepId: string, attempt: number) =>
  UpstreamDeferred.make(encodeCompensationDecisionName(["CompensationDecision", stepId, attempt]), {
    success: CompensationDecision,
  });

export const decideCompensation = (
  workflow: UpstreamWorkflow.Any,
  executionId: string,
  stepId: string,
  attempt: number,
  decision: CompensationDecision,
): Effect.Effect<void, never, WorkflowEngine> => {
  const deferred = compensationDecision(stepId, attempt);
  const token = UpstreamDeferred.tokenFromExecutionId(deferred, { workflow, executionId });
  return UpstreamDeferred.succeed(deferred, { token, value: decision });
};

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
  const deferred = UpstreamDeferred.make(name, {
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
  const compensations: Array<
    (
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<void, never, WorkflowEngine | WorkflowInstance>
  > = [];

  // Workflow scope finalizers are uninterruptible. Keep compensation in the
  // workflow body so a failed undo can suspend on a Durable Deferred.
  const addCompensation = <A, E, R, R2>(
    stepId: string,
    activity: Effect.Effect<A, E, R>,
    undo: (value: A, cause: Cause.Cause<WorkflowError["Type"]>) => Effect.Effect<void, never, R2>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R2>();
        const value = yield* restore(activity);
        compensations.push((cause) =>
          runCompensation(
            stepId,
            value,
            cause,
            (result, workflowCause) => undo(result, workflowCause).pipe(Effect.provide(context)),
            1,
          ),
        );
        return value;
      }),
    );

  const runCompensation = <A>(
    stepId: string,
    value: A,
    workflowCause: Cause.Cause<WorkflowError["Type"]>,
    undo: (value: A, cause: Cause.Cause<WorkflowError["Type"]>) => Effect.Effect<void>,
    attempt: number,
  ): Effect.Effect<void, never, WorkflowEngine | WorkflowInstance> => {
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
    }).pipe(Effect.provideService(UpstreamActivity.CurrentAttempt, attempt));

    return activity.pipe(
      Effect.catchCause((cause) => {
        // Once an undo starts, any interrupt wins over operator recovery.
        if (CauseModule.hasInterrupts(cause)) return Effect.failCause(cause);
        const deferred = compensationDecision(stepId, attempt);
        return UpstreamDeferred.await(deferred).pipe(
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
    if (second !== null && typeof second === "object" && "do" in second) {
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
    if (typeof third === "function") {
      const execute = second as Effect.Effect<any, never, any>;
      const undo = third as (
        value: any,
        cause: Cause.Cause<WorkflowError["Type"]>,
      ) => Effect.Effect<void, never, any>;

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

    idempotencyKey: (name, options) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowInstance;
        if (options?.includeAttempt) {
          const attempt = yield* UpstreamActivity.CurrentAttempt;
          return `${instance.executionId}/${name}/${attempt}`;
        }
        return `${instance.executionId}/${name}`;
      }),

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
    compensate: (cause) =>
      Effect.forEach(Arr.reverse(compensations), (compensate) => compensate(cause), {
        discard: true,
      }),
  };
};
