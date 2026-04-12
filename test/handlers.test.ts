import { describe, expect, it } from "effect-bun-test";
import { Effect, Exit, Layer, Schema } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Counter = Actor.fromEntity("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
    primaryKey: (p: { amount: number }) => String(p.amount),
  },
  GetCount: {
    success: Schema.String,
    primaryKey: () => "singleton",
  },
});

const CounterTest = Layer.provide(
  Actor.toTestLayer(Counter, {
    Increment: ({ operation }) => Effect.succeed(operation.amount + 1),
    GetCount: () => Effect.succeed("hello"),
  }),
  TestShardingConfig,
);

const test = it.scopedLive.layer(CounterTest);

// ── GenActor for deferred construction test ─────────────────────────────

const GenActor = Actor.fromEntity("GenActor", {
  Compute: {
    payload: { x: Schema.Number },
    success: Schema.Number,
    primaryKey: (p: { x: number }) => String(p.x),
  },
});

const GenActorTest = Layer.provide(
  Actor.toTestLayer(
    GenActor,
    Effect.succeed({
      Compute: ({ operation }: { operation: { x: number } }) => Effect.succeed(operation.x * 10),
    } as const),
  ),
  TestShardingConfig,
);

// ── ErrActor for error test ─────────────────────────────────────────────

class HandlerError extends Schema.TaggedErrorClass<HandlerError>()("HandlerError", {
  reason: Schema.String,
}) {}

const ErrActor = Actor.fromEntity("ErrActor", {
  Fail: {
    payload: { input: Schema.String },
    error: HandlerError,
    primaryKey: (p: { input: string }) => p.input,
  },
});

const ErrActorTest = Layer.provide(
  Actor.toTestLayer(ErrActor, {
    Fail: () => Effect.fail(new HandlerError({ reason: "bad" })),
  }),
  TestShardingConfig,
);

// ── InspectActor for operation inspection test ──────────────────────────

const InspectActor = Actor.fromEntity("InspectActor", {
  Inspect: {
    payload: { value: Schema.String },
    success: Schema.String,
    primaryKey: (p: { value: string }) => p.value,
  },
});

describe("Actor.toLayer", () => {
  test("wires plain handler functions — execute returns handler result", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-1");
      const result = yield* ref.execute(Counter.Increment({ amount: 5 }));
      expect(result).toBe(6);
    }));

  test("handler return value becomes the RPC reply — no explicit .reply()", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-1");
      const result = yield* ref.execute(Counter.GetCount());
      expect(result).toBe("hello");
    }));

  it.scopedLive.layer(GenActorTest)(
    "supports Effect.succeed for handlers that need deferred construction",
    () =>
      Effect.gen(function* () {
        const ref = yield* GenActor.actor("gen-1");
        const result = yield* ref.execute(GenActor.Compute({ x: 7 }));
        expect(result).toBe(70);
      }),
  );

  it.scopedLive.layer(ErrActorTest)("handler errors become RPC errors", () =>
    Effect.gen(function* () {
      const ref = yield* ErrActor.actor("err-1");
      const exit = yield* ref.execute(ErrActor.Fail({ input: "test" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.scopedLive.layer(
    Layer.provide(
      Actor.toTestLayer(InspectActor, {
        Inspect: ({ operation }) => Effect.succeed(`got: ${operation.value}`),
      }),
      TestShardingConfig,
    ),
  )("handler receives request with operation — operation has _tag and fields", () =>
    Effect.gen(function* () {
      const ref = yield* InspectActor.actor("inspect-1");
      const result = yield* ref.execute(InspectActor.Inspect({ value: "hello" }));
      expect(result).toBe("got: hello");
    }),
  );
});
