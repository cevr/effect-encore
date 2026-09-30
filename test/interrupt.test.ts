import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, Schema } from "effect";
import { TestRunner } from "effect/cluster";
import { Actor } from "../src/index.js";

// `interrupt(entityId)` is wired to the same `clearAddress` semantics as
// `flush` — it stops accepting new work for the entity by clearing the
// pending mailbox. Programmatic in-flight fiber cancellation requires
// upstream `Sharding.passivate`, which is not yet a public API. So:
// - Pending/persisted messages are cleared.
// - In-flight handlers run to completion (documented behavior).

describe("Actor.interrupt", () => {
  it.scopedLive("clears pending persisted messages for the target entity", () => {
    const InterruptActor = Actor.fromEntity("InterruptActor", {
      Process: {
        payload: { input: Schema.String },
        success: Schema.String,
        persisted: true,
        id: (p: { input: string }) => p.input,
      },
    });

    const handlers = Actor.toLayer(InterruptActor, {
      Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
    }).pipe(Layer.provideMerge(TestRunner.layer));

    return Effect.gen(function* () {
      const makeClient = yield* InterruptActor._meta.entity.client;
      const client = makeClient("hello");
      yield* client.Process({ input: "hello" });

      const before = yield* InterruptActor.Process.peek({ input: "hello" });
      expect(before._tag).toBe("Success");

      yield* InterruptActor.interrupt("hello");

      const after = yield* InterruptActor.Process.peek({ input: "hello" });
      expect(after._tag).toBe("Pending");
    }).pipe(Effect.provide(handlers));
  });

  it.scopedLive("interrupt of one entity does not affect another", () => {
    const InterruptActor = Actor.fromEntity("InterruptIsolation", {
      Process: {
        payload: { input: Schema.String },
        success: Schema.String,
        persisted: true,
        id: (p: { input: string }) => p.input,
      },
    });

    const handlers = Actor.toLayer(InterruptActor, {
      Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
    }).pipe(Layer.provideMerge(TestRunner.layer));

    return Effect.gen(function* () {
      const makeClient = yield* InterruptActor._meta.entity.client;
      const clientA = makeClient("a");
      const clientB = makeClient("b");
      yield* clientA.Process({ input: "a" });
      yield* clientB.Process({ input: "b" });

      yield* InterruptActor.interrupt("a");

      const cleared = yield* InterruptActor.Process.peek({ input: "a" });
      const kept = yield* InterruptActor.Process.peek({ input: "b" });
      expect(cleared._tag).toBe("Pending");
      expect(kept._tag).toBe("Success");
    }).pipe(Effect.provide(handlers));
  });

  it.scopedLive("interrupt is idempotent — calling twice on a clean entity is a no-op", () => {
    const InterruptActor = Actor.fromEntity("InterruptIdempotent", {
      Process: {
        payload: { input: Schema.String },
        success: Schema.String,
        persisted: true,
        id: (p: { input: string }) => p.input,
      },
    });

    const handlers = Actor.toLayer(InterruptActor, {
      Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
    }).pipe(Layer.provideMerge(TestRunner.layer));

    return Effect.gen(function* () {
      yield* InterruptActor.interrupt("never-touched");
      yield* InterruptActor.interrupt("never-touched");
      // No throw — idempotent.
      expect(true).toBe(true);
    }).pipe(Effect.provide(handlers));
  });
});
