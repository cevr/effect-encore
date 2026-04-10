import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { Workflow as WF } from "../src/index.js";

const Greeter = WF.workflow("Greeter", {
  payload: { name: Schema.String },
  idempotencyKey: (p) => (p as Record<string, string>)["name"] ?? "",
  success: Schema.String,
});

const greeterHandler = WF.workflowHandlers(Greeter, (payload: { name: string }) =>
  Effect.succeed(`hello ${payload.name}`),
);

describe("Actor.workflow", () => {
  it("defines a workflow-backed actor with payload/success/error schemas", () => {
    expect(Greeter._tag).toBe("WorkflowDefinition");
    expect(Greeter.name).toBe("Greeter");
    expect(Greeter.workflow).toBeDefined();
  });

  it.todo("idempotencyKey generates deterministic executionId", () => {});
});

describe("Workflow Ref.call", () => {
  it("executes workflow and blocks until Complete — returns success value", async () => {
    const result = await Effect.gen(function* () {
      const ref = WF.workflowClient(Greeter)("greeter-1");
      return yield* ref.call({ name: "world" });
    }).pipe(
      Effect.provide(greeterHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.runPromise,
    );

    expect(result).toBe("hello world");
  });

  it.todo("surfaces workflow errors in the error channel", () => {});
  it.todo("retries through Suspended states until Complete", () => {});
});

describe("Workflow Ref.cast", () => {
  it("executes with discard: true — returns WorkflowReceipt with executionId", async () => {
    const receipt = await Effect.gen(function* () {
      const ref = WF.workflowClient(Greeter)("greeter-cast-1");
      return yield* ref.cast({ name: "cast-test" });
    }).pipe(
      Effect.provide(greeterHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.scoped,
      Effect.timeout("3 seconds"),
      Effect.runPromise,
    );

    expect(receipt?._tag).toBe("WorkflowReceipt");
    expect(receipt?.workflowName).toBe("Greeter");
    expect(receipt?.executionId).toBeDefined();
    expect(typeof receipt?.executionId).toBe("string");
    expect(receipt!.executionId.length).toBeGreaterThan(0);
  });

  it.todo("duplicate cast with same idempotencyKey is idempotent", () => {});
});

describe("Workflow peek", () => {
  it("returns Success when workflow is Complete", async () => {
    const result = await Effect.gen(function* () {
      const ref = WF.workflowClient(Greeter)("greeter-peek-1");
      const receipt = yield* ref.cast({ name: "peek-test" });

      // Wait for workflow to complete
      yield* Effect.sleep("100 millis");

      return yield* WF.workflowPoll(Greeter, receipt.executionId);
    }).pipe(
      Effect.provide(greeterHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.runPromise,
    );

    expect(result?._tag).toBe("Success");
  });

  it.todo("returns Pending when workflow has not started", () => {});
  it.todo("returns Pending when workflow is Suspended", () => {});
  it.todo("uses workflow.poll(executionId) under the hood", () => {});
});

describe("DurableDeferred integration", () => {
  const ApprovalDeferred = WF.DurableDeferred.make("approval", {
    success: Schema.String,
  });

  const ApprovalWorkflow = WF.workflow("Approval", {
    payload: { name: Schema.String },
    idempotencyKey: (p) => (p as Record<string, string>)["name"] ?? "",
    success: Schema.String,
  });

  const approvalHandler = WF.workflowHandlers(
    ApprovalWorkflow,
    Effect.fn("approvalHandler")(function* (payload: { name: string }) {
      const result = yield* DurableDeferred.await(ApprovalDeferred);
      return `${payload.name} approved: ${result}`;
    }),
  );

  it("DurableDeferred re-exports are available from Workflow module", () => {
    expect(WF.DurableDeferred).toBeDefined();
    expect(WF.DurableDeferred.make).toBeDefined();
    expect(WF.DurableDeferred.token).toBeDefined();
    expect(WF.DurableDeferred.tokenFromPayload).toBeDefined();
    expect(WF.DurableDeferred.succeed).toBeDefined();
  });

  it("Activity re-exports are available from Workflow module", () => {
    expect(WF.Activity).toBeDefined();
    expect(WF.Activity.make).toBeDefined();
    expect(WF.Activity.retry).toBeDefined();
  });

  it("DurableDeferred.succeed resumes a suspended workflow", async () => {
    const result = await Effect.gen(function* () {
      // Get token before workflow starts
      const token = yield* DurableDeferred.tokenFromPayload(ApprovalDeferred, {
        workflow: ApprovalWorkflow.workflow,
        payload: { name: "test" },
      });

      // Cast workflow (fire-and-forget)
      const ref = WF.workflowClient(ApprovalWorkflow)("approval-1");
      const receipt = yield* ref.cast({ name: "test" });

      // Wait a bit for workflow to start and suspend on deferred
      yield* Effect.sleep("100 millis");

      // Complete the deferred externally
      yield* DurableDeferred.succeed(ApprovalDeferred, {
        token,
        value: "yes",
      });

      // Wait for workflow to complete
      yield* Effect.sleep("100 millis");

      // Poll for result
      return yield* WF.workflowPoll(ApprovalWorkflow, receipt.executionId);
    }).pipe(
      Effect.provide(approvalHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.runPromise,
    );

    expect(result?._tag).toBe("Success");
    if (result?._tag === "Success") {
      expect(result.value).toBe("test approved: yes");
    }
  });

  it("Activity.make creates a durable checkpointed step", async () => {
    let activityCallCount = 0;

    const ActivityWorkflow = WF.workflow("ActivityTest", {
      payload: { x: Schema.Number },
      idempotencyKey: (p) => String((p as Record<string, number>)["x"] ?? 0),
      success: Schema.Number,
    });

    const activityHandler = WF.workflowHandlers(
      ActivityWorkflow,
      Effect.fn("activityHandler")(function* (payload: { x: number }) {
        const activity = WF.Activity.make({
          name: "double",
          success: Schema.Number,
          execute: Effect.sync(() => {
            activityCallCount++;
            return payload.x * 2;
          }),
        });
        return yield* activity;
      }),
    );

    const result = await Effect.gen(function* () {
      const ref = WF.workflowClient(ActivityWorkflow)("activity-1");
      return yield* ref.call({ x: 21 });
    }).pipe(
      Effect.provide(activityHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.runPromise,
    );

    expect(result).toBe(42);
    expect(activityCallCount).toBeGreaterThan(0);
  });
});

describe("Workflow lifecycle", () => {
  it("ref.interrupt() signals workflow interruption", async () => {
    const InterruptDeferred = WF.DurableDeferred.make("block", {
      success: Schema.String,
    });

    const InterruptWorkflow = WF.workflow("InterruptWork", {
      payload: { x: Schema.Number },
      idempotencyKey: (p) => String((p as Record<string, number>)["x"] ?? 0),
      success: Schema.String,
    });

    const interruptHandler = WF.workflowHandlers(
      InterruptWorkflow,
      Effect.fn("interruptHandler")(function* (_payload: { x: number }) {
        // Block on deferred — will be interrupted instead of completed
        return yield* DurableDeferred.await(InterruptDeferred);
      }),
    );

    const exit = await Effect.gen(function* () {
      const ref = WF.workflowClient(InterruptWorkflow)("int-1");
      // Use call which blocks — interrupt it from outside
      const fiber = yield* ref.call({ x: 1 }).pipe(Effect.fork);

      yield* Effect.sleep("100 millis");
      yield* ref.interrupt();
      yield* Effect.sleep("100 millis");

      return yield* fiber.pipe(Effect.awaitEffect);
    }).pipe(
      Effect.provide(interruptHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.runPromiseExit,
    );

    // The call should have been interrupted
    expect(exit._tag).toBe("Failure");
  });

  it("ref.resume() resumes a suspended workflow", async () => {
    const ResumeDeferred = WF.DurableDeferred.make("resume-signal", {
      success: Schema.String,
    });

    const ResumeWorkflow = WF.workflow("ResumableWork", {
      payload: { id: Schema.String },
      idempotencyKey: (p) => (p as Record<string, string>)["id"] ?? "",
      success: Schema.String,
    });

    const resumeHandler = WF.workflowHandlers(
      ResumeWorkflow,
      Effect.fn("resumeHandler")(function* (payload: { id: string }) {
        const result = yield* DurableDeferred.await(ResumeDeferred);
        return `${payload.id}: ${result}`;
      }),
    );

    const result = await Effect.gen(function* () {
      const ref = WF.workflowClient(ResumeWorkflow)("resume-1");
      const receipt = yield* ref.cast({ id: "r1" });

      // Wait for workflow to suspend on deferred
      yield* Effect.sleep("100 millis");

      // Get token and complete deferred
      const token = yield* DurableDeferred.tokenFromPayload(ResumeDeferred, {
        workflow: ResumeWorkflow.workflow,
        payload: { id: "r1" },
      });

      yield* DurableDeferred.succeed(ResumeDeferred, {
        token,
        value: "resumed",
      });

      // Resume the workflow
      yield* ref.resume();

      yield* Effect.sleep("200 millis");

      return yield* WF.workflowPoll(ResumeWorkflow, receipt.executionId);
    }).pipe(
      Effect.provide(resumeHandler),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.runPromise,
    );

    expect(result?._tag).toBe("Success");
    if (result?._tag === "Success") {
      expect(result.value).toBe("r1: resumed");
    }
  });
});
