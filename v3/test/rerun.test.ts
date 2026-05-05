import { describe, expect, it } from "effect-bun-test/v3";
import { Effect, Layer as L, Ref, Schema } from "effect";
import { MessageStorage, TestRunner } from "@effect/cluster";
import {
  Actor,
  ActorAddressResolverLayer,
  EncoreMessageStorage,
  fromMessageStorage,
} from "../src/index.js";

// ── Test layer providing EncoreMessageStorage on top of TestRunner ─────────

// Wire EncoreMessageStorage by reading the MemoryDriver to get access to the
// underlying requests map, then building a deleteEnvelope that surgically
// removes one envelope by requestId.
const EncoreMessageStorageTest = L.effect(
  EncoreMessageStorage,
  Effect.gen(function* () {
    const driver = yield* MessageStorage.MemoryDriver;
    return fromMessageStorage(driver.storage, {
      deleteEnvelope: (requestId) =>
        Effect.sync(() => {
          const id = String(requestId);
          const entry = driver.requests.get(id);
          if (!entry) return;
          driver.unprocessed.delete(entry.envelope);
          driver.requests.delete(id);
          // Also remove from journal so re-send is allowed
          for (let i = driver.journal.length - 1; i >= 0; i--) {
            const env = driver.journal[i]!;
            if (env._tag === "Request" && env.requestId === id) {
              driver.journal.splice(i, 1);
            }
          }
          // Drop the primaryKey index pointing at this entry so re-send dedups fresh
          for (const [pk, e] of driver.requestsByPrimaryKey.entries()) {
            if (e === entry) driver.requestsByPrimaryKey.delete(pk);
          }
        }),
    });
  }),
);

// ── Actor under test ────────────────────────────────────────────────────────

// EncoreMessageStorageTest needs MemoryDriver, which TestRunner.layer provides.
// `provideMerge` keeps the upstream tags in the result alongside the new one.
// ActorAddressResolverLayer.fromSharding satisfies the resolver requirement of
// rerunImpl by reading Sharding from TestRunner.layer.
const TestCluster = ActorAddressResolverLayer.fromSharding.pipe(
  L.provideMerge(EncoreMessageStorageTest),
  L.provideMerge(TestRunner.layer),
);

describe("OperationHandle.rerun", () => {
  it.scopedLive("rerun-of-non-existent-execId is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const RerunActor = Actor.fromEntity("RerunNoop", {
        Process: {
          payload: { input: Schema.String },
          success: Schema.String,
          persisted: true,
          id: (p: { input: string }) => p.input,
        },
      });

      yield* RerunActor.Process.rerun({ input: "never-sent" });
      // No throw, no error — idempotent.
      expect(true).toBe(true);
    }).pipe(Effect.provide(TestCluster)),
  );

  it.scopedLive("rerun clears the persisted envelope so peek returns Pending", () =>
    Effect.gen(function* () {
      const RerunActor = Actor.fromEntity("RerunPeek", {
        Process: {
          payload: { input: Schema.String },
          success: Schema.String,
          persisted: true,
          id: (p: { input: string }) => p.input,
        },
      });

      const handlers = Actor.toLayer(RerunActor, {
        Process: ({ operation }) => Effect.succeed(`done: ${operation.input}`),
      });

      return yield* Effect.gen(function* () {
        const makeClient = yield* RerunActor._meta.entity.client;
        const client = makeClient("alpha");
        yield* client.Process({ input: "alpha" });

        const before = yield* RerunActor.Process.peek({ input: "alpha" });
        expect(before._tag).toBe("Success");

        yield* RerunActor.Process.rerun({ input: "alpha" });

        const after = yield* RerunActor.Process.peek({ input: "alpha" });
        expect(after._tag).toBe("Pending");
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster)),
  );

  it.scopedLive("rerun + resend runs the handler again", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);

      const RerunActor = Actor.fromEntity("RerunReplay", {
        Process: {
          payload: { input: Schema.String },
          success: Schema.Number,
          persisted: true,
          id: (p: { input: string }) => p.input,
        },
      });

      const handlers = Actor.toLayer(RerunActor, {
        Process: () => Ref.updateAndGet(counter, (n) => n + 1),
      });

      return yield* Effect.gen(function* () {
        const makeClient = yield* RerunActor._meta.entity.client;
        const client = makeClient("once");
        yield* client.Process({ input: "once" });
        const first = yield* RerunActor.Process.peek({ input: "once" });
        expect(first._tag).toBe("Success");
        if (first._tag === "Success") expect(first.value).toBe(1);

        yield* RerunActor.Process.rerun({ input: "once" });

        // Re-send via the same client — dedup index should be cleared, allowing
        // a fresh handler invocation.
        yield* client.Process({ input: "once" });

        const second = yield* RerunActor.Process.peek({ input: "once" });
        expect(second._tag).toBe("Success");
        if (second._tag === "Success") expect(second.value).toBe(2);
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster)),
  );

  it.scopedLive("rerun with divergent id clears only the target execId", () =>
    Effect.gen(function* () {
      // entity id is the dedup bucket; primaryKey diverges so two execIds
      // share a single entityId.
      const RerunActor = Actor.fromEntity("RerunDiverge", {
        Trigger: {
          payload: {
            dedup: Schema.String,
            action: Schema.String,
          },
          success: Schema.String,
          persisted: true,
          id: (p: { dedup: string; action: string }) => ({
            entityId: p.dedup,
            primaryKey: `${p.dedup}:${p.action}`,
          }),
        },
      });

      const handlers = Actor.toLayer(RerunActor, {
        Trigger: ({ operation }) => Effect.succeed(`fired:${operation.action}`),
      });

      return yield* Effect.gen(function* () {
        const makeClient = yield* RerunActor._meta.entity.client;
        const client = makeClient("k");
        yield* client.Trigger({ dedup: "k", action: "open" });
        yield* client.Trigger({ dedup: "k", action: "close" });

        const openBefore = yield* RerunActor.Trigger.peek({
          dedup: "k",
          action: "open",
        });
        const closeBefore = yield* RerunActor.Trigger.peek({
          dedup: "k",
          action: "close",
        });
        expect(openBefore._tag).toBe("Success");
        expect(closeBefore._tag).toBe("Success");

        yield* RerunActor.Trigger.rerun({ dedup: "k", action: "open" });

        const openAfter = yield* RerunActor.Trigger.peek({
          dedup: "k",
          action: "open",
        });
        const closeAfter = yield* RerunActor.Trigger.peek({
          dedup: "k",
          action: "close",
        });
        expect(openAfter._tag).toBe("Pending");
        expect(closeAfter._tag).toBe("Success");
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster)),
  );
});
