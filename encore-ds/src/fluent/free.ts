/* eslint-disable @typescript-eslint/no-explicit-any -- free-function action/result types are erased at the Activity boundary */
import { Effect, type Fiber, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";

// ─────────────────────────────────────────────────────────────────────────
// free.ts — context-reaching durable free functions (slice 1).
//
// `run` / `all` / `race` are imported directly and called INSIDE a generator
// handler body. They lower to `@effect/workflow` primitives and read
// `WorkflowEngine | WorkflowInstance` from Effect context — the same context a
// registered workflow body runs under (see service.ts / engine-runtime.ts).
//
// Calling any of these outside an active runtime is unsatisfiable: the returned
// Effect requires `WorkflowEngine | WorkflowInstance`, only present inside a
// registered body. That unmet requirement IS the "fail outside a runtime"
// guarantee — no runtime guard needed.
// ─────────────────────────────────────────────────────────────────────────

/** Requirements every free function adds to a handler body's `R`. */
export type FluentRequirements = WorkflowEngine | WorkflowInstance;

export interface RunOptions {
  /** Deterministic durable step name — the replay key for this side effect. */
  readonly name: string;
}

/** A `run` action: an Effect, or a (sync/async) thunk. */
export type RunAction<A> = Effect.Effect<A, any, any> | (() => A | Promise<A>);

const toExecute = <A>(action: RunAction<A>): Effect.Effect<A, never, any> =>
  Effect.isEffect(action)
    ? (action as Effect.Effect<A, never, any>)
    : // sync values and Promises both unwrap through `await`; a thrown/rejected
      // action surfaces as a defect (slice 1 has no typed-error boundary yet).
      Effect.promise(async () => (action as () => A | Promise<A>)());

/**
 * Durable step boundary. `run(action, { name })` (firegrid form) or
 * `run(name, action)`. Lowers to `Activity.make` — memoized by `name` within an
 * execution, so replay returns the recorded terminal fact and the action runs
 * at most once.
 */
export function run<A>(
  action: RunAction<A>,
  options: RunOptions,
): Effect.Effect<A, never, FluentRequirements>;
export function run<A>(
  name: string,
  action: RunAction<A>,
): Effect.Effect<A, never, FluentRequirements>;
export function run<A>(
  a: RunAction<A> | string,
  b: RunOptions | RunAction<A>,
): Effect.Effect<A, never, FluentRequirements> {
  const name = typeof a === "string" ? a : (b as RunOptions).name;
  const action = (typeof a === "string" ? (b as RunAction<A>) : a);
  return Activity.make({
    name,
    success: Schema.Unknown,
    execute: toExecute(action),
  }) as unknown as Effect.Effect<A, never, FluentRequirements>;
}

/**
 * Run durable handles concurrently and collect all results. Name-free: durable
 * identity comes from each inner `run`'s `name`, never call order — no
 * positional durable counter.
 */
export const all = <const Ops extends ReadonlyArray<Effect.Effect<any, any, any>>>(
  ops: Ops,
): Effect.Effect<
  { -readonly [K in keyof Ops]: Effect.Success<Ops[K]> },
  Effect.Error<Ops[number]>,
  Effect.Services<Ops[number]>
> => Effect.all(ops, { concurrency: "unbounded" }) as any;

/**
 * Race durable handles; first to settle wins. Name-free — Effect race
 * semantics over durable handles (firegrid parity). Durability is only as
 * stable as the runs that recorded a terminal fact; a fully replay-stable
 * durable race is a later refinement.
 */
export const race = <const Ops extends ReadonlyArray<Effect.Effect<any, any, any>>>(
  ops: Ops,
): Effect.Effect<
  Effect.Success<Ops[number]>,
  Effect.Error<Ops[number]>,
  Effect.Services<Ops[number]>
> => Effect.raceAll(ops) as any;

/** A resolved arm of `select`: which key won, and a re-yieldable handle to its value. */
export type SelectResult<Ops extends Record<string, Effect.Effect<any, any, any>>> = {
  readonly [K in keyof Ops]: {
    readonly tag: K;
    readonly future: Effect.Effect<Effect.Success<Ops[K]>>;
  };
}[keyof Ops];

/**
 * Tagged race over a record of durable handles. Resolves to `{ tag, future }`
 * for whichever arm settles first; `yield* result.future` yields its value.
 * Identity, as with `race`, comes from the inner `run` names — not the keys.
 */
export const select = <Ops extends Record<string, Effect.Effect<any, any, any>>>(
  ops: Ops,
): Effect.Effect<
  SelectResult<Ops>,
  Effect.Error<Ops[keyof Ops]>,
  Effect.Services<Ops[keyof Ops]>
> => {
  const arms = Object.entries(ops).map(([tag, eff]) =>
    Effect.map(eff, (value) => ({ tag, future: Effect.succeed(value) })),
  );
  return Effect.raceAll(arms) as any;
};

/**
 * Local fiber. NOT a durable child invocation — `spawn` forks a child fiber of
 * the current handler (interrupted when the handler ends unless awaited). Durable
 * children require cross-definition `call`/`send` (later slice).
 */
export const spawn = <A, E, R>(
  op: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, R> => Effect.forkChild(op);
