import { describe, expect, it } from "effect-bun-test";
import { Effect, Fiber, Layer, Schedule, Schema, Stream, SubscriptionRef } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Stateful = Actor.fromEntity("Stateful", {
  Increment: {
    payload: { id: Schema.String, amount: Schema.Number },
    success: Schema.Number,
    id: (p: { id: string }) => p.id,
  },
});

const StatefulLayer = Layer.provide(
  Actor.toTestLayer(
    Stateful,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make(0);
      yield* Actor.registerState({
        get: SubscriptionRef.get(state),
        watch: Stream.fromEffectSchedule(
          SubscriptionRef.get(state),
          Schedule.spaced("10 millis"),
        ).pipe(Stream.changesWith((a, b) => a === b)),
      });
      return Stateful.of({
        Increment: ({ operation }) =>
          SubscriptionRef.updateAndGet(state, (current) => current + operation.amount),
      });
    }),
  ),
  TestShardingConfig,
);

const test = it.scopedLive.layer(StatefulLayer);

describe("Actor state protocol", () => {
  test("materializes an entity and reads its registered state", () =>
    Effect.gen(function* () {
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("counter");
      const value = yield* Stateful.getState<number>("counter", {
        materialize: ref.execute(Stateful.Increment.make({ id: "counter", amount: 2 })),
      });
      expect(value).toBe(2);

      const next = yield* ref.execute(Stateful.Increment.make({ id: "counter", amount: 3 }));
      expect(next).toBe(5);
      expect(yield* Stateful.getState<number>("counter")).toBe(5);
    }));

  test("watches state changes for one entity", () =>
    Effect.gen(function* () {
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("watched");
      yield* ref.execute(Stateful.Increment.make({ id: "watched", amount: 1 }));

      const fiber = yield* Stateful.watchState<number>("watched").pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* ref.execute(Stateful.Increment.make({ id: "watched", amount: 4 }));

      const values = Array.from(yield* Fiber.join(fiber));
      expect(values).toEqual([1, 5]);
    }));

  test("fails loudly when no entity state is registered", () =>
    Effect.gen(function* () {
      const exit = yield* Stateful.getState<number>("missing").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("ActorStateUnavailable");
      }
    }));
});
