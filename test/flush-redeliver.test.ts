import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, Schema } from "effect";
import { TestRunner } from "effect/cluster";
import type { Client } from "../src/index.js";
import { Actor, ClientLayer } from "../src/index.js";

const FlushActor = Actor.fromEntity("FlushActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const flushHandlers = Actor.toLayer(FlushActor, {
  Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
});

const TestCluster = TestRunner.layer;
const flushHandlersLayer = flushHandlers.pipe(Layer.provideMerge(TestCluster));

describe("Actor.flush", () => {
  it.scopedLive("clears all messages for the entity", () =>
    Effect.gen(function* () {
      const makeClient = yield* FlushActor._meta.entity.client;
      const client = makeClient("hello");
      yield* client.Process({ input: "hello" });

      const before = yield* FlushActor.Process.peek({ input: "hello" });
      expect(before._tag).toBe("Success");

      yield* FlushActor.flush("hello");

      const after = yield* FlushActor.Process.peek({ input: "hello" });
      expect(after._tag).toBe("Pending");
    }).pipe(Effect.provide(flushHandlersLayer)),
  );

  it.scopedLive("preserves other entities' messages", () =>
    Effect.gen(function* () {
      const makeClient = yield* FlushActor._meta.entity.client;

      const clientA = makeClient("a");
      yield* clientA.Process({ input: "a" });
      const clientB = makeClient("b");
      yield* clientB.Process({ input: "b" });

      yield* FlushActor.flush("a");

      const flushed = yield* FlushActor.Process.peek({ input: "a" });
      expect(flushed._tag).toBe("Pending");

      const kept = yield* FlushActor.Process.peek({ input: "b" });
      expect(kept._tag).toBe("Success");
    }).pipe(Effect.provide(flushHandlersLayer)),
  );
});

const RedeliverActor = Actor.fromEntity("RedeliverActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const redeliverHandlers = Actor.toLayer(RedeliverActor, {
  Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
});
const redeliverHandlersLayer = redeliverHandlers.pipe(Layer.provideMerge(TestCluster));

describe("Actor.redeliver", () => {
  it.scopedLive("completes without error on processed messages", () =>
    Effect.gen(function* () {
      const makeClient = yield* RedeliverActor._meta.entity.client;
      const client = makeClient("test");
      yield* client.Process({ input: "test" });

      const result = yield* RedeliverActor.Process.peek({ input: "test" });
      expect(result._tag).toBe("Success");

      yield* RedeliverActor.redeliver("test");

      const after = yield* RedeliverActor.Process.peek({ input: "test" });
      expect(after._tag).toBe("Success");
    }).pipe(Effect.provide(redeliverHandlersLayer)),
  );
});

describe("Actor.flush declared R-channel", () => {
  const _flushR: Effect.Effect<void, unknown, Client> = FlushActor.flush("x");
  const _redeliverR: Effect.Effect<void, unknown, Client> = FlushActor.redeliver("x");
  const _interruptR: Effect.Effect<void, unknown, Client> = FlushActor.interrupt("x");
  void _flushR;
  void _redeliverR;
  void _interruptR;

  it.scopedLive("succeeds when provided only the declared `Client` dependency", () =>
    Effect.gen(function* () {
      const result = yield* FlushActor.flush("declared-deps-only").pipe(Effect.exit);
      expect(result._tag).toBe("Success");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );
});
