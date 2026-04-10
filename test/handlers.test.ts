import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor, Handlers, Testing } from "../src/index.js";

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

const handlerLayer = Handlers.handlers(Counter, {
  Increment: (request: any) => Effect.succeed(request.payload.amount + 1),
  GetCount: () => Effect.succeed("hello"),
});

describe("Actor.handlers", () => {
  it("wires plain handler functions — call returns handler result", async () => {
    const program = Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Counter, handlerLayer);
      const ref = yield* makeRef("counter-1");
      const result = yield* ref.Increment.call({ amount: 5 });
      return result;
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig));

    const result = await Effect.runPromise(program);
    expect(result).toBe(6);
  });

  it("handler return value becomes the RPC reply — no explicit .reply()", async () => {
    const program = Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Counter, handlerLayer);
      const ref = yield* makeRef("counter-1");
      return yield* ref.GetCount.call();
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig));

    const result = await Effect.runPromise(program);
    expect(result).toBe("hello");
  });

  it.todo("supports Effect.gen for handlers that need services", () => {});
  it.todo("handler errors become RPC errors", () => {});
  it.todo("handler receives envelope with payload, entityId, operation tag", () => {});
});
