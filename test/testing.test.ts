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

const Echo = Actor.make("Echo", {
  Say: {
    payload: { msg: Schema.String },
    success: Schema.String,
  },
  Fire: {
    payload: { x: Schema.Number },
    success: Schema.Number,
    persisted: true,
    primaryKey: (p: { x: number }) => String(p.x),
  },
});

const echoHandlers = Echo.entity.toLayer({
  Say: (req) => Effect.succeed(`echo: ${req.payload.msg}`),
  Fire: (req) => Effect.succeed(req.payload.x * 2),
}) as unknown as Layer.Layer<never>;

describe("Actor.testClient", () => {
  it("creates a test client via Entity.makeTestClient", async () => {
    const makeRef = await Effect.gen(function* () {
      return yield* Testing.testClient(Echo, echoHandlers);
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(typeof makeRef).toBe("function");
  });

  it("call works end-to-end without cluster infrastructure", async () => {
    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Echo, echoHandlers);
      const ref = yield* makeRef("test-1");
      return yield* ref["Say"]!.call({ msg: "hello" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("echo: hello");
  });

  it("cast returns CastReceipt in test mode", async () => {
    const receipt = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Echo, echoHandlers);
      const ref = yield* makeRef("test-2");
      return yield* ref["Fire"]!.cast({ x: 7 });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(receipt._tag).toBe("CastReceipt");
    expect(receipt.actorType).toBe("Echo");
    expect(receipt.entityId).toBe("test-2");
    expect(receipt.operation).toBe("Fire");
    expect(receipt.primaryKey).toBe("7");
  });

  it("testSingleClient works for single-op actors", async () => {
    const SingleEcho = Actor.single("SingleEcho", {
      payload: { msg: Schema.String },
      success: Schema.String,
    });

    const singleHandlers = SingleEcho.entity.toLayer({
      SingleEcho: (req) => Effect.succeed(`single: ${req.payload.msg}`),
    }) as unknown as Layer.Layer<never>;

    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testSingleClient(SingleEcho, singleHandlers);
      const ref = yield* makeRef("s-1");
      return yield* ref.call({ msg: "hi" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("single: hi");
  });
});
