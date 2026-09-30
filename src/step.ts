/* eslint-disable typescript-eslint/no-explicit-any -- workflow types require open `any` for Effect requirements */
import {
  Workflow as UpstreamWorkflow,
  Activity as UpstreamActivity,
  DurableDeferred as UpstreamDeferred,
  DurableClock as UpstreamClock,
} from "effect/workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";
import type { Cause, Duration, Exit, Scope } from "effect";
import { Array as Arr, Effect, Predicate, Schema } from "effect";
import {
  CompensationDecision as CompensationDecisionSchema,
  CompensationDecisionConflictError,
  CompensationNotPendingError,
  decideCompensation,
  decidePendingCompensation,
  makeDurableCompensation,
  PendingCompensation,
  pendingCompensation,
} from "./internal/durable-compensation.js";
import type {
  CompensationDecision as CompensationDecisionType,
  CompensationDecisionError,
} from "./internal/durable-compensation.js";

export {
  CompensationDecisionConflictError,
  CompensationNotPendingError,
  decideCompensation,
  decidePendingCompensation,
  PendingCompensation,
  pendingCompensation,
};
export type { CompensationDecisionError };
export const CompensationDecision = CompensationDecisionSchema;
export type CompensationDecision = CompensationDecisionType;

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

function restoreStepRunOptions<WorkflowError>(candidate: {
  readonly do: unknown;
}): StepRunOptions<Schema.Top, Schema.Top, any, any, WorkflowError>;
function restoreStepRunOptions(candidate: { readonly do: unknown }): { readonly do: unknown } {
  return candidate;
}

function restoreInfallibleEffect(
  candidate: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any>;
function restoreInfallibleEffect(
  candidate: Effect.Effect<any, any, any>,
): Effect.Effect<any, any, any> {
  return candidate;
}

function restoreUndo<WorkflowError>(
  candidate: Function,
): (value: any, cause: Cause.Cause<WorkflowError>) => Effect.Effect<void, WorkflowError, any>;
function restoreUndo(candidate: Function): Function {
  return candidate;
}

interface ErasedStepRun {
  (id: string, second: any, third?: any): Effect.Effect<any, any, any>;
}

function exposeStepRun<WorkflowError extends Schema.Top>(
  run: ErasedStepRun,
): WorkflowStepContext<WorkflowError>["run"];
function exposeStepRun(run: ErasedStepRun): ErasedStepRun {
  return run;
}

interface ErasedStepRace {
  (
    id: string,
    steps: Arr.NonEmptyReadonlyArray<{
      readonly name: string;
      readonly execute: Effect.Effect<any, any, any>;
      readonly success?: Schema.Top;
      readonly error?: Schema.Top;
    }>,
  ): Effect.Effect<any, any, any>;
}

function exposeStepRace<WorkflowError extends Schema.Top>(
  race: ErasedStepRace,
): WorkflowStepContext<WorkflowError>["race"];
function exposeStepRace(race: ErasedStepRace): ErasedStepRace {
  return race;
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

const encodeSignalName = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Literals(["Signal"]), Schema.String])),
);

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
      UpstreamDeferred.tokenFromPayload(deferred, { workflow: wf, payload }),
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
  const compensation = makeDurableCompensation(wf, executionId);

  const runImpl = <Second, Third>(
    id: string,
    second: Second,
    third?: Third,
  ): Effect.Effect<any, any, any> => {
    // Arity 2 + second is plain object with `do` → full options
    if (Predicate.hasProperty(second, "do")) {
      const opts = restoreStepRunOptions<WorkflowError["Type"]>(second);
      const activity = UpstreamActivity.make({
        name: id,
        success: opts.success,
        error: opts.error,
        execute: opts.do,
      });

      if (opts.retry) {
        const retried = UpstreamActivity.retry(activity, opts.retry);
        if (opts.undo) {
          return compensation.add(id, retried, opts.undo);
        }
        return retried;
      }
      if (opts.undo) {
        return compensation.add(id, activity, opts.undo);
      }
      return activity;
    }

    // Arity 3 + third is function → shorthand with undo
    if (Predicate.isFunction(third)) {
      if (!Effect.isEffect(second)) {
        return Effect.die(new Error("effect-encore/step.run: execute must be an Effect"));
      }
      const execute = restoreInfallibleEffect(second);
      const undo = restoreUndo<WorkflowError["Type"]>(third);

      const activity = UpstreamActivity.make({
        name: id,
        success: Schema.Unknown,
        execute,
      });

      return compensation.add(id, activity, undo);
    }

    // Arity 2 + second is Effect → shorthand
    if (!Effect.isEffect(second)) {
      return Effect.die(new Error("effect-encore/step.run: execute must be an Effect"));
    }
    const execute = restoreInfallibleEffect(second);
    const activity = UpstreamActivity.make({
      name: id,
      success: Schema.Unknown,
      execute,
    });
    return activity;
  };

  const raceImpl = (id: string, steps: Parameters<ErasedStepRace>[1]) => {
    const activities = Arr.map(steps, (step) =>
      UpstreamActivity.make({
        name: `${id}/${step.name}`,
        success: step.success ?? Schema.Unknown,
        error: step.error,
        execute: step.execute,
      }),
    );
    return UpstreamActivity.raceAll(id, activities);
  };

  const step: WorkflowStepContext<WorkflowError> = {
    executionId,

    run: exposeStepRun<WorkflowError>(runImpl),

    sleep: (id, duration, options) =>
      UpstreamClock.sleep({
        name: id,
        duration,
        inMemoryThreshold: options?.inMemoryThreshold,
      }),

    race: exposeStepRace<WorkflowError>(raceImpl),

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
    compensate: compensation.compensate,
  };
};
