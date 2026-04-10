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

  it.todo("supports Effect.gen for handlers that need services", () => {});
  it.todo("handler errors become RPC errors", () => {});
  it.todo("handler receives envelope with payload, entityId, operation tag", () => {});
});
