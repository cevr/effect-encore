import { describe, expect, it, test } from "effect-bun-test";
import { Effect, Exit, Schema } from "effect";
import { Actor, makeExecId } from "../src/index.js";

class OrderError extends Schema.TaggedErrorClass<OrderError>()("OrderError", {
  message: Schema.String,
}) {}

const OrderResult = Schema.Struct({
  orderId: Schema.String,
  status: Schema.String,
});

const ProcessOrder = Actor.fromWorkflow("ProcessOrder", {
  payload: { orderId: Schema.String },
  success: OrderResult,
  error: OrderError,
  idempotencyKey: (p: { orderId: string }) => p.orderId,
});

describe("Actor.fromWorkflow", () => {
  test("creates a workflow actor with Run constructor", () => {
    expect(ProcessOrder._tag).toBe("WorkflowActorObject");
    expect(ProcessOrder._meta.name).toBe("ProcessOrder");
    expect(ProcessOrder.Run).toBeDefined();
  });

  test("Run constructor produces operation value with _tag", () => {
    const op = ProcessOrder.Run({ orderId: "ord-1" });
    expect(op._tag).toBe("Run");
    expect(op.orderId).toBe("ord-1");
  });

  test("$is type guard works for Run", () => {
    const op = ProcessOrder.Run({ orderId: "ord-1" });
    expect(ProcessOrder.$is("Run")(op)).toBe(true);
    expect(ProcessOrder.$is("Run")({ _tag: "Other" })).toBe(false);
  });
});

const Greeter = Actor.fromWorkflow("Greeter", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { name: string }) => p.name,
});

const GreeterTest = Actor.toTestLayer(Greeter, (payload) =>
  Effect.succeed(`hello ${payload.name}`),
);

describe("Actor.fromWorkflow — call/cast", () => {
  it.scopedLive.layer(GreeterTest)("call executes workflow and returns result", () =>
    Effect.gen(function* () {
      const ref = yield* Greeter.actor("g-1");
      const result = yield* ref.call(Greeter.Run({ name: "world" }));
      expect(result).toBe("hello world");
    }),
  );

  it.scopedLive.layer(GreeterTest)("cast returns ExecId string", () =>
    Effect.gen(function* () {
      const ref = yield* Greeter.actor("g-2");
      const execId = yield* ref.cast(Greeter.Run({ name: "cast-test" }));
      expect(typeof execId).toBe("string");
    }),
  );

  it.scopedLive.layer(GreeterTest)("peek returns Success after call", () =>
    Effect.gen(function* () {
      const ref = yield* Greeter.actor("g-3");
      const execId = yield* ref.cast(Greeter.Run({ name: "peek-test" }));

      yield* Effect.sleep("50 millis");
      const result = yield* Greeter.peek(execId);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.value).toBe("hello peek-test");
      }
    }),
  );

  it.scopedLive.layer(GreeterTest)("peek returns Pending for non-existent execution", () =>
    Effect.gen(function* () {
      const result = yield* Greeter.peek(makeExecId("non-existent"));
      expect(result._tag).toBe("Pending");
    }),
  );
});

// ── Workflow with error ────────────────────────────────────────────────────

const FailingWorkflow = Actor.fromWorkflow("FailingWorkflow", {
  payload: { input: Schema.String },
  error: OrderError,
  idempotencyKey: (p: { input: string }) => p.input,
});

const FailingTest = Actor.toTestLayer(FailingWorkflow, () =>
  Effect.fail(new OrderError({ message: "boom" })),
);

describe("Actor.fromWorkflow — errors", () => {
  it.scopedLive.layer(FailingTest)("call surfaces workflow errors", () =>
    Effect.gen(function* () {
      const ref = yield* FailingWorkflow.actor("f-1");
      const exit = yield* ref.call(FailingWorkflow.Run({ input: "bad" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.scopedLive.layer(FailingTest)(
    "peek returns Failure with user's typed error, not raw Cause",
    () =>
      Effect.gen(function* () {
        const ref = yield* FailingWorkflow.actor("f-peek");
        const execId = yield* ref.cast(FailingWorkflow.Run({ input: "peek-fail" }));

        yield* Effect.sleep("50 millis");
        const result = yield* FailingWorkflow.peek(execId);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          // Should be the user's OrderError, not a raw Cause tree
          expect(result.error).toBeInstanceOf(OrderError);
        }
      }),
  );
});

// ── Workflow with defect ────────────────────────────────────────────────────

const DefectWorkflow = Actor.fromWorkflow("DefectWorkflow", {
  payload: { input: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { input: string }) => p.input,
});

const DefectTest = Actor.toTestLayer(DefectWorkflow, () => Effect.die("unexpected crash"));

describe("Actor.fromWorkflow — defects", () => {
  it.scopedLive.layer(DefectTest)("peek returns Defect for die, not Failure", () =>
    Effect.gen(function* () {
      const ref = yield* DefectWorkflow.actor("d-1");
      const execId = yield* ref.cast(DefectWorkflow.Run({ input: "boom" }));

      yield* Effect.sleep("50 millis");
      const result = yield* DefectWorkflow.peek(execId);
      expect(result._tag).toBe("Defect");
      if (result._tag === "Defect") {
        expect(result.cause).toBe("unexpected crash");
      }
    }),
  );
});

// ── Workflow lifecycle ────────────────────────────────────────────────────

describe("Actor.fromWorkflow — lifecycle", () => {
  test("resume method exists", () => {
    expect(ProcessOrder.resume).toBeDefined();
  });

  test("interrupt method exists", () => {
    expect(ProcessOrder.interrupt).toBeDefined();
  });

  test("executionId method exists", () => {
    expect(ProcessOrder.executionId).toBeDefined();
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────

describe("Actor.fromWorkflow — idempotency", () => {
  it.scopedLive.layer(GreeterTest)("same payload yields same ExecId", () =>
    Effect.gen(function* () {
      const ref = yield* Greeter.actor("g-idem");
      const id1 = yield* ref.cast(Greeter.Run({ name: "same" }));
      const id2 = yield* ref.cast(Greeter.Run({ name: "same" }));
      expect(id1).toBe(id2);
    }),
  );
});
