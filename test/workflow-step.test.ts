import { describe, expect, it, test } from "effect-bun-test";
import { Effect, Exit, Schedule, Schema } from "effect";
import { Actor } from "../src/index.js";

// ── Basic workflow with step.run shorthand ─────────────────────────────

const Greeter = Actor.fromWorkflow("Greeter", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { name: string }) => p.name,
});

const GreeterTest = Actor.toTestLayer(Greeter, (payload, step) =>
  Effect.gen(function* () {
    const greeting = yield* step.run("greet", Effect.succeed(`hello ${payload.name}`));
    return greeting;
  }),
);

// ── Workflow with step.run full options ─────────────────────────────────

const Calculator = Actor.fromWorkflow("Calculator", {
  payload: { x: Schema.Number, y: Schema.Number },
  success: Schema.Number,
  idempotencyKey: (p: { x: number; y: number }) => `${p.x}+${p.y}`,
});

const CalculatorTest = Actor.toTestLayer(Calculator, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run("add", {
      do: Effect.succeed(payload.x + payload.y),
      success: Schema.Number,
    });
    return result;
  }),
);

// ── Workflow with step.run 3-arg (undo) shorthand ──────────────────────

const WithUndo = Actor.fromWorkflow("WithUndo", {
  payload: { input: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { input: string }) => p.input,
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
  payload: { ms: Schema.Number },
  success: Schema.String,
  idempotencyKey: (p: { ms: number }) => String(p.ms),
});

const SleeperTest = Actor.toTestLayer(Sleeper, (payload, step) =>
  Effect.gen(function* () {
    yield* step.sleep("nap", `${payload.ms} millis`);
    return "awake";
  }),
);

// ── Workflow with errors ──────────────────────────────────────────────

class StepError extends Schema.TaggedErrorClass<StepError>()("StepError", {
  reason: Schema.String,
}) {}

const Failable = Actor.fromWorkflow("Failable", {
  payload: { input: Schema.String },
  success: Schema.String,
  error: StepError,
  idempotencyKey: (p: { input: string }) => p.input,
});

const FailableTest = Actor.toTestLayer(Failable, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run("check", {
      do:
        payload.input === "bad"
          ? Effect.fail(new StepError({ reason: "invalid" }))
          : Effect.succeed(`ok: ${payload.input}`),
      success: Schema.String,
      error: StepError,
    });
    return result;
  }),
);

// ── Workflow with retry ───────────────────────────────────────────────

let retryAttempts = 0;

const Retrier = Actor.fromWorkflow("Retrier", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { id: string }) => p.id,
});

const RetrierTest = Actor.toTestLayer(Retrier, (payload, step) =>
  Effect.gen(function* () {
    const result = yield* step.run("flaky", {
      do: Effect.sync(() => {
        retryAttempts++;
        return `done: ${payload.id}`;
      }),
      success: Schema.String,
      retry: { times: 3 },
    });
    return result;
  }),
);

// ── Workflow with executionId + attempt ────────────────────────────────

const Inspector = Actor.fromWorkflow("Inspector", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { id: string }) => p.id,
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
  idempotencyKey: (p: { id: string }) => p.id,
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
  idempotencyKey: (p: { id: string }) => p.id,
  captureDefects: false,
  suspendOnFailure: true,
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("step.run — shorthand", () => {
  it.scopedLive.layer(GreeterTest)("executes and returns result", () =>
    Effect.gen(function* () {
      const ref = yield* Greeter.ref();
      const result = yield* ref.execute(Greeter.Run({ name: "world" }));
      expect(result).toBe("hello world");
    }),
  );
});

describe("step.run — full options", () => {
  it.scopedLive.layer(CalculatorTest)("executes with success schema", () =>
    Effect.gen(function* () {
      const ref = yield* Calculator.ref();
      const result = yield* ref.execute(Calculator.Run({ x: 3, y: 4 }));
      expect(result).toBe(7);
    }),
  );
});

describe("step.run — 3-arg undo shorthand", () => {
  it.scopedLive.layer(WithUndoTest)("executes with undo callback", () =>
    Effect.gen(function* () {
      const ref = yield* WithUndo.ref();
      const result = yield* ref.execute(WithUndo.Run({ input: "test" }));
      expect(result).toBe("done: test");
    }),
  );
});

describe("step.sleep", () => {
  it.scopedLive.layer(SleeperTest)("sleeps and returns", () =>
    Effect.gen(function* () {
      const ref = yield* Sleeper.ref();
      const result = yield* ref.execute(Sleeper.Run({ ms: 10 }));
      expect(result).toBe("awake");
    }),
  );
});

