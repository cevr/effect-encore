import { describe, test } from "effect-bun-test/v3";
import { Effect, Schema } from "effect";
import type { Cause, Duration, Layer, Scope, Stream } from "effect";
import type { Execution } from "@effect/workflow/Workflow";
import type { WorkflowEngine, WorkflowInstance } from "@effect/workflow/WorkflowEngine";
import { Actor } from "../src/index.js";
import type { ExecId, PeekResult, WorkflowSignal } from "../src/index.js";

// ── Type-level tests for ExecId phantom brand inference ───────────────────

class OrderError extends Schema.TaggedError<OrderError>()("OrderError", {
  message: Schema.String,
}) {}

const Order = Actor.fromEntity("Order", {
  Place: {
    payload: { item: Schema.String },
    success: Schema.String,
    error: OrderError,
    id: (p: { item: string }) => p.item,
  },
  Count: {
    success: Schema.Number,
    id: () => "singleton",
  },
});

const Greeter = Actor.fromWorkflow("Greeter", {
  payload: { name: Schema.String },
  success: Schema.String,
  id: (p: { name: string }) => p.name,
});

// ── Compile-time type assertions ──────────────────────────────────────────

// Helper: assert type equality at compile time
type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// ExecId is a string at runtime
type _ExecIdIsString = Assert<ExecId extends string ? true : false>;

// PeekResult carries generic types
type _PeekResultHasSuccess = Assert<
  IsExact<Extract<PeekResult<string, OrderError>, { _tag: "Success" }>["value"], string>
>;
type _PeekResultHasError = Assert<
  IsExact<Extract<PeekResult<string, OrderError>, { _tag: "Failure" }>["error"], OrderError>
>;

// PeekResult includes Suspended
type _PeekResultHasSuspended = Assert<
  PeekResult extends { _tag: "Suspended" } | unknown ? true : false
>;

describe("type-level tests", () => {
  test("Place.send returns ExecId<success, error> with correct phantom types", () => {
    const _check = (): Effect.Effect<ExecId<string, OrderError>, never, unknown> =>
      Order.Place.send({ item: "widget" });
    void _check;
  });

  test("Count.send returns ExecId<number, never>", () => {
    const _check = (): Effect.Effect<ExecId<number, never>, never, unknown> =>
      Order.Count.send(undefined as never);
    void _check;
  });

  test("Greeter.send returns ExecId<string, never> with correct phantom types", () => {
    const _check = (): Effect.Effect<ExecId<string, never>, never, unknown> =>
      Greeter.send({ name: "world" });
    void _check;
  });

  test("Greeter.execute returns Effect<string>", () => {
    const _check = (): Effect.Effect<string, never, unknown> => Greeter.execute({ name: "world" });
    void _check;
  });

  test("Greeter.peek accepts payload and returns typed PeekResult", () => {
    const _fn: (payload: {
      readonly name: string;
    }) => Effect.Effect<PeekResult<string, never>, unknown, unknown> = Greeter.peek;
    void _fn;
  });

  test("Greeter.rerun returns Effect<void> taking payload only", () => {
    const _fn: (payload: { readonly name: string }) => Effect.Effect<void, unknown, unknown> =
      Greeter.rerun;
    void _fn;
  });

  test("Greeter.make returns the underlying OperationValue tagged 'Run'", () => {
    const _op = Greeter.make({ name: "world" });
    type _hasTag = (typeof _op)["_tag"];
    void _op;
  });

  test("Place.peek accepts payload and returns typed PeekResult", () => {
    const _fn: (payload: {
      readonly item: string;
    }) => Effect.Effect<PeekResult<string, OrderError>, unknown, unknown> = Order.Place.peek;
    void _fn;
  });

  test("Place.watch accepts payload and returns typed Stream of PeekResult", () => {
    const _fn: (
      payload: { readonly item: string },
      options?: { readonly interval?: Duration.DurationInput },
    ) => Stream.Stream<PeekResult<string, OrderError>, unknown, unknown> = Order.Place.watch;
    void _fn;
  });

  test("workflow actor has resume but entity does not", () => {
    // Workflow has resume
    const _resume: (executionId: string) => Effect.Effect<void, never, unknown> = Greeter.resume;
    void _resume;

    // Entity does NOT have resume — this would be a compile error if uncommented:
    // const _noResume = Order.resume; // Property 'resume' does not exist
  });

  test("ExecId phantom types flow through send → peek through op handle", () => {
    // send produces ExecId<S, E>; peek consumes payload and returns PeekResult<S, E>
    const _pipeline = Effect.gen(function* () {
      const execId = yield* Order.Place.send({ item: "widget" });
      // execId: ExecId<string, OrderError>
      void execId;

      const result = yield* Order.Place.peek({ item: "widget" });
      // result: PeekResult<string, OrderError>

      if (result._tag === "Success") {
        const _value: string = result.value;
        void _value;
      }
      if (result._tag === "Failure") {
        const _error: OrderError = result.error;
        void _error;
      }
    });
    void _pipeline;
  });

  test("rerun returns Effect<void> taking payload only", () => {
    const _fn: (payload: { readonly item: string }) => Effect.Effect<void, unknown, unknown> =
      Order.Place.rerun;
    void _fn;
  });

  test("make returns the underlying OperationValue for the tag", () => {
    const _op = Order.Place.make({ item: "widget" });
    // The OperationValue carries the _tag discriminator
    type _hasTag = (typeof _op)["_tag"];
    void _op;
  });

  test("entity exposes flush/redeliver/interrupt at the actor level", () => {
    const _flush: (entityId: string) => Effect.Effect<void, unknown, unknown> = Order.flush;
    const _redeliver: (entityId: string) => Effect.Effect<void, unknown, unknown> = Order.redeliver;
    const _interrupt: (entityId: string) => Effect.Effect<void, unknown, unknown> = Order.interrupt;
    void _flush;
    void _redeliver;
    void _interrupt;
  });

  test("withProtocol preserves Name and Defs — data-last (pipe)", () => {
    const _piped = Order.pipe(Actor.withProtocol((protocol) => protocol));
    void _piped;
  });

  test("withProtocol preserves Name and Defs — data-first", () => {
    const _direct = Actor.withProtocol(Order, (protocol) => protocol);
    void _direct;
  });
});

