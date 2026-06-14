import { S2 } from "@s2-dev/streamstore";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Exit, Fiber, Layer, Option, Schedule, Schema } from "effect";
import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "effect/unstable/workflow";
import { S2WorkflowEngine } from "../src/index.js";
import type { S2WorkflowEngineConfig } from "../src/s2-workflow/index.js";

const basin = "workflow-tests";

let s2Process: ReturnType<typeof Bun.spawn> | undefined;
let tempDir: string;
let config: S2WorkflowEngineConfig;

const waitForLite = async (port: number, attempt = 0, lastError?: unknown): Promise<void> => {
  const s2 = new S2({
    accessToken: "test-token",
    endpoints: {
      account: `http://127.0.0.1:${port}`,
      basin: `http://127.0.0.1:${port}`,
    },
    retry: { maxAttempts: 1 },
  });
  const stream = `ready-${Date.now()}`;
  if (attempt >= 80) {
    throw new Error(`s2 lite did not become ready: ${String(lastError)}`);
  }
  if (s2Process?.killed === true) {
    throw new Error("s2 lite exited early");
  }
  try {
    await s2.basin(basin).streams.ensure({ stream });
  } catch (error) {
    await Effect.runPromise(Effect.sleep("100 millis"));
    await waitForLite(port, attempt + 1, error);
  }
};

beforeAll(async () => {
  const port = 39_000 + (Date.now() % 1_000);
  tempDir = `test/s2-lite-${port}`;
  const initFile = `${tempDir}/init.json`;
  await Bun.spawn(["rm", "-rf", tempDir]).exited;
  await Bun.spawn(["mkdir", "-p", `${tempDir}/data`]).exited;
  await Bun.write(
    initFile,
    JSON.stringify(
      {
        $schema: "https://raw.githubusercontent.com/s2-streamstore/s2/main/cli/schema.json",
        basins: [
          {
            name: basin,
            config: {
              create_stream_on_append: true,
            },
          },
        ],
      },
      null,
      2,
    ),
  );

  s2Process = Bun.spawn(
    [
      "s2",
      "lite",
      "--local-root",
      `${tempDir}/data`,
      "--port",
      String(port),
      "--init-file",
      initFile,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  await waitForLite(port);

  config = {
    basin,
    accessToken: "test-token",
    endpoints: {
      account: `http://127.0.0.1:${port}`,
      basin: `http://127.0.0.1:${port}`,
    },
    streamPrefix: `test-${Date.now()}`,
    runnerId: "runner-a",
    forceTransport: "fetch",
    ownerTtlMillis: 2_000,
    requestTimeoutMillis: 5_000,
  };
});

afterAll(async () => {
  if (s2Process !== undefined && !s2Process.killed) {
    s2Process.kill("SIGTERM");
  }
  if (tempDir !== undefined) {
    await Bun.spawn(["rm", "-rf", tempDir]).exited;
  }
});

const provideWorkflow = <A, E>(
  effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>,
  layer: Layer.Layer<WorkflowEngine.WorkflowEngine>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const withEngine = (
  registrationLayer: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>,
  runnerConfig: S2WorkflowEngineConfig = config,
): Layer.Layer<WorkflowEngine.WorkflowEngine> => {
  const engineLayer = S2WorkflowEngine.layer(runnerConfig);
  return registrationLayer.pipe(Layer.provideMerge(engineLayer));
};

describe("S2WorkflowEngine", () => {
  it("executes and caches a completed workflow", async () => {
    const Greeter = Workflow.make("S2Greeter", {
      payload: { name: Schema.String },
      success: Schema.String,
      idempotencyKey: (payload: { name: string }) => payload.name,
    });
    let runs = 0;
    const layer = withEngine(
      Greeter.toLayer((payload) =>
        Effect.sync(() => {
          runs++;
          return `hello ${payload.name}`;
        }),
      ),
    );

    const first = await provideWorkflow(Greeter.execute({ name: "world" }), layer);
    const second = await provideWorkflow(Greeter.execute({ name: "world" }), layer);

    expect(first).toBe("hello world");
    expect(second).toBe("hello world");
    expect(runs).toBe(1);
  }, 30_000);

  it("starts with discard and later resumes the stored execution", async () => {
    const ResumeWorkflow = Workflow.make("S2ResumeWorkflow", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: (payload: { id: string }) => payload.id,
    });
    const layer = withEngine(
      ResumeWorkflow.toLayer((payload) => Effect.succeed(`resumed:${payload.id}`)),
    );

    const executionId = await provideWorkflow(
      ResumeWorkflow.execute({ id: "resume-1" }, { discard: true }),
      layer,
    );
    await provideWorkflow(ResumeWorkflow.resume(executionId), layer);
    const result = await provideWorkflow(ResumeWorkflow.execute({ id: "resume-1" }), layer);

    expect(result).toBe("resumed:resume-1");
  }, 30_000);

  it("resumes from persisted deferred completion without rerunning completed activity", async () => {
    const Approval = DurableDeferred.make("approval", { success: Schema.String });
    const ApprovalWorkflow = Workflow.make("S2ApprovalWorkflow", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: (payload: { id: string }) => payload.id,
      suspendedRetrySchedule: Schedule.spaced("1 second"),
    });
    let activityRuns = 0;
    const LoadToken = Activity.make({
      name: "load-token",
      success: Schema.String,
      execute: Effect.sync(() => {
        activityRuns++;
        return `token-${activityRuns}`;
      }),
    });
    const makeLayer = (runnerId: string) =>
      withEngine(
        ApprovalWorkflow.toLayer(() =>
          Effect.gen(function* () {
            const token = yield* LoadToken;
            const approval = yield* DurableDeferred.await(Approval);
            return `${token}:${approval}`;
          }),
        ),
        { ...config, runnerId },
      );

    const executionId = await Effect.runPromise(ApprovalWorkflow.executionId({ id: "approval-1" }));

    await provideWorkflow(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(ApprovalWorkflow.execute({ id: "approval-1" }));
        yield* Effect.sleep("350 millis");
        const polled = yield* ApprovalWorkflow.poll(executionId);
        expect(Option.isSome(polled)).toBe(true);
        if (Option.isSome(polled)) {
          expect(polled.value._tag).toBe("Suspended");
        }
        yield* Fiber.interrupt(fiber);
      }),
      makeLayer("runner-a"),
    );
    expect(activityRuns).toBe(1);

    const result = await provideWorkflow(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        yield* engine.deferredDone(Approval, {
          workflowName: ApprovalWorkflow._tag,
          executionId,
          deferredName: Approval.name,
          exit: Exit.succeed("approved"),
        });
        return yield* ApprovalWorkflow.execute({ id: "approval-1" });
      }),
      makeLayer("runner-b"),
    );

    expect(result).toBe("token-1:approved");
    expect(activityRuns).toBe(1);
  }, 30_000);

  it("persists durable clocks and completes after replay", async () => {
    const SleepWorkflow = Workflow.make("S2SleepWorkflow", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: (payload: { id: string }) => payload.id,
    });
    const layer = withEngine(
      SleepWorkflow.toLayer((payload) =>
        Effect.gen(function* () {
          yield* DurableClock.sleep({
            name: "nap",
            duration: "50 millis",
            inMemoryThreshold: "0 millis",
          });
          return `awake:${payload.id}`;
        }),
      ),
    );

    const result = await provideWorkflow(SleepWorkflow.execute({ id: "clock-1" }), layer);

    expect(result).toBe("awake:clock-1");
  }, 30_000);
});
