import { describe, expect, it } from "effect-bun-test";
import { Effect, Ref, Schema } from "effect";
import type { Layer } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const test = it.scopedLive.layer(TestShardingConfig);

const Echo = Actor.make("Echo", {
  Say: {
    input: { msg: Schema.String },
    output: Schema.String,
  },
  Fire: {
    input: { x: Schema.Number },
    output: Schema.Number,
    persisted: true,
    primaryKey: (p: { x: number }) => String(p.x),
  },
});

const echoHandlers = Actor.toLayer(Echo, {
  Say: ({ operation }) => Effect.succeed(`echo: ${operation.msg}`),
  Fire: ({ operation }) => Effect.succeed(operation.x * 2),
});

describe("Actor.Test", () => {
  test("creates a test client", () =>
    Effect.gen(function* () {
      const makeRef = yield* Actor.Test(Echo, echoHandlers as unknown as Layer.Layer<never>);
      expect(typeof makeRef).toBe("function");
    }));

  test("call works end-to-end without cluster infrastructure", () =>
    Effect.gen(function* () {
      const makeRef = yield* Actor.Test(Echo, echoHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("test-1");
      const result = yield* ref.call(Echo.Say({ msg: "hello" }));
      expect(result).toBe("echo: hello");
    }));

  test("cast returns CastReceipt in test mode", () =>
    Effect.gen(function* () {
      const makeRef = yield* Actor.Test(Echo, echoHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("test-2");
      const receipt = yield* ref.cast(Echo.Fire({ x: 7 }));
      expect(receipt._tag).toBe("CastReceipt");
      expect(receipt.actorType).toBe("Echo");
      expect(receipt.entityId).toBe("test-2");
      expect(receipt.operation).toBe("Fire");
      expect(receipt.primaryKey).toBe("7");
    }));

  test("testClient preserves layer requirements for side-effect observation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);

      const Tracker = Actor.make("Tracker", {
        Track: {
          input: { item: Schema.String },
          output: Schema.String,
        },
      });

      const trackerHandlers = Actor.toLayer(Tracker, {
        Track: ({ operation }) =>
          Ref.update(calls, (arr) => [...arr, operation.item]).pipe(
            Effect.andThen(Effect.succeed(`tracked: ${operation.item}`)),
          ),
      });

      const makeRef = yield* Actor.Test(Tracker, trackerHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("t-1");
      const result = yield* ref.call(Tracker.Track({ item: "widget" }));
      expect(result).toBe("tracked: widget");

      const recorded = yield* Ref.get(calls);
      expect(recorded).toEqual(["widget"]);
    }));
});