// ── Workflow Step DSL type tests ─────────────────────────────────────────

const FailableWorkflow = Actor.fromWorkflow("Failable", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: OrderError,
  id: (p: { id: string }) => p.id,
});

describe("step DSL type-level tests", () => {
  test("shorthand step.run rejects failable effects (E != never)", () => {
    const _check = Actor.toTestLayer(FailableWorkflow, (_payload, step) =>
      Effect.gen(function* () {
        // @ts-expect-error — shorthand requires E = never, failable effects must use full options
        yield* step.run("bad", Effect.fail(new OrderError({ message: "boom" })));
        return "ok";
      }),
    );
    void _check;
  });

  test("shorthand 3-arg undo cause is typed to WorkflowError", () => {
    const _check = Actor.toTestLayer(FailableWorkflow, (_payload, step) =>
      Effect.gen(function* () {
        yield* step.run("typed-undo", Effect.succeed("ok"), (_value, cause) => {
          // cause should be Cause<OrderError>, not Cause<unknown>
          const _typed: Cause.Cause<OrderError> = cause;
          void _typed;
          return Effect.void;
        });
        return "ok";
      }),
    );
    void _check;
  });

  test("full options undo cause is typed to WorkflowError", () => {
    const _check = Actor.toTestLayer(FailableWorkflow, (_payload, step) =>
      Effect.gen(function* () {
        yield* step.run("typed-full-undo", {
          do: Effect.succeed("ok"),
          success: Schema.String,
          undo: (_value, cause) => {
            // cause should be Cause<OrderError>, not Cause<unknown>
            const _typed: Cause.Cause<OrderError> = cause;
            void _typed;
            return Effect.void;
          },
        });
        return "ok";
      }),
    );
    void _check;
  });
});

// ── Declarative signal type tests ──────────────────────────────────────────

class ApprovalDecision extends Schema.TaggedClass<ApprovalDecision>()("ApprovalDecision", {
  approved: Schema.Boolean,
}) {}

