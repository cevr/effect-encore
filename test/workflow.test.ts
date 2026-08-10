import { describe, expect, it, test } from "effect-bun-test";
import { Context, Effect, Exit, Layer, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { Actor } from "../src/index.js";

class OrderError extends Schema.TaggedError<OrderError>()("OrderError", {
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
  id: (p: { orderId: string }) => p.orderId,
});

describe("Actor.fromWorkflow", () => {
  test("creates a workflow actor with payload-only API", () => {
    expect(ProcessOrder._tag).toBe("WorkflowActor");
    expect(ProcessOrder.name).toBe("ProcessOrder");
    expect(ProcessOrder.type).toBe("Workflow/ProcessOrder");
    expect(ProcessOrder._meta.name).toBe("ProcessOrder");
    expect(ProcessOrder.execute).toBeDefined();
    expect(ProcessOrder.send).toBeDefined();
    expect(ProcessOrder.peek).toBeDefined();
    expect(ProcessOrder.peekAt).toBeDefined();
    expect(ProcessOrder.watchAt).toBeDefined();
    expect(ProcessOrder.waitForAt).toBeDefined();
    expect(ProcessOrder.rerun).toBeDefined();
    expect(ProcessOrder.prune).toBeDefined();
    expect(ProcessOrder.make).toBeDefined();
  });

  test("Actor.isWorkflow returns true for workflow actors", () => {
    expect(Actor.isWorkflow(ProcessOrder)).toBe(true);
    expect(Actor.isEntity(ProcessOrder)).toBe(false);
  });

  test("make produces an operation value with _tag", () => {
    const op = ProcessOrder.make({ orderId: "ord-1" });
    expect(op._tag).toBe("Run");
    expect((op as { orderId: string }).orderId).toBe("ord-1");
  });

  test("$is type guard works for Run", () => {
    const op = ProcessOrder.make({ orderId: "ord-1" });
    expect(ProcessOrder.$is("Run")(op)).toBe(true);
    expect(ProcessOrder.$is("Run")({ _tag: "Other" })).toBe(false);
  });
});

const Greeter = Actor.fromWorkflow("Greeter", {
  payload: { name: Schema.String },
  success: Schema.String,
  id: (p: { name: string }) => p.name,
});

const GreeterTest = Actor.toTestLayer(Greeter, (payload) =>
  Effect.succeed(`hello ${payload.name}`),
);

describe("Actor.fromWorkflow — execute/send", () => {
  it.scopedLive.layer(GreeterTest)("execute runs workflow and returns result", () =>
    Effect.gen(function* () {
      const result = yield* Greeter.execute({ name: "world" });
      expect(result).toBe("hello world");
    }),
  );

  it.scopedLive.layer(GreeterTest)("send returns ExecId string", () =>
    Effect.gen(function* () {
      const execId = yield* Greeter.send({ name: "cast-test" });
      expect(typeof execId).toBe("string");
    }),
  );

  it.scopedLive.layer(GreeterTest)("peek returns Success after send", () =>
    Effect.gen(function* () {
      yield* Greeter.send({ name: "peek-test" });

      yield* Effect.sleep("50 millis");
      const result = yield* Greeter.peek({ name: "peek-test" });
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.value).toBe("hello peek-test");
      }
    }),
  );

  it.scopedLive.layer(GreeterTest)("inspects a workflow through its durable execution id", () =>
    Effect.gen(function* () {
      const executionId = yield* Greeter.send({ name: "inspect-by-id" });
      const result = yield* Greeter.waitForAt(executionId);
      const snapshot = yield* Greeter.peekAt(executionId);

      expect(result).toEqual(snapshot);
      expect(snapshot).toEqual({ _tag: "Success", value: "hello inspect-by-id" });
    }),
  );

  it.scopedLive.layer(GreeterTest)("peekAt returns Pending for an unknown execution id", () =>
    Effect.gen(function* () {
      const result = yield* Greeter.peekAt("non-existent");
      expect(result._tag).toBe("Pending");
    }),
  );
});

// ── Workflow with error ────────────────────────────────────────────────────

const FailingWorkflow = Actor.fromWorkflow("FailingWorkflow", {
  payload: { input: Schema.String },
  error: OrderError,
  id: (p: { input: string }) => p.input,
});

const FailingTest = Actor.toTestLayer(FailingWorkflow, () =>
  Effect.fail(OrderError.make({ message: "boom" })),
);

describe("Actor.fromWorkflow — errors", () => {
  it.scopedLive.layer(FailingTest)("execute surfaces workflow errors", () =>
    Effect.gen(function* () {
      const exit = yield* FailingWorkflow.execute({ input: "bad" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.scopedLive.layer(FailingTest)(
    "peek returns Failure with user's typed error, not raw Cause",
    () =>
      Effect.gen(function* () {
        yield* FailingWorkflow.send({ input: "peek-fail" });

        yield* Effect.sleep("50 millis");
        const result = yield* FailingWorkflow.peek({ input: "peek-fail" });
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
  id: (p: { input: string }) => p.input,
});

const DefectTest = Actor.toTestLayer(DefectWorkflow, () => Effect.die("unexpected crash"));

describe("Actor.fromWorkflow — defects", () => {
  it.scopedLive.layer(DefectTest)("peek returns Defect for die, not Failure", () =>
    Effect.gen(function* () {
      yield* DefectWorkflow.send({ input: "boom" });

      yield* Effect.sleep("50 millis");
      const result = yield* DefectWorkflow.peek({ input: "boom" });
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
      const id1 = yield* Greeter.send({ name: "same" });
      const id2 = yield* Greeter.send({ name: "same" });
      expect(id1).toBe(id2);
    }),
  );
});

// ── Production layer pattern (Actor.toLayer + external WorkflowEngine) ──

describe("Actor.fromWorkflow — production layer", () => {
  const ProductionLayer = Actor.toLayer(Greeter, (payload) =>
    Effect.succeed(`hello ${payload.name}`),
  ).pipe(Layer.provide(WorkflowEngine.layerMemory));

  it.scopedLive("works with externally-provided WorkflowEngine", () =>
    Effect.gen(function* () {
      const result = yield* Greeter.execute({ name: "prod" });
      expect(result).toBe("hello prod");
    }).pipe(Effect.provide(ProductionLayer)),
  );

  it.scopedLive("captures WorkflowEngine in the workflow client", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(ProductionLayer);
      const client = Context.get(context, Greeter.Context);
      const result = yield* Greeter.execute({ name: "captured" }).pipe(
        Effect.provideService(Greeter.Context, client),
      );

      expect(result).toBe("hello captured");
    }),
  );
});
