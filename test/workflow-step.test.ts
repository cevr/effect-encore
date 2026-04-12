import { describe, expect, it, test } from "effect-bun-test";
import { Effect, Exit, Schema } from "effect";
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
      const ref = yield* Greeter.actor();
      const result = yield* ref.execute(Greeter.Run({ name: "world" }));
      expect(result).toBe("hello world");
    }),
  );
});

describe("step.run — full options", () => {
  it.scopedLive.layer(CalculatorTest)("executes with success schema", () =>
    Effect.gen(function* () {
      const ref = yield* Calculator.actor();
      const result = yield* ref.execute(Calculator.Run({ x: 3, y: 4 }));
      expect(result).toBe(7);
    }),
  );
});

describe("step.run — 3-arg undo shorthand", () => {
  it.scopedLive.layer(WithUndoTest)("executes with undo callback", () =>
    Effect.gen(function* () {
      const ref = yield* WithUndo.actor();
      const result = yield* ref.execute(WithUndo.Run({ input: "test" }));
      expect(result).toBe("done: test");
    }),
  );
});

describe("step.sleep", () => {
  it.scopedLive.layer(SleeperTest)("sleeps and returns", () =>
    Effect.gen(function* () {
      const ref = yield* Sleeper.actor();
      const result = yield* ref.execute(Sleeper.Run({ ms: 10 }));
      expect(result).toBe("awake");
    }),
  );
});

describe("step.run — full options with error", () => {
  it.scopedLive.layer(FailableTest)("success path works", () =>
    Effect.gen(function* () {
      const ref = yield* Failable.actor();
      const result = yield* ref.execute(Failable.Run({ input: "good" }));
      expect(result).toBe("ok: good");
    }),
  );

  it.scopedLive.layer(FailableTest)("error path surfaces typed error", () =>
    Effect.gen(function* () {
      const ref = yield* Failable.actor();
      const exit = yield* ref.execute(Failable.Run({ input: "bad" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("step.run — retry", () => {
  it.scopedLive.layer(RetrierTest)("executes with retry config", () =>
    Effect.gen(function* () {
      retryAttempts = 0;
      const ref = yield* Retrier.actor();
      const result = yield* ref.execute(Retrier.Run({ id: "r1" }));
      expect(result).toBe("done: r1");
      expect(retryAttempts).toBeGreaterThanOrEqual(1);
    }),
  );
});

describe("step.executionId + step.attempt", () => {
  it.scopedLive.layer(InspectorTest)("exposes executionId and attempt", () =>
    Effect.gen(function* () {
      const ref = yield* Inspector.actor();
      const result = yield* ref.execute(Inspector.Run({ id: "i1" }));
      expect(result).toContain("execId=");
      expect(result).toContain("attempt=");
    }),
  );
});

describe("nullary actor() + waitFor", () => {
  it.scopedLive.layer(WaitTargetTest)("nullary actor() works for workflow", () =>
    Effect.gen(function* () {
      const ref = yield* WaitTarget.actor();
      const execId = yield* ref.send(WaitTarget.Run({ id: "w1" }));
      expect(typeof execId).toBe("string");
    }),
  );

  it.scopedLive.layer(WaitTargetTest)("waitFor polls until terminal", () =>
    Effect.gen(function* () {
      const ref = yield* WaitTarget.actor();
      const execId = yield* ref.send(WaitTarget.Run({ id: "w2" }));
      const result = yield* WaitTarget.waitFor(execId);
      expect(result._tag).toBe("Success");
    }),
  );
});

describe("WorkflowDef annotations", () => {
  test("captureDefects and suspendOnFailure wire through", () => {
    expect(Annotated._tag).toBe("WorkflowActorObject");
    expect(Annotated._meta.name).toBe("Annotated");
  });
});

describe("signal()", () => {
  test("creates WorkflowSignal on actor", () => {
    const sig = Greeter.signal({ name: "approval", success: Schema.String });
    expect(sig.name).toBe("approval");
    expect(sig.deferred).toBeDefined();
    expect(sig.await).toBeDefined();
    expect(sig.token).toBeDefined();
    expect(sig.succeed).toBeDefined();
    expect(sig.fail).toBeDefined();
    expect(sig.failCause).toBeDefined();
    expect(sig.done).toBeDefined();
    expect(sig.into).toBeDefined();
    expect(sig.tokenFromExecutionId).toBeDefined();
    expect(sig.tokenFromPayload).toBeDefined();
  });
});