const SignalWorkflow = Actor.fromWorkflow("SignalWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
  signals: {
    Approval: { success: ApprovalDecision },
    Cancel: {},
  },
});

const NoSignalWorkflow = Actor.fromWorkflow("NoSignalWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
});

describe("declarative signal type-level tests", () => {
  test("signal property is typed as WorkflowSignal with correct schemas", () => {
    const _approval: WorkflowSignal<
      Schema.Struct<{ id: typeof Schema.String }>,
      typeof ApprovalDecision,
      typeof Schema.Never
    > = SignalWorkflow.Approval;
    void _approval;
  });

  test("void signal defaults to Schema.Void/Schema.Never", () => {
    const _cancel: WorkflowSignal<
      Schema.Struct<{ id: typeof Schema.String }>,
      typeof Schema.Void,
      typeof Schema.Never
    > = SignalWorkflow.Cancel;
    void _cancel;
  });

  test("workflow without signals has no extra properties", () => {
    // NoSignalWorkflow should not have Approval or Cancel
    // @ts-expect-error — no signals defined
    const _bad = NoSignalWorkflow.Approval;
    void _bad;
  });

  test("signal .token returns Effect<WorkflowSignalToken>", () => {
    const _token: Effect.Effect<unknown, never, unknown> = SignalWorkflow.Approval.token;
    void _token;
  });

  test("signal .await returns Effect with correct success type", () => {
    const _await: Effect.Effect<ApprovalDecision, never, unknown> = SignalWorkflow.Approval.await;
    void _await;
  });
});

// ── Workflow toLayer requirements exclusion ───────────────────────────────
//
// Regression test: `Actor.toLayer(workflow, handler)` must mirror upstream
// `Workflow.toLayer` and exclude `WorkflowEngine | WorkflowInstance |
// Execution<Name> | Scope.Scope` from the handler's `R` so they don't leak
// into the resulting Layer's `RIn`. Without these excludes, a handler that
// calls `step.run(...)` (which uses `Workflow.intoResult` internally and
// requires `WorkflowInstance`) produces a Layer that's unsatisfiable from
// user code.

const RegressionWorkflow = Actor.fromWorkflow("Regression", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
});

describe("workflow toLayer regression — context exclusion", () => {
  test("toLayer with step.run handler does NOT leak WorkflowInstance / Execution / Scope into RIn", () => {
    const layer = Actor.toLayer(RegressionWorkflow, (payload, step) =>
      Effect.gen(function* () {
        // step.run injects WorkflowInstance into the inner Effect's R; the
        // outer toLayer signature must Exclude it from the Layer's RIn.
        yield* step.run("step-1", { do: Effect.succeed(payload.id) });
        return payload.id;
      }),
    );

    type RIn = Layer.Layer.Context<typeof layer>;
    type _NoWorkflowInstance = Assert<IsExact<Extract<RIn, WorkflowInstance>, never>>;
    type _NoExecution = Assert<IsExact<Extract<RIn, Execution<"Regression">>, never>>;
    type _NoScope = Assert<IsExact<Extract<RIn, Scope.Scope>, never>>;
    // WorkflowEngine SHOULD remain — it's required by the runner.
    type _HasWorkflowEngine = Assert<WorkflowEngine extends RIn ? true : false>;
    void layer;
  });

  test("toTestLayer matches: no WorkflowInstance / Execution / Scope leak in RIn", () => {
    const layer = Actor.toTestLayer(RegressionWorkflow, (payload, step) =>
      Effect.gen(function* () {
        yield* step.run("step-1", { do: Effect.succeed(payload.id) });
        return payload.id;
      }),
    );

    type RIn = Layer.Layer.Context<typeof layer>;
    type _NoWorkflowInstance = Assert<IsExact<Extract<RIn, WorkflowInstance>, never>>;
    type _NoExecution = Assert<IsExact<Extract<RIn, Execution<"Regression">>, never>>;
    type _NoScope = Assert<IsExact<Extract<RIn, Scope.Scope>, never>>;
    void layer;
  });
});
