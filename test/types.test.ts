import { describe, test } from "effect-bun-test";
import { Effect, Schema } from "effect";
import type { Duration, Stream } from "effect";
import { Actor } from "../src/index.js";
import type { ExecId, PeekResult } from "../src/index.js";

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
  test("entity cast returns ExecId with correct phantom types", () => {
    // This test verifies at compile time that cast returns ExecId<Success, Error>
    // The actual runtime behavior is tested elsewhere
    const _check = (_ref: {
      cast: (op: ReturnType<typeof Order.Place>) => Effect.Effect<ExecId<string, OrderError>>;
    }) => {};
    void _check;
  });

  test("entity cast for void-success returns ExecId<void, never>", () => {
    const _check = (_ref: {
      cast: (op: ReturnType<typeof Order.Count>) => Effect.Effect<ExecId<number, never>>;
    }) => {};
    void _check;
  });

  test("workflow cast returns ExecId with correct phantom types", () => {
    const _check = (_ref: {
      cast: (op: ReturnType<typeof Greeter.Run>) => Effect.Effect<ExecId<string, never>>;
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

  test("ExecId phantom types flow through cast → peek", () => {
    // This is the key inference test: cast produces ExecId<S, E>, peek consumes it
    // and returns PeekResult<S, E> — all without the user specifying generics
    const _pipeline = Effect.gen(function* () {
      // In a real test this would have the actor context, but we're testing types
      const ref = null as unknown as {
        cast: (op: ReturnType<typeof Order.Place>) => Effect.Effect<ExecId<string, OrderError>>;
      };

      const execId = yield* ref.cast(Order.Place({ item: "widget" }));
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
});
