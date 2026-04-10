import { describe, expect, it } from "effect-bun-test";
import { Effect, Ref, Schema } from "effect";
import type { Layer } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor, Testing } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const test = it.scopedLive.layer(TestShardingConfig);

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
  test("creates a test client via Entity.makeTestClient", () =>
    Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Echo, echoHandlers);
      expect(typeof makeRef).toBe("function");
    }));

  test("call works end-to-end without cluster infrastructure", () =>
    Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Echo, echoHandlers);
      const ref = yield* makeRef("test-1");
      const result = yield* ref["Say"]!.call({ msg: "hello" });
      expect(result).toBe("echo: hello");
    }));

  test("cast returns CastReceipt in test mode", () =>
    Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Echo, echoHandlers);
      const ref = yield* makeRef("test-2");
      const receipt = yield* ref["Fire"]!.cast({ x: 7 });
      expect(receipt._tag).toBe("CastReceipt");
      expect(receipt.actorType).toBe("Echo");
      expect(receipt.entityId).toBe("test-2");
      expect(receipt.operation).toBe("Fire");
      expect(receipt.primaryKey).toBe("7");
    }));

  test("testSingleClient works for single-op actors", () =>
    Effect.gen(function* () {
      const SingleEcho = Actor.single("SingleEcho", {
        payload: { msg: Schema.String },
        success: Schema.String,
      });

      const singleHandlers = SingleEcho.entity.toLayer({
        SingleEcho: (req) => Effect.succeed(`single: ${req.payload.msg}`),
      }) as unknown as Layer.Layer<never>;

      const makeRef = yield* Testing.testSingleClient(SingleEcho, singleHandlers);
      const ref = yield* makeRef("s-1");
      const result = yield* ref.call({ msg: "hi" });
      expect(result).toBe("single: hi");
    }));

  test("testClient preserves layer requirements for side-effect observation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);

      const Tracker = Actor.make("Tracker", {
        Track: {
          payload: { item: Schema.String },
          success: Schema.String,
        },
      });

      // Handler that records calls to a Ref — observable from outside
      const trackerHandlers = Tracker.entity.toLayer({
        Track: (req) =>
          Ref.update(calls, (arr) => [...arr, req.payload.item]).pipe(
            Effect.andThen(Effect.succeed(`tracked: ${req.payload.item}`)),
          ),
      }) as unknown as Layer.Layer<never>;

      const makeRef = yield* Testing.testClient(Tracker, trackerHandlers);
      const ref = yield* makeRef("t-1");
      const result = yield* ref["Track"]!.call({ item: "widget" });
      expect(result).toBe("tracked: widget");

      const recorded = yield* Ref.get(calls);
      expect(recorded).toEqual(["widget"]);
    }));
});
