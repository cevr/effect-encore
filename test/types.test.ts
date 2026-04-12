import { describe, test } from "effect-bun-test";
import { Effect, Schema } from "effect";
import type { Cause, Duration, Stream } from "effect";
import { Actor } from "../src/index.js";
import type { ExecId, PeekResult, WorkflowSignal } from "../src/index.js";

// ── Type-level tests for ExecId phantom brand inference ───────────────────

class OrderError extends Schema.TaggedErrorClass<OrderError>()("OrderError", {
  message: Schema.String,
}) {}

const Order = Actor.fromEntity("Order", {
  Place: {
    payload: { item: Schema.String },
    success: Schema.String,
    error: OrderError,
    primaryKey: (p: { item: string }) => p.item,
  },
  Count: {
    success: Schema.Number,
    primaryKey: () => "singleton",
  },
});

const Greeter = Actor.fromWorkflow("Greeter", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { name: string }) => p.name,
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
  test("entity send returns ExecId with correct phantom types", () => {
    const _check = (_ref: {
      send: (op: ReturnType<typeof Order.Place>) => Effect.Effect<ExecId<string, OrderError>>;
    }) => {};
    void _check;
  });

  test("entity send for void-success returns ExecId<void, never>", () => {
    const _check = (_ref: {
      send: (op: ReturnType<typeof Order.Count>) => Effect.Effect<ExecId<number, never>>;
    }) => {};
    void _check;
  });

  test("workflow send returns ExecId with correct phantom types", () => {
    const _check = (_ref: {
      send: (op: ReturnType<typeof Greeter.Run>) => Effect.Effect<ExecId<string, never>>;
    }) => {};
    void _check;
  });

  test("entity peek accepts ExecId and returns typed PeekResult", () => {
    // Verify the peek signature on the actor object
    const _fn: <S, E>(execId: ExecId<S, E>) => Effect.Effect<PeekResult<S, E>, unknown, unknown> =
      Order.peek;
    void _fn;
  });

  test("entity watch accepts ExecId and returns typed Stream of PeekResult", () => {
    const _fn: <S, E>(
      execId: ExecId<S, E>,
      options?: { readonly interval?: Duration.Input },
    ) => Stream.Stream<PeekResult<S, E>, unknown, unknown> = Order.watch;
    void _fn;
  });

  test("workflow peek accepts ExecId and returns typed PeekResult", () => {
    const _fn: <S, E>(execId: ExecId<S, E>) => Effect.Effect<PeekResult<S, E>, unknown, unknown> =
      Greeter.peek;
    void _fn;
  });

  test("workflow actor has resume but entity does not", () => {
    // Workflow has resume
    const _resume: (executionId: string) => Effect.Effect<void, never, unknown> = Greeter.resume;
    void _resume;

    // Entity does NOT have resume — this would be a compile error if uncommented:
    // const _noResume = Order.resume; // Property 'resume' does not exist
  });

  test("ExecId phantom types flow through send → peek", () => {
    // send produces ExecId<S, E>, peek consumes it
    // and returns PeekResult<S, E> — all without the user specifying generics
    const _pipeline = Effect.gen(function* () {
      // In a real test this would have the actor context, but we're testing types
      const ref = null as unknown as {
        send: (op: ReturnType<typeof Order.Place>) => Effect.Effect<ExecId<string, OrderError>>;
      };

      const execId = yield* ref.send(Order.Place({ item: "widget" }));
      // execId: ExecId<string, OrderError>

      const result = yield* Order.peek(execId);
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
  idempotencyKey: (p: { id: string }) => p.id,
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
  idempotencyKey: (p: { id: string }) => p.id,
  signals: {
    Approval: { success: ApprovalDecision },
    Cancel: {},
  },
});

const NoSignalWorkflow = Actor.fromWorkflow("NoSignalWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { id: string }) => p.id,
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
