import { describe, expect, it } from "effect-bun-test";
import { Effect, Schema } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import type { Client } from "../src/index.js";
import { Actor, ClientLayer } from "../src/index.js";

const FlushActor = Actor.fromEntity("FlushActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    // entityId === primaryKey === input
    id: (p: { input: string }) => p.input,
  },
});

const flushHandlers = Actor.toLayer(FlushActor, {
  Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
});

const TestCluster = TestRunner.layer;

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
    }).pipe(Effect.provide(flushHandlers), Effect.provide(TestCluster)),
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
    }).pipe(Effect.provide(flushHandlers), Effect.provide(TestCluster)),
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

describe("Actor.redeliver", () => {
  it.scopedLive("completes without error on processed messages", () =>
    Effect.gen(function* () {
      const makeClient = yield* RedeliverActor._meta.entity.client;
      const client = makeClient("test");
      yield* client.Process({ input: "test" });

      const result = yield* RedeliverActor.Process.peek({ input: "test" });
      expect(result._tag).toBe("Success");

      // Redeliver resets read leases on unprocessed messages
      yield* RedeliverActor.redeliver("test");

      // Already-processed message should still show Success
      const after = yield* RedeliverActor.Process.peek({ input: "test" });
      expect(after._tag).toBe("Success");
    }).pipe(Effect.provide(redeliverHandlers), Effect.provide(TestCluster)),
  );
});

// Regression for the type-vs-runtime divergence on the public `EntityActor`
// control ops: after `flush`/`redeliver`/`interrupt` were repointed through
// `Client.use(...)`, they REQUIRE the deep `Client` Tag at runtime. The
// declared R-channel must say so — providing exactly the DECLARED deps must
// make `flush` succeed. Before the fix the declared R omitted `Client`, so a
// host satisfying the type without `Client` crashed with
// `Service not found: effect-encore/client`.
describe("Actor.flush declared R-channel", () => {
  // Type-level probe: the declared requirement of `flush`/`redeliver`/
  // `interrupt` is EXACTLY `Client` — annotating with `Client` typechecks, and
  // (by exhaustiveness of the single-Tag union) nothing else leaks. If the old
  // storage+resolver union were still declared, this annotation would fail.
  const _flushR: Effect.Effect<void, unknown, Client> = FlushActor.flush("x");
  const _redeliverR: Effect.Effect<void, unknown, Client> = FlushActor.redeliver("x");
  const _interruptR: Effect.Effect<void, unknown, Client> = FlushActor.interrupt("x");
  void _flushR;
  void _redeliverR;
  void _interruptR;

  it.scopedLive("succeeds when provided only the declared `Client` dependency", () =>
    Effect.gen(function* () {
      // Provide EXACTLY the declared R (`Client`) via the self-contained memory
      // adapter — no handler layer, no TestCluster. This is the probe that
      // previously died with `Service not found: effect-encore/client`.
      const result = yield* FlushActor.flush("declared-deps-only").pipe(Effect.exit);
      expect(result._tag).toBe("Success");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );
});
