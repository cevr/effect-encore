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
    id: (p: { msg: string }) => p.msg,
  },
  Fire: {
    payload: { x: Schema.Finite },
    success: Schema.Finite,
    persisted: true,
    id: (p: { x: number }) => String(p.x),
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
  test("operation handle exposes execute/send/peek/watch/waitFor/executionId/rerun/make", () =>
    Effect.sync(() => {
      expect(Echo.Say._tag).toBe("OperationHandle");
      expect(Echo.Say.execute).toBeDefined();
      expect(Echo.Say.send).toBeDefined();
      expect(Echo.Say.peek).toBeDefined();
      expect(Echo.Say.watch).toBeDefined();
      expect(Echo.Say.waitFor).toBeDefined();
      expect(Echo.Say.executionId).toBeDefined();
      expect(Echo.Say.rerun).toBeDefined();
      expect(Echo.Say.make).toBeDefined();
    }));

  test("execute works end-to-end without cluster infrastructure", () =>
    Effect.gen(function* () {
      const result = yield* Echo.Say.execute({ msg: "hello" });
      expect(result).toBe("echo: hello");
    }));

  test("send returns ExecId string", () =>
    Effect.gen(function* () {
      const execId = yield* Echo.Fire.send({ x: 7 });
      expect(typeof execId).toBe("string");
      expect(String(execId)).toBe("7\x00Fire\x007");
    }));

  it.scopedLive("preserves side-effect observation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);

      const Tracker = Actor.fromEntity("Tracker", {
        Track: {
          payload: { item: Schema.String },
          success: Schema.String,
          id: (p: { item: string }) => p.item,
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

      // Provide around the full usage so the client layer is in scope
      return yield* Effect.gen(function* () {
        const result = yield* Tracker.Track.execute({ item: "widget" });
        expect(result).toBe("tracked: widget");

        const recorded = yield* Ref.get(calls);
        expect(recorded).toEqual(["widget"]);
      }).pipe(Effect.provide(TrackerTest));
    }),
  );
});
