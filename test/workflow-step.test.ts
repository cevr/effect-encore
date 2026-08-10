import { describe, expect, it, test } from "effect-bun-test";
import { Effect, Exit, Option, Result, Schedule, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";
import { Actor, PendingCompensation } from "../src/index.js";

// ── Basic workflow with step.run shorthand ─────────────────────────────

const Greeter = Actor.fromWorkflow("Greeter", {
  payload: { name: Schema.String },
  success: Schema.String,
  id: (p: { name: string }) => p.name,
});

const GreeterTest = Actor.toTestLayer(Greeter, (payload, step) =>
  Effect.gen(function* () {
    const greeting = yield* step.run("greet", Effect.succeed(`hello ${payload.name}`));
    return greeting;
  }),
);

// ── Workflow with step.run full options ─────────────────────────────────

const Calculator = Actor.fromWorkflow("Calculator", {
  payload: { x: Schema.Finite, y: Schema.Finite },
  success: Schema.Finite,
  id: (p: { x: number; y: number }) => `${p.x}+${p.y}`,
});

const CalculatorTest = Actor.toTestLayer(Calculator, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run("add", {
      do: Effect.succeed(payload.x + payload.y),
      success: Schema.Finite,
    });
    return result;
  }),
);

// ── Workflow with step.run 3-arg (undo) shorthand ──────────────────────

const WithUndo = Actor.fromWorkflow("WithUndo", {
  payload: { input: Schema.String },
  success: Schema.String,
  id: (p: { input: string }) => p.input,
});

const WithUndoTest = Actor.toTestLayer(WithUndo, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run(
      "do-work",
      Effect.succeed(`done: ${payload.input}`),
      (_value, _cause) => Effect.void,
    );
    return result;
  }),
);

// ── Workflow with step.sleep ───────────────────────────────────────────

const Sleeper = Actor.fromWorkflow("Sleeper", {
  payload: { ms: Schema.Finite },
  success: Schema.String,
  id: (p: { ms: number }) => String(p.ms),
});

const SleeperTest = Actor.toTestLayer(Sleeper, (payload, step) =>
  Effect.gen(function* () {
    yield* step.sleep("nap", `${payload.ms} millis`);
    return "awake";
  }),
);

// ── Workflow with errors ──────────────────────────────────────────────

class StepError extends Schema.TaggedError<StepError>()("StepError", {
  reason: Schema.String,
}) {}

const Failable = Actor.fromWorkflow("Failable", {
  payload: { input: Schema.String },
  success: Schema.String,
  error: StepError,
  id: (p: { input: string }) => p.input,
});

const FailableTest = Actor.toTestLayer(Failable, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run("check", {
      do: Effect.suspend(() => {
        if (payload.input === "bad") {
          return Effect.fail(StepError.make({ reason: "invalid" }));
        }
        return Effect.succeed(`ok: ${payload.input}`);
      }),
      success: Schema.String,
      error: StepError,
    });
    return result;
  }),
);

// ── Workflow with retry ───────────────────────────────────────────────

let retryAttempts: number[] = [];

const Retrier = Actor.fromWorkflow("Retrier", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: StepError,
  id: (p: { id: string }) => p.id,
});

const RetrierTest = Actor.toTestLayer(Retrier, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run("flaky", {
      do: Effect.gen(function* () {
        const attempt = yield* step.attempt;
        retryAttempts.push(attempt);
        if (attempt < 3) {
          return yield* StepError.make({ reason: `failed attempt ${attempt}` });
        }
        return `done: ${payload.id}`;
      }),
      success: Schema.String,
      error: StepError,
      retry: { times: 2 },
    });
    return result;
  }),
);

// ── Workflow with executionId + attempt ────────────────────────────────

const Inspector = Actor.fromWorkflow("Inspector", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
});

const InspectorTest = Actor.toTestLayer(Inspector, (_payload, step) =>
  Effect.gen(function* () {
    const attempt = yield* step.attempt;
    return `execId=${step.executionId},attempt=${attempt}`;
  }),
);

