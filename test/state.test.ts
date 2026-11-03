import { describe, expect, it } from "effect-bun-test";
import { Array as Arr, Effect, Fiber, Option, Stream, SubscriptionRef } from "effect";
import { State } from "../src/index.js";

const makeCounter = (initial: number) =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(initial);
    const state = yield* State.make(SubscriptionRef.get(ref), (value: number) =>
      SubscriptionRef.set(ref, value),
    );
    return { state, ref };
  });

describe("State", () => {
  it.scopedLive("makeReadable follows changes from an external state owner", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(0);
      const state = State.makeReadable(SubscriptionRef.get(ref), SubscriptionRef.changes(ref));
      const collected = yield* State.changes(state).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* SubscriptionRef.set(ref, 1);

      expect(yield* State.get(state)).toBe(1);
      expect(Array.from(yield* Fiber.join(collected))).toEqual([0, 1]);
    }),
  );

  it.effect("get reads the current value", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(7);
      expect(yield* State.get(state)).toBe(7);
    }),
  );

  it.effect("set replaces the value and writes through to the backing store", () =>
    Effect.gen(function* () {
      const { state, ref } = yield* makeCounter(0);
      yield* State.set(state, 42);
      expect(yield* State.get(state)).toBe(42);
      expect(yield* SubscriptionRef.get(ref)).toBe(42);
    }),
  );

  it.effect("update applies the function to the current value", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(10);
      yield* State.update(state, (n) => n + 5);
      expect(yield* State.get(state)).toBe(15);
    }),
  );

  it.effect("updateAndGet returns the new value", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(1);
      const next = yield* State.updateAndGet(state, (n) => n * 3);
      expect(next).toBe(3);
      expect(yield* State.get(state)).toBe(3);
    }),
  );

  it.effect("modify returns the old value and sets the new", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(100);
      const previous = yield* State.modify(state, (n): readonly [number, number] => [n, n + 1]);
      expect(previous).toBe(100);
      expect(yield* State.get(state)).toBe(101);
    }),
  );

  it.effect("100 concurrent updates are serialized — every increment lands", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(0);
      yield* Effect.forEach(Arr.range(1, 100), () => State.update(state, (n) => n + 1), {
        concurrency: 100,
      });
      expect(yield* State.get(state)).toBe(100);
    }),
  );

  it.scopedLive("changes replays the latest value to a late subscriber (replay = 1)", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(0);
      yield* State.set(state, 1);
      yield* State.set(state, 2);
      const latest = yield* Stream.runHead(Stream.take(State.changes(state), 1));
      expect(latest).toEqual(Option.some(2));
    }),
  );

  it.scopedLive("changes observes every committed write in order", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(0);
      const collected = yield* State.changes(state).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* State.set(state, 1);
      yield* State.set(state, 2);
      yield* State.set(state, 3);
      const values = Array.from(yield* Fiber.join(collected));
      expect(values).toEqual([0, 1, 2, 3]);
    }),
  );

  it.effect("publish feeds the change stream without writing the backing store", () =>
    Effect.gen(function* () {
      const { state, ref } = yield* makeCounter(0);
      const accepted = yield* State.publish(state, 99);
      expect(accepted).toBe(true);
      expect(yield* SubscriptionRef.get(ref)).toBe(0);
      expect(yield* State.get(state)).toBe(0);
    }),
  );

  it.scopedLive("publish is serialized against in-flight writes", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(0);
      const collected = yield* State.changes(state).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* State.set(state, 1);
      yield* State.publish(state, 2);
      const values = Array.from(yield* Fiber.join(collected));
      expect(values).toEqual([0, 1, 2]);
    }),
  );

  it.effect("isState recognizes a State and rejects non-State values", () =>
    Effect.gen(function* () {
      const { state } = yield* makeCounter(0);
      expect(State.isState(state)).toBe(true);
      expect(State.isState({})).toBe(false);
      // oxlint-disable-next-line effect/noNullish -- the public guard must reject null input
      expect(State.isState(null)).toBe(false);
    }),
  );
});
