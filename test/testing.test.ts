import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, Ref, Schema } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Echo = Actor.fromEntity("Echo", {
  Say: {
    payload: { msg: Schema.String },
    success: Schema.String,
    primaryKey: (p: { msg: string }) => p.msg,
  },
  Fire: {
    payload: { x: Schema.Number },
    success: Schema.Number,
    persisted: true,
    primaryKey: (p: { x: number }) => String(p.x),
  },
});

const EchoTest = Layer.provide(
  Actor.toTestLayer(Echo, {
    Say: ({ operation }) => Effect.succeed(`echo: ${operation.msg}`),
    Fire: ({ operation }) => Effect.succeed(operation.x * 2),
  }),
  TestShardingConfig,
);

const test = it.scopedLive.layer(EchoTest);

describe("Actor.toTestLayer", () => {
  test("actor(id) returns an ActorRef", () =>
    Effect.gen(function* () {
      const ref = yield* Echo.actor("test-1");
      expect(ref.execute).toBeDefined();
      expect(ref.send).toBeDefined();
    }));

  test("execute works end-to-end without cluster infrastructure", () =>
    Effect.gen(function* () {
      const ref = yield* Echo.actor("test-1");
      const result = yield* ref.execute(Echo.Say({ msg: "hello" }));
      expect(result).toBe("echo: hello");
    }));

  test("send returns ExecId string", () =>
    Effect.gen(function* () {
      const ref = yield* Echo.actor("test-2");
      const execId = yield* ref.send(Echo.Fire({ x: 7 }));
      expect(typeof execId).toBe("string");
      expect(String(execId)).toBe("test-2\x00Fire\x007");
    }));

  it.scopedLive("preserves side-effect observation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);

      const Tracker = Actor.fromEntity("Tracker", {
        Track: {
          payload: { item: Schema.String },
          success: Schema.String,
          primaryKey: (p: { item: string }) => p.item,
        },
      });

      const TrackerTest = Layer.provide(
        Actor.toTestLayer(Tracker, {
          Track: ({ operation }) =>
            Ref.update(calls, (arr) => [...arr, operation.item]).pipe(
              Effect.as(`tracked: ${operation.item}`),
            ),
        }),
        TestShardingConfig,
      );

      // Provide around the full usage — don't let ActorRef escape the provider scope
      return yield* Effect.gen(function* () {
        const ref = yield* Tracker.actor("t-1");
        const result = yield* ref.execute(Tracker.Track({ item: "widget" }));
        expect(result).toBe("tracked: widget");

        const recorded = yield* Ref.get(calls);
        expect(recorded).toEqual(["widget"]);
      }).pipe(Effect.provide(TrackerTest));
    }),
  );
});