// ── Workflow with nullary actor + waitFor ──────────────────────────────

const WaitTarget = Actor.fromWorkflow("WaitTarget", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
});

const WaitTargetTest = Actor.toTestLayer(WaitTarget, (payload, step) =>
  Effect.gen(function* () {
    yield* step.run("work", Effect.succeed(`result: ${payload.id}`));
    return `result: ${payload.id}`;
  }),
);

// ── Workflow with annotations ─────────────────────────────────────────

const Annotated = Actor.fromWorkflow("Annotated", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
  captureDefects: false,
  suspendOnFailure: true,
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("step.run — shorthand", () => {
  it.scopedLive.layer(GreeterTest)("executes and returns result", () =>
    Effect.gen(function* () {
      const result = yield* Greeter.execute({ name: "world" });
      expect(result).toBe("hello world");
    }),
  );
});

describe("step.run — full options", () => {
  it.scopedLive.layer(CalculatorTest)("executes with success schema", () =>
    Effect.gen(function* () {
      const result = yield* Calculator.execute({ x: 3, y: 4 });
      expect(result).toBe(7);
    }),
  );
});

describe("step.run — 3-arg undo shorthand", () => {
  it.scopedLive.layer(WithUndoTest)("executes with undo callback", () =>
    Effect.gen(function* () {
      const result = yield* WithUndo.execute({ input: "test" });
      expect(result).toBe("done: test");
    }),
  );
});

describe("step.sleep", () => {
  it.scopedLive.layer(SleeperTest)("sleeps and returns", () =>
    Effect.gen(function* () {
      const result = yield* Sleeper.execute({ ms: 10 });
      expect(result).toBe("awake");
    }),
  );
});

describe("step.run — full options with error", () => {
  it.scopedLive.layer(FailableTest)("success path works", () =>
    Effect.gen(function* () {
      const result = yield* Failable.execute({ input: "good" });
      expect(result).toBe("ok: good");
    }),
  );

  it.scopedLive.layer(FailableTest)("error path surfaces typed error", () =>
    Effect.gen(function* () {
      const exit = yield* Failable.execute({ input: "bad" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("step.run — retry", () => {
  it.scopedLive.layer(RetrierTest)("executes with retry config", () =>
    Effect.gen(function* () {
      retryAttempts = [];
      const result = yield* Retrier.execute({ id: "r1" });
      expect(result).toBe("done: r1");
      expect(retryAttempts).toEqual([1, 2, 3]);
    }),
  );
});

describe("step.executionId + step.attempt", () => {
  it.scopedLive.layer(InspectorTest)("exposes executionId and attempt", () =>
    Effect.gen(function* () {
      const result = yield* Inspector.execute({ id: "i1" });
      expect(result).toContain("execId=");
      expect(result).toContain("attempt=");
    }),
  );
});

describe("send + waitFor", () => {
  it.scopedLive.layer(WaitTargetTest)("send works for workflow", () =>
    Effect.gen(function* () {
      const execId = yield* WaitTarget.send({ id: "w1" });
      expect(typeof execId).toBe("string");
    }),
  );

  it.scopedLive.layer(WaitTargetTest)("waitFor polls until terminal", () =>
    Effect.gen(function* () {
      yield* WaitTarget.send({ id: "w2" });
      const result = yield* WaitTarget.waitFor({ id: "w2" });
      expect(result._tag).toBe("Success");
    }),
  );
});

describe("WorkflowDef annotations", () => {
  test("captureDefects and suspendOnFailure wire through", () => {
    expect(Annotated._tag).toBe("WorkflowActor");
    expect(Annotated._meta.name).toBe("Annotated");
  });
});

// ── Declarative signals ─────────────────────────────────────────────

const SignalWorkflow = Actor.fromWorkflow("SignalWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
  signals: {
    Approval: { success: Schema.String },
    Cancel: {},
  },
});

describe("declarative signals", () => {
  test("signal properties exist on actor", () => {
    expect(SignalWorkflow.Approval).toBeDefined();
    expect(SignalWorkflow.Approval.name).toBe("Approval");
    expect(SignalWorkflow.Approval.deferred).toBeDefined();
    expect(SignalWorkflow.Approval.await).toBeDefined();
    expect(SignalWorkflow.Approval.token).toBeDefined();
    expect(SignalWorkflow.Approval.succeed).toBeDefined();
    expect(SignalWorkflow.Approval.fail).toBeDefined();
    expect(SignalWorkflow.Approval.failCause).toBeDefined();
    expect(SignalWorkflow.Approval.done).toBeDefined();
    expect(SignalWorkflow.Approval.into).toBeDefined();
    expect(SignalWorkflow.Approval.tokenFromExecutionId).toBeDefined();
    expect(SignalWorkflow.Approval.tokenFromPayload).toBeDefined();
    expect(SignalWorkflow.Approval.succeedAt).toBeDefined();
    expect(SignalWorkflow.Approval.failAt).toBeDefined();
  });

  test("void signal defaults work", () => {
    expect(SignalWorkflow.Cancel).toBeDefined();
    expect(SignalWorkflow.Cancel.name).toBe("Cancel");
    expect(SignalWorkflow.Cancel.await).toBeDefined();
  });

  test("collision guard throws for reserved signal names", () => {
    expect(() =>
      Actor.fromWorkflow("BadSignal", {
        payload: { id: Schema.String },
        id: (p: { id: string }) => p.id,
        signals: { peek: {} },
      }),
    ).toThrow(/collides with reserved/);
  });

  test("compensation is a reserved signal name", () => {
    expect(() =>
      Actor.fromWorkflow("BadCompensationSignal", {
        payload: { id: Schema.String },
        id: (p: { id: string }) => p.id,
        signals: { compensation: {} },
      }),
    ).toThrow(/collides with reserved/);
  });
});

// ── Durable compensation ───────────────────────────────────────────────

const DurableCompensation = Actor.fromWorkflow("DurableCompensation", {
  payload: { id: Schema.String },
  error: StepError,
  id: (p: { id: string }) => p.id,
});

let earlierRuns = 0;
let laterRuns = 0;
let failingRuns = 0;
let earlierCompensations = 0;
let laterCompensations = 0;
let compensationOrder: string[] = [];

const DurableCompensationTest = Actor.toTestLayer(DurableCompensation, (payload, step) =>
  Effect.gen(function* () {
    yield* step.run("earlier", {
      do: Effect.sync(() => {
        earlierRuns++;
      }),
      undo: () =>
        Effect.suspend(() => {
          earlierCompensations++;
          compensationOrder.push(`earlier:${earlierCompensations}`);
          if (
            earlierCompensations === 1 ||
            (payload.id === "two-failures" && earlierCompensations === 2)
          ) {
            return StepError.make({ reason: "retry earlier compensation" });
          }
          return Effect.void;
        }),
    });
    yield* step.run("later", {
      do: Effect.sync(() => {
        laterRuns++;
      }),
      undo: () =>
        Effect.sync(() => {
          laterCompensations++;
          compensationOrder.push(`later:${laterCompensations}`);
        }),
    });
    return yield* step.run("fail", {
      do: Effect.sync(() => {
        failingRuns++;
        return StepError.make({ reason: "workflow failed" });
      }).pipe(Effect.flatMap(Effect.fail)),
      error: StepError,
    });
  }),
);

const InterruptCompensation = Actor.fromWorkflow("InterruptCompensation", {
  payload: { id: Schema.String },
  id: (payload: { id: string }) => payload.id,
});

let interruptCompensations = 0;

const InterruptCompensationTest = Actor.toTestLayer(InterruptCompensation, (_payload, step) =>
  Effect.gen(function* () {
    yield* step.run("registered", {
      do: Effect.void,
      undo: () =>
        Effect.sync(() => {
          interruptCompensations++;
        }),
    });
    return yield* step.suspend;
  }),
);

describe("step.run — durable compensation", () => {
  it.scopedLive.layer(DurableCompensationTest)(
    "replays completed compensations and waits for a failed attempt decision",
    () =>
      Effect.gen(function* () {
        earlierRuns = 0;
        laterRuns = 0;
        failingRuns = 0;
        earlierCompensations = 0;
        laterCompensations = 0;
        compensationOrder = [];

        const payload = { id: "durable-compensation" };
        const executionId = yield* DurableCompensation.send(payload);
        const suspended = yield* DurableCompensation.waitFor(payload, {
          filter: (result) => result._tag === "Suspended",
        });

        expect(suspended._tag).toBe("Suspended");
        expect(compensationOrder).toEqual(["later:1", "earlier:1"]);
        expect(yield* DurableCompensation.compensation.pending(executionId)).toEqual(
          Option.some(PendingCompensation.make({ stepId: "earlier", attempt: 1 })),
        );

        const wrongStep = yield* DurableCompensation.compensation
          .retry(executionId, "missing", 1)
          .pipe(Effect.flip);
        const wrongAttempt = yield* DurableCompensation.compensation
          .retry(executionId, "earlier", 2)
          .pipe(Effect.flip);
        const invalidAttempt = yield* DurableCompensation.compensation
          .retry(executionId, "earlier", 0)
          .pipe(Effect.flip);
        expect(wrongStep).toHaveProperty("_tag", "CompensationDecisionConflictError");
        expect(wrongAttempt).toHaveProperty("_tag", "CompensationDecisionConflictError");
        expect(invalidAttempt).toHaveProperty("_tag", "CompensationDecisionConflictError");

        yield* DurableCompensation.compensation.retry(executionId, "earlier", 1);
        const completed = yield* DurableCompensation.waitFor(payload);

        expect(completed._tag).toBe("Failure");
        expect(earlierRuns).toBe(1);
        expect(laterRuns).toBe(1);
        expect(failingRuns).toBe(1);
        expect(earlierCompensations).toBe(2);
        expect(laterCompensations).toBe(1);
        expect(compensationOrder).toEqual(["later:1", "earlier:1", "earlier:2"]);
        expect(yield* DurableCompensation.compensation.pending(executionId)).toEqual(Option.none());

        yield* DurableCompensation.compensation.retry(executionId, "earlier", 1);
        const conflictingDecision = yield* DurableCompensation.compensation
          .stop(executionId, "earlier", 1)
          .pipe(Effect.flip);
        expect(conflictingDecision).toHaveProperty("_tag", "CompensationDecisionConflictError");
        if (conflictingDecision._tag === "CompensationDecisionConflictError") {
          expect(conflictingDecision.acceptedDecision).toEqual(Option.some("Retry"));
        }
      }),
  );

  it.scopedLive.layer(DurableCompensationTest)("publishes each failed compensation attempt", () =>
    Effect.gen(function* () {
      earlierRuns = 0;
      laterRuns = 0;
      failingRuns = 0;
      earlierCompensations = 0;
      laterCompensations = 0;
      compensationOrder = [];

      const payload = { id: "two-failures" };
      const executionId = yield* DurableCompensation.send(payload);
      yield* DurableCompensation.waitFor(payload, {
        filter: (result) => result._tag === "Suspended",
      });
      yield* DurableCompensation.compensation.retry(executionId, "earlier", 1);

      const pending = yield* DurableCompensation.compensation.pending(executionId).pipe(
        Effect.repeat({
          while: Option.match({
            onNone: () => true,
            onSome: ({ attempt }) => attempt !== 2,
          }),
          schedule: Schedule.spaced("10 millis"),
        }),
      );
      expect(pending).toEqual(
        Option.some(PendingCompensation.make({ stepId: "earlier", attempt: 2 })),
      );

      yield* DurableCompensation.compensation.stop(executionId, "earlier", 2);
      expect((yield* DurableCompensation.waitFor(payload))._tag).toBe("Failure");
      expect(earlierCompensations).toBe(2);
    }),
  );

  it.scopedLive.layer(InterruptCompensationTest)("does not compensate an interrupt", () =>
    Effect.gen(function* () {
      interruptCompensations = 0;

      const payload = { id: "interrupt-compensation" };
      const executionId = yield* InterruptCompensation.send(payload);
      yield* InterruptCompensation.waitFor(payload, {
        filter: (result) => result._tag === "Suspended",
      });

      expect(yield* InterruptCompensation.compensation.pending(executionId)).toEqual(Option.none());
      const error = yield* InterruptCompensation.compensation
        .retry(executionId, "registered", 1)
        .pipe(Effect.flip);
      expect(error).toHaveProperty("_tag", "CompensationNotPendingError");

      yield* InterruptCompensation.interrupt(executionId);
      const completed = yield* InterruptCompensation.waitFor(payload);

      expect(completed._tag).toBe("Interrupted");
      expect(interruptCompensations).toBe(0);
    }),
  );

  it.scopedLive.layer(DurableCompensationTest)("accepts one concurrent compensation decision", () =>
    Effect.gen(function* () {
      earlierRuns = 0;
      laterRuns = 0;
      failingRuns = 0;
      earlierCompensations = 0;
      laterCompensations = 0;
      compensationOrder = [];

      const payload = { id: "concurrent-decisions" };
      const executionId = yield* DurableCompensation.send(payload);
      yield* DurableCompensation.waitFor(payload, {
        filter: (result) => result._tag === "Suspended",
      });

      const results = yield* Effect.all(
        [
          DurableCompensation.compensation.decidePending(executionId, "Retry"),
          DurableCompensation.compensation.decidePending(executionId, "Stop"),
        ].map(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure)).toHaveLength(1);
      for (const result of results) {
        if (Result.isFailure(result)) {
          expect(["CompensationNotPendingError", "CompensationDecisionConflictError"]).toContain(
            result.failure._tag,
          );
        }
      }
      expect((yield* DurableCompensation.waitFor(payload))._tag).toBe("Failure");
    }),
  );

  it.scopedLive.layer(DurableCompensationTest)(
    "clears a pending compensation when the workflow ends",
    () =>
      Effect.gen(function* () {
        earlierRuns = 0;
        laterRuns = 0;
        failingRuns = 0;
        earlierCompensations = 0;
        laterCompensations = 0;
        compensationOrder = [];

        const payload = { id: "interrupt-pending-compensation" };
        const executionId = yield* DurableCompensation.send(payload);
        yield* DurableCompensation.waitFor(payload, {
          filter: (result) => result._tag === "Suspended",
        });
        yield* DurableCompensation.interrupt(executionId);
        expect((yield* DurableCompensation.waitFor(payload))._tag).toBe("Interrupted");
        expect(yield* DurableCompensation.compensation.pending(executionId)).toEqual(Option.none());

        const error = yield* DurableCompensation.compensation
          .stop(executionId, "earlier", 1)
          .pipe(Effect.flip);
        expect(error).toHaveProperty("_tag", "CompensationNotPendingError");
      }),
  );

  it.scopedLive.layer(DurableCompensationTest)("stops a failed compensation", () =>
    Effect.gen(function* () {
      earlierRuns = 0;
      laterRuns = 0;
      failingRuns = 0;
      earlierCompensations = 0;
      laterCompensations = 0;
      compensationOrder = [];

      const payload = { id: "stop-durable-compensation" };
      const executionId = yield* DurableCompensation.send(payload);
      const suspended = yield* DurableCompensation.waitFor(payload, {
        filter: (result) => result._tag === "Suspended",
      });

      expect(suspended._tag).toBe("Suspended");
      yield* DurableCompensation.compensation.stop(executionId, "earlier", 1);

      const completed = yield* DurableCompensation.waitFor(payload);

      expect(completed._tag).toBe("Failure");
      expect(earlierRuns).toBe(1);
      expect(laterRuns).toBe(1);
      expect(failingRuns).toBe(1);
      expect(earlierCompensations).toBe(1);
      expect(laterCompensations).toBe(1);
      expect(compensationOrder).toEqual(["later:1", "earlier:1"]);
    }),
  );
});

// ── Signal round-trip inside workflow ─────────────────────────────────

const SignalTest = Actor.toTestLayer(SignalWorkflow, (_payload, _step) =>
  Effect.gen(function* () {
    const result = yield* SignalWorkflow.Approval.await;
    return `got: ${result}`;
  }),
);

describe("signal — inside handler", () => {
  it.scopedLive.layer(SignalTest)("signal delivery by execution ID round-trips", () =>
    Effect.gen(function* () {
      const payload = { id: "sig-1" };
      const executionId = yield* SignalWorkflow.executionId(payload);
      yield* SignalWorkflow.Approval.succeedAt(executionId, "approved");
      const result = yield* SignalWorkflow.execute(payload);
      expect(result).toBe("got: approved");
    }),
  );
});

// ── step.race ─────────────────────────────────────────────────────────

const RaceWorkflow = Actor.fromWorkflow("RaceWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
});

const RaceTest = Actor.toTestLayer(RaceWorkflow, (_payload, step) =>
  Effect.gen(function* () {
    const winner = yield* step.race("pick-fastest", [
      { name: "fast", execute: Effect.succeed("fast-wins") },
      { name: "slow", execute: Effect.delay(Effect.succeed("slow-wins"), "1 second") },
    ]);
    return winner;
  }),
);

describe("step.race", () => {
  it.scopedLive.layer(RaceTest)("first to complete wins", () =>
    Effect.gen(function* () {
      const result = yield* RaceWorkflow.execute({ id: "race-1" });
      expect(result).toBe("fast-wins");
    }),
  );
});

// ── waitFor with custom filter/schedule ───────────────────────────────

describe("waitFor — custom options", () => {
  it.scopedLive.layer(WaitTargetTest)("waitFor with custom filter and schedule", () =>
    Effect.gen(function* () {
      yield* WaitTarget.send({ id: "w-custom" });
      const result = yield* WaitTarget.waitFor(
        { id: "w-custom" },
        {
          filter: (r) => r._tag === "Success",
          schedule: Schedule.spaced("50 millis"),
        },
      );
      expect(result._tag).toBe("Success");
    }),
  );
});

// ── step.executionId ──────────────────────────────────────────────────

const IdKeyWorkflow = Actor.fromWorkflow("IdKeyWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  id: (p: { id: string }) => p.id,
});

const IdKeyTest = Actor.toTestLayer(IdKeyWorkflow, (_payload, step) =>
  Effect.gen(function* () {
    const key = yield* step.idempotencyKey("my-step");
    const attemptKey = yield* step.idempotencyKey("my-step", { includeAttempt: true });
    const effectKey = yield* Activity.idempotencyKey("my-step");
    const effectAttemptKey = yield* Activity.idempotencyKey("my-step", {
      includeAttempt: true,
    });
    return [key, attemptKey, effectKey, effectAttemptKey].join("|");
  }),
);

describe("step.idempotencyKey", () => {
  it.scopedLive.layer(IdKeyTest)("delegates to Effect Activity", () =>
    Effect.gen(function* () {
      const result = yield* IdKeyWorkflow.execute({ id: "idem-1" });
      const [key, attemptKey, effectKey, effectAttemptKey] = result.split("|");
      expect(key).toBe(effectKey);
      expect(attemptKey).toBe(effectAttemptKey);
    }),
  );
});