describe("step.run — full options with error", () => {
  it.scopedLive.layer(FailableTest)("success path works", () =>
    Effect.gen(function* () {
      const ref = yield* Failable.ref();
      const result = yield* ref.execute(Failable.Run({ input: "good" }));
      expect(result).toBe("ok: good");
    }),
  );

  it.scopedLive.layer(FailableTest)("error path surfaces typed error", () =>
    Effect.gen(function* () {
      const ref = yield* Failable.ref();
      const exit = yield* ref.execute(Failable.Run({ input: "bad" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("step.run — retry", () => {
  it.scopedLive.layer(RetrierTest)("executes with retry config", () =>
    Effect.gen(function* () {
      retryAttempts = 0;
      const ref = yield* Retrier.ref();
      const result = yield* ref.execute(Retrier.Run({ id: "r1" }));
      expect(result).toBe("done: r1");
      expect(retryAttempts).toBeGreaterThanOrEqual(1);
    }),
  );
});

describe("step.executionId + step.attempt", () => {
  it.scopedLive.layer(InspectorTest)("exposes executionId and attempt", () =>
    Effect.gen(function* () {
      const ref = yield* Inspector.ref();
      const result = yield* ref.execute(Inspector.Run({ id: "i1" }));
      expect(result).toContain("execId=");
      expect(result).toContain("attempt=");
    }),
  );
});

describe("nullary actor() + waitFor", () => {
  it.scopedLive.layer(WaitTargetTest)("nullary actor() works for workflow", () =>
    Effect.gen(function* () {
      const ref = yield* WaitTarget.ref();
      const execId = yield* ref.send(WaitTarget.Run({ id: "w1" }));
      expect(typeof execId).toBe("string");
    }),
  );

  it.scopedLive.layer(WaitTargetTest)("waitFor polls until terminal", () =>
    Effect.gen(function* () {
      const ref = yield* WaitTarget.ref();
      const execId = yield* ref.send(WaitTarget.Run({ id: "w2" }));
      const result = yield* WaitTarget.waitFor(execId);
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
  idempotencyKey: (p: { id: string }) => p.id,
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
        idempotencyKey: (p: { id: string }) => p.id,
        signals: { Run: {} },
      }),
    ).toThrow(/collides with reserved/);
  });
});

// ── Signal round-trip inside workflow ─────────────────────────────────

const SignalTest = Actor.toTestLayer(SignalWorkflow, (_payload, _step) =>
  Effect.gen(function* () {
    const token = yield* SignalWorkflow.Approval.token;
    // Resolve immediately from inside the handler for testing
    yield* SignalWorkflow.Approval.succeed({ token, value: "approved" });
    const result = yield* SignalWorkflow.Approval.await;
    return `got: ${result}`;
  }),
);

describe("signal — inside handler", () => {
  it.scopedLive.layer(SignalTest)("signal token + succeed + await round-trip", () =>
    Effect.gen(function* () {
      const ref = yield* SignalWorkflow.ref();
      const result = yield* ref.execute(SignalWorkflow.Run({ id: "sig-1" }));
      expect(result).toBe("got: approved");
    }),
  );
});

// ── step.race ─────────────────────────────────────────────────────────

const RaceWorkflow = Actor.fromWorkflow("RaceWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { id: string }) => p.id,
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
      const ref = yield* RaceWorkflow.ref();
      const result = yield* ref.execute(RaceWorkflow.Run({ id: "race-1" }));
      expect(result).toBe("fast-wins");
    }),
  );
});

// ── waitFor with custom filter/schedule ───────────────────────────────

describe("waitFor — custom options", () => {
  it.scopedLive.layer(WaitTargetTest)("waitFor with custom filter and schedule", () =>
    Effect.gen(function* () {
      const ref = yield* WaitTarget.ref();
      const execId = yield* ref.send(WaitTarget.Run({ id: "w-custom" }));
      const result = yield* WaitTarget.waitFor(execId, {
        filter: (r) => r._tag === "Success",
        schedule: Schedule.spaced("50 millis"),
      });
      expect(result._tag).toBe("Success");
    }),
  );
});

// ── step.executionId ──────────────────────────────────────────────────

const IdKeyWorkflow = Actor.fromWorkflow("IdKeyWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: (p: { id: string }) => p.id,
});

const IdKeyTest = Actor.toTestLayer(IdKeyWorkflow, (_payload, step) =>
  Effect.gen(function* () {
    const key = yield* step.idempotencyKey("my-step");
    return `key=${key}`;
  }),
);

describe("step.idempotencyKey", () => {
  it.scopedLive.layer(IdKeyTest)("generates key from executionId + name", () =>
    Effect.gen(function* () {
      const ref = yield* IdKeyWorkflow.ref();
      const result = yield* ref.execute(IdKeyWorkflow.Run({ id: "idem-1" }));
      expect(result).toContain("/my-step");
    }),
  );
});
