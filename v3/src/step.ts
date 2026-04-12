/* eslint-disable typescript-eslint/no-explicit-any -- workflow types require open `any` for Schedule, Effect requirements */
import {
  Workflow as UpstreamWorkflow,
  Activity as UpstreamActivity,
  DurableDeferred as UpstreamDeferred,
  DurableClock as UpstreamClock,
} from "@effect/workflow";
import type { WorkflowEngine } from "@effect/workflow/WorkflowEngine";
import { WorkflowInstance } from "@effect/workflow/WorkflowEngine";
import type { Array as Arr, Cause, Duration, Exit, Scope } from "effect";
import { Effect, Schedule, Schema } from "effect";

// ── WorkflowSignalToken ─────────────────────────────────────────────────

export type WorkflowSignalToken = UpstreamDeferred.Token;

// ── WorkflowSignal ──────────────────────────────────────────────────────

export interface WorkflowSignal<
  Payload extends UpstreamWorkflow.AnyStructSchema,
  S extends Schema.Schema.Any = typeof Schema.Void,
  E extends Schema.Schema.All = typeof Schema.Never,
> {
  readonly name: string;
  readonly deferred: UpstreamDeferred.DurableDeferred<S, E>;
  readonly await: Effect.Effect<
    S["Type"],
    E["Type"],
    WorkflowEngine | WorkflowInstance | S["Context"] | E["Context"]
  >;
  readonly token: Effect.Effect<WorkflowSignalToken, never, WorkflowInstance>;
  readonly tokenFromExecutionId: (executionId: string) => WorkflowSignalToken;
  readonly tokenFromPayload: (
    payload: Schema.Simplify<Schema.Struct.Constructor<Payload["fields"]>>,
  ) => Effect.Effect<WorkflowSignalToken>;
  readonly succeed: (opts: {
    token: WorkflowSignalToken;
    value: S["Type"];
  }) => Effect.Effect<void, never, WorkflowEngine | S["Context"]>;
  readonly fail: (opts: {
    token: WorkflowSignalToken;
    error: E["Type"];
  }) => Effect.Effect<void, never, WorkflowEngine | E["Context"]>;
  readonly failCause: (opts: {
    token: WorkflowSignalToken;
    cause: Cause.Cause<E["Type"]>;
  }) => Effect.Effect<void, never, WorkflowEngine | E["Context"]>;
  readonly done: (opts: {
    token: WorkflowSignalToken;
    exit: Exit.Exit<S["Type"], E["Type"]>;
  }) => Effect.Effect<void, never, WorkflowEngine | S["Context"] | E["Context"]>;
  readonly into: <R>(
    effect: Effect.Effect<S["Type"], E["Type"], R>,
  ) => Effect.Effect<
    S["Type"],
    E["Type"],
    R | WorkflowEngine | WorkflowInstance | S["Context"] | E["Context"]
  >;
}

// ── Step run options ────────────────────────────────────────────────────

export interface StepRunOptions<
  S extends Schema.Schema.Any = typeof Schema.Void,
  E extends Schema.Schema.All = typeof Schema.Never,
  R = never,
  R2 = never,
  WE = unknown,
> {
  readonly do: Effect.Effect<S["Type"], E["Type"], R>;
  readonly undo?: (value: S["Type"], cause: Cause.Cause<WE>) => Effect.Effect<void, never, R2>;
  readonly success?: S;
  readonly error?: E;
  readonly retry?: Schedule.Schedule<any, unknown> | { readonly times: number };
}

// ── WorkflowStepContext ─────────────────────────────────────────────────

export interface WorkflowStepContext<
  _Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  WorkflowError extends Schema.Schema.All,
