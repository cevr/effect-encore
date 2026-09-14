import { describe, expect, it } from "effect-bun-test";
import { Context, Effect, Fiber, Layer, Schema, Stream, SubscriptionRef } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor, ActorStateRegistry, listStateEntityIds, stateOf } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Stateful = Actor.fromEntity(
  "Stateful",
  {
    Increment: {
      payload: { id: Schema.String, amount: Schema.Finite },
      success: Schema.Finite,
      id: (p: { id: string }) => p.id,
    },
  },
  { state: { schema: Schema.Finite } },
);

const StatefulLayer = Layer.provide(
  Actor.toTestLayer(
    Stateful,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(0);
      const state = Actor.State.makeReadable(
        SubscriptionRef.get(ref),
        SubscriptionRef.changes(ref),
      );
      yield* Actor.registerState(state);
      return Stateful.of({
        Increment: ({ operation }) =>
          SubscriptionRef.updateAndGet(ref, (current) => current + operation.amount),
      });
    }),
  ),
  TestShardingConfig,
);

const test = it.scopedLive.layer(StatefulLayer);

class StateSource extends Context.Service<StateSource, { readonly value: number }>()(
  "effect-encore/test/actor-state.test/StateSource",
) {}

const Contextual = Actor.fromEntity(
  "ContextualState",
  {
    Read: {
      payload: { id: Schema.String },
      success: Schema.Finite,
      id: (payload: { id: string }) => payload.id,
    },
  },
  { state: { schema: Schema.Finite } },
);

const contextualRead = Effect.map(StateSource, (source) => source.value);
const ContextualLayer = Actor.toTestLayer(
  Contextual,
  Effect.gen(function* () {
    yield* Actor.registerState(
      Actor.State.makeReadable(contextualRead, Stream.fromEffect(contextualRead)),
    );
    return Contextual.of({ Read: () => contextualRead });
  }),
).pipe(
  Layer.provide(Layer.succeed(StateSource, StateSource.of({ value: 42 }))),
  Layer.provide(TestShardingConfig),
);

const contextualTest = it.scopedLive.layer(ContextualLayer);

const Coerced = Actor.fromEntity(
  "Coerced",
  {
    Touch: {
      payload: { id: Schema.String },
      id: (p: { id: string }) => p.id,
    },
  },
  { state: { schema: Schema.FiniteFromString } },
);

const CoercedLayer = Layer.provide(
  Actor.toTestLayer(
    Coerced,
    Effect.gen(function* () {
      // The registered state's `get` returns the pre-decode wire value
      // ("42"); the registry decodes it through `state.schema`
      // (`Schema.NumberFromString`) on read.
      // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- The encoded-state fixture must cross the registry's decoded number type to verify string decoding.
      const ref = yield* SubscriptionRef.make("42" as unknown as number);
      const state = yield* Actor.State.make(SubscriptionRef.get(ref), (value) =>
        SubscriptionRef.set(ref, value),
      );
      yield* Actor.registerState(state);
      return Coerced.of({ Touch: () => Effect.void });
    }),
  ),
  TestShardingConfig,
);

const coercedTest = it.scopedLive.layer(CoercedLayer);

