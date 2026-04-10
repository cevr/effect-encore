import { describe, expect, it } from "bun:test";
import type { Layer } from "effect";
import { Effect, Schema } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor, Testing } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Counter = Actor.make("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
  },
  GetCount: {
    success: Schema.String,
  },
});

const handlerLayer = Counter.entity.toLayer({
  Increment: (request) => Effect.succeed(request.payload.amount + 1),
  GetCount: () => Effect.succeed("hello"),
}) as unknown as Layer.Layer<never>;

describe("Actor.handlers", () => {
  it("wires plain handler functions — call returns handler result", async () => {
    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Counter, handlerLayer);
      const ref = yield* makeRef("counter-1");
      return yield* ref["Increment"]!.call({ amount: 5 });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe(6);
  });

  it("handler return value becomes the RPC reply — no explicit .reply()", async () => {
    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Counter, handlerLayer);
      const ref = yield* makeRef("counter-1");
      return yield* ref["GetCount"]!.call();
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("hello");
  });

  it("supports Effect.gen for handlers that need services", async () => {
    const GenActor = Actor.make("GenActor", {
      Compute: {
        payload: { x: Schema.Number },
        success: Schema.Number,
      },
    });

    const genHandlers = GenActor.entity.toLayer(
      Effect.succeed({
        Compute: (req) => Effect.succeed(req.payload.x * 10),
      } as const),
    ) as unknown as Layer.Layer<never>;

    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(GenActor, genHandlers);
      const ref = yield* makeRef("gen-1");
      return yield* ref["Compute"]!.call({ x: 7 });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe(70);
  });

  it("handler errors become RPC errors", async () => {
    class HandlerError extends Schema.TaggedErrorClass<HandlerError>()("HandlerError", {
      reason: Schema.String,
    }) {}

    const ErrActor = Actor.make("ErrActor", {
      Fail: {
        payload: { input: Schema.String },
        success: Schema.Void,
        error: HandlerError,
      },
    });

    const errHandlers = ErrActor.entity.toLayer({
      Fail: (_req) => Effect.fail(new HandlerError({ reason: "bad" })),
    }) as unknown as Layer.Layer<never>;

    const exit = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(ErrActor, errHandlers);
      const ref = yield* makeRef("err-1");
      return yield* ref["Fail"]!.call({ input: "test" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromiseExit);

    expect(exit._tag).toBe("Failure");
  });

  it("handler receives request with payload", async () => {
    let receivedPayload: unknown = null;

    const InspectActor = Actor.make("InspectActor", {
      Inspect: {
        payload: { value: Schema.String },
        success: Schema.String,
      },
    });

    const inspectHandlers = InspectActor.entity.toLayer({
      Inspect: (req) => {
        receivedPayload = req.payload;
        return Effect.succeed(`got: ${req.payload.value}`);
      },
    }) as unknown as Layer.Layer<never>;

    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(InspectActor, inspectHandlers);
      const ref = yield* makeRef("inspect-1");
      return yield* ref["Inspect"]!.call({ value: "hello" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("got: hello");
    expect(receivedPayload).toEqual({ value: "hello" });
  });
});