> {
  readonly executionId: string;

  readonly run: {
    // Full options
    <
      S extends Schema.Schema.Any = typeof Schema.Void,
      E extends Schema.Schema.All = typeof Schema.Never,
      R = never,
      R2 = never,
    >(
      id: string,
      options: StepRunOptions<S, E, R, R2, WorkflowError["Type"]>,
    ): Effect.Effect<
      S["Type"],
      E["Type"],
      | S["Context"]
      | E["Context"]
      | Exclude<R, WorkflowInstance | WorkflowEngine | Scope.Scope>
      | R2
      | WorkflowEngine
      | WorkflowInstance
      | Scope.Scope
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
      | Scope.Scope
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
    duration: Duration.DurationInput,
    options?: { readonly inMemoryThreshold?: Duration.DurationInput },
  ) => Effect.Effect<void, never, WorkflowEngine | WorkflowInstance>;

  readonly signal: <
    S extends Schema.Schema.Any = typeof Schema.Void,
    E extends Schema.Schema.All = typeof Schema.Never,
  >(options: {
    readonly name: string;
    readonly success?: S;
    readonly error?: E;
  }) => WorkflowSignal<Payload, S, E>;

  readonly race: <
    const Steps extends Arr.NonEmptyReadonlyArray<{
      readonly name: string;
      readonly execute: Effect.Effect<any, any, any>;
      readonly success?: Schema.Schema.Any;
      readonly error?: Schema.Schema.All;
    }>,
  >(
    id: string,
    steps: Steps,
  ) => Effect.Effect<
    Steps[number]["execute"] extends Effect.Effect<infer A, infer _E, infer _R> ? A : never,
    Steps[number]["execute"] extends Effect.Effect<infer _A, infer E2, infer _R> ? E2 : never,
    | (Steps[number]["execute"] extends Effect.Effect<infer _A, infer _E, infer R3> ? R3 : never)
    | WorkflowEngine
    | WorkflowInstance
  >;

  readonly raceSignals: <S extends Schema.Schema.Any, E extends Schema.Schema.All>(options: {
    readonly name: string;
    readonly success: S;
    readonly error: E;
    readonly effects: Arr.NonEmptyReadonlyArray<Effect.Effect<S["Type"], E["Type"], any>>;
  }) => Effect.Effect<
    S["Type"],
    E["Type"],
    WorkflowEngine | WorkflowInstance | S["Context"] | E["Context"]
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

// ── makeSignal ──────────────────────────────────────────────────────────

export const makeSignal = <
  Payload extends UpstreamWorkflow.AnyStructSchema,
  S extends Schema.Schema.Any = typeof Schema.Void,
  E extends Schema.Schema.All = typeof Schema.Never,
>(
  wf: UpstreamWorkflow.Workflow<string, Payload, Schema.Schema.Any, Schema.Schema.All>,
  options: { readonly name: string; readonly success?: S; readonly error?: E },
): WorkflowSignal<Payload, S, E> => {
  const deferred = UpstreamDeferred.make(options.name, {
    success: options.success,
    error: options.error,
  });

  return {
    name: options.name,
    deferred,
    await: UpstreamDeferred.await(deferred),
    token: UpstreamDeferred.token(deferred),
    tokenFromExecutionId: (executionId: string) =>
      UpstreamDeferred.tokenFromExecutionId(deferred, { workflow: wf, executionId }),
    tokenFromPayload: (payload: Schema.Simplify<Schema.Struct.Constructor<Payload["fields"]>>) =>
      UpstreamDeferred.tokenFromPayload(deferred, { workflow: wf, payload: payload as never }),
    succeed: (opts) => UpstreamDeferred.succeed(deferred, opts),
    fail: (opts) => UpstreamDeferred.fail(deferred, opts),
    failCause: (opts) => UpstreamDeferred.failCause(deferred, opts),
    done: (opts) => UpstreamDeferred.done(deferred, opts),
    into: (effect) => UpstreamDeferred.into(effect, deferred),
  };
};

// ── makeStepContext ─────────────────────────────────────────────────────

export const makeStepContext = <
  Name extends string,
  Payload extends UpstreamWorkflow.AnyStructSchema,
  WorkflowError extends Schema.Schema.All,
>(
  wf: UpstreamWorkflow.Workflow<Name, Payload, Schema.Schema.Any, WorkflowError>,
  executionId: string,
): WorkflowStepContext<Name, Payload, WorkflowError> => {
  const runImpl = (id: string, second: unknown, third?: unknown): Effect.Effect<any, any, any> => {
    // Arity 2 + second is plain object with `do` → full options
    if (second !== null && typeof second === "object" && "do" in (second as object)) {
      const opts = second as StepRunOptions<any, any, any, any>;
      const retryPolicy = opts.retry
        ? "times" in (opts.retry as object)
          ? Schedule.recurs((opts.retry as { times: number }).times)
          : opts.retry
        : undefined;

      // v3: Activity extends Effect directly — no .asEffect()
      const activity = UpstreamActivity.make({
        name: id,
        success: opts.success,
        error: opts.error,
        execute: opts.do,
        interruptRetryPolicy: retryPolicy as
          | Schedule.Schedule<any, Cause.Cause<unknown>>
          | undefined,
      }) as unknown as Effect.Effect<any, any, any>;

      if (opts.undo) {
        return wf.withCompensation(activity, opts.undo as any);
      }
      return activity;
    }

    // Arity 3 + third is function → shorthand with undo
    if (typeof third === "function") {
      const execute = second as Effect.Effect<any, never, any>;
      const undo = third as (
        value: any,
        cause: Cause.Cause<unknown>,
      ) => Effect.Effect<void, never, any>;

      // v3: Activity extends Effect directly
      const activity = UpstreamActivity.make({
        name: id,
        success: Schema.Unknown,
        execute,
      }) as unknown as Effect.Effect<any, any, any>;

      return wf.withCompensation(activity, undo as any);
    }

    // Arity 2 + second is Effect → shorthand
    const execute = second as Effect.Effect<any, never, any>;
    // v3: Activity extends Effect directly
    return UpstreamActivity.make({
      name: id,
      success: Schema.Unknown,
      execute,
    }) as unknown as Effect.Effect<any, any, any>;
  };

  return {
    executionId,

    run: runImpl as WorkflowStepContext<Name, Payload, WorkflowError>["run"],

    sleep: (id, duration, options) =>
      UpstreamClock.sleep({
        name: id,
        duration,
        inMemoryThreshold: options?.inMemoryThreshold,
      }),

    signal: (options) => makeSignal(wf as any, options),

    race: (id, steps) => {
      const activities = steps.map((s) =>
        UpstreamActivity.make({
          name: `${id}/${s.name}`,
          success: s.success,
          error: s.error,
          execute: s.execute,
        }),
      );
      return UpstreamActivity.raceAll(
        id,
        activities as unknown as Arr.NonEmptyReadonlyArray<UpstreamActivity.Any>,
      );
    },

    raceSignals: (options) => UpstreamDeferred.raceAll(options as any),

    idempotencyKey: (name, options) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowInstance;
        if (options?.includeAttempt) {
          const attempt = yield* UpstreamActivity.CurrentAttempt;
          return `${instance.executionId}/${name}/${attempt}`;
        }
        return `${instance.executionId}/${name}`;
      }),

    attempt: Effect.gen(function* () {
      return yield* UpstreamActivity.CurrentAttempt;
    }),

    suspend: Effect.gen(function* () {
      const instance = yield* WorkflowInstance;
      return yield* UpstreamWorkflow.suspend(instance);
    }) as Effect.Effect<never, never, WorkflowInstance>,

    scope: UpstreamWorkflow.scope,
    provideScope: UpstreamWorkflow.provideScope,
    addFinalizer: UpstreamWorkflow.addFinalizer,
  };
};