describe("Actor state protocol", () => {
  contextualTest("captures readable state requirements when the actor registers", () =>
    Effect.gen(function* () {
      expect(yield* Contextual.getState("contextual")).toBe(42);
      expect(
        Array.from(
          yield* Contextual.watchState("contextual").pipe(Stream.take(1), Stream.runCollect),
        ),
      ).toEqual([42]);
    }),
  );

  test("cold getState materializes an entity before reading registered state", () =>
    Effect.gen(function* () {
      const value = yield* Stateful.getState("cold-counter");
      expect(value).toBe(0);
    }));

  test("cold watchState materializes an entity before subscribing to registered state", () =>
    Effect.gen(function* () {
      const fiber = yield* Stateful.watchState("cold-watch").pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("cold-watch");
      yield* ref.execute(Stateful.Increment.make({ id: "cold-watch", amount: 4 }));

      const values = Array.from(yield* Fiber.join(fiber));
      expect(values).toEqual([0, 4]);
    }));

  test("materializes an entity and reads its registered state", () =>
    Effect.gen(function* () {
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("counter");
      const value = yield* Stateful.getState("counter", {
        materialize: ref.execute(Stateful.Increment.make({ id: "counter", amount: 2 })),
      });
      expect(value).toBe(2);

      const next = yield* ref.execute(Stateful.Increment.make({ id: "counter", amount: 3 }));
      expect(next).toBe(5);
      expect(yield* Stateful.getState("counter")).toBe(5);
    }));

  test("State service exposes bound state operations", () =>
    Effect.gen(function* () {
      const state = yield* Stateful.State;
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("state-service");
      yield* ref.execute(Stateful.Increment.make({ id: "state-service", amount: 3 }));

      expect(yield* state.get("state-service")).toBe(3);
      expect(yield* state.waitFor("state-service", (value) => value >= 3)).toBe(3);
      expect(yield* state.listEntityIds).toContain("state-service");
    }));

  test("the state registry is reachable from the barrel without an actor client", () =>
    Effect.gen(function* () {
      // A consumer that sits *beneath* an actor cannot yield that actor's
      // `State` client to enumerate entities: the actor is built from the layer
      // that would then depend on it. `ActorStateRegistry` is merged into the
      // consumer's context by `toLayer`, so reading it directly is the
      // cycle-free route — but only if the Tag is exported.
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("registry-direct");
      yield* ref.execute(Stateful.Increment.make({ id: "registry-direct", amount: 1 }));

      const registry = yield* ActorStateRegistry;
      expect(yield* registry.list("Stateful")).toContain("registry-direct");
      expect(yield* listStateEntityIds("Stateful")).toContain("registry-direct");
    }));

  test("reads registered state by entity type and id without a shard", () =>
    Effect.gen(function* () {
      // The registry keys on type + id. A consumer that enumerated ids through
      // `listStateEntityIds` holds no `ShardId`, so `stateOf` accepts the pair
      // directly; a full `EntityAddress` still satisfies the same key.
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("keyed");
      yield* ref.execute(Stateful.Increment.make({ id: "keyed", amount: 7 }));

      expect(yield* stateOf<number>({ entityType: "Stateful", entityId: "keyed" })).toBe(7);
    }));

  test("Control service exposes bound mailbox operations", () =>
    Effect.gen(function* () {
      const control = yield* Stateful.Control;
      yield* control.redeliver("control-service");
      yield* control.flush("control-service");
      yield* control.interrupt("control-service");
    }));

  test("watches state changes for one entity", () =>
    Effect.gen(function* () {
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("watched");
      yield* ref.execute(Stateful.Increment.make({ id: "watched", amount: 1 }));

      const fiber = yield* Stateful.watchState("watched").pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* ref.execute(Stateful.Increment.make({ id: "watched", amount: 4 }));

      const values = Array.from(yield* Fiber.join(fiber));
      expect(values).toEqual([1, 5]);
    }));

  test("fails loudly when the materialized entity registers no state", () => {
    const Stateless = Actor.fromEntity("Stateless", {
      Ping: {
        payload: { id: Schema.String },
        id: (p: { id: string }) => p.id,
      },
    });
    const StatelessLayer = Layer.provide(
      Actor.toTestLayer(Stateless, {
        Ping: () => Effect.void,
      }),
      TestShardingConfig,
    );

    return Effect.gen(function* () {
      const exit = yield* Stateless.getState("missing").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("ActorStateUnavailable");
      }
    }).pipe(Effect.provide(StatelessLayer));
  });

  test("waitForState resolves when predicate matches a future state", () =>
    Effect.gen(function* () {
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("wait-future");

      const fiber = yield* Stateful.waitForState("wait-future", (n) => n >= 5).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* ref.execute(Stateful.Increment.make({ id: "wait-future", amount: 2 }));
      yield* ref.execute(Stateful.Increment.make({ id: "wait-future", amount: 4 }));

      const result = yield* Fiber.join(fiber);
      expect(result).toBe(6);
    }));

  test("waitForState resolves immediately on a current state that matches", () =>
    Effect.gen(function* () {
      const makeRef = yield* Stateful.Context;
      const ref = yield* makeRef("wait-current");
      yield* ref.execute(Stateful.Increment.make({ id: "wait-current", amount: 7 }));

      const result = yield* Stateful.waitForState("wait-current", (n) => n >= 5);
      expect(result).toBe(7);
    }));

  coercedTest("getState decodes the registered handle through state.schema", () =>
    Effect.gen(function* () {
      const value = yield* Coerced.getState("decoded");
      expect(value).toBe(42);
    }),
  );
});
