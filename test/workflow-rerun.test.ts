import { describe, expect, it } from "effect-bun-test";
import { Effect, Fiber, Layer as L, Ref, Schema } from "effect";
import { ClusterWorkflowEngine, MessageStorage, TestRunner } from "effect/unstable/cluster";
import type * as Envelope from "effect/unstable/cluster/Envelope";
import { Actor, EncoreMessageStorage, fromMessageStorage } from "../src/index.js";

// ── Test layer providing EncoreMessageStorage on top of TestRunner ─────────

// MemoryDriver's upstream `clearAddress` clears journal/requests/unprocessed
// but does NOT touch `requestsByPrimaryKey` (the dedup index). Without
// clearing that index, a re-execute after rerun returns the cached completion
// reply instead of running the handler again. We wrap clearAddress here to
// surgically wipe primaryKey entries that point at the cleared address.
const EncoreMessageStorageTest = L.effect(
  EncoreMessageStorage,
  Effect.gen(function* () {
    const driver = yield* MessageStorage.MemoryDriver;
    const baseClearAddress = driver.storage.clearAddress;
    return fromMessageStorage(
      {
        ...driver.storage,
        clearAddress: (address) =>
          Effect.gen(function* () {
            // Snapshot every primaryKey entry whose envelope sits at this
            // address before the upstream clearAddress drops the requests map.
            const toDelete: string[] = [];
            for (const [pk, entry] of driver.requestsByPrimaryKey.entries()) {
              const env = entry.envelope as { address: { entityType: string; entityId: string } };
              if (
                env.address.entityType === address.entityType &&
                env.address.entityId === address.entityId
              ) {
                toDelete.push(pk);
              }
            }
            yield* baseClearAddress(address);
            for (const pk of toDelete) driver.requestsByPrimaryKey.delete(pk);
          }),
      },
      {
        // deleteEnvelope is unused by workflow rerun; stub it.
        deleteEnvelope: () => Effect.void,
      },
    );
  }),
);

// Wire WorkflowEngine over the TestRunner's MessageStorage + Sharding (the
// real cluster engine, not layerMemory) so clearAddress actually wipes state.
const TestCluster = L.provideMerge(
  L.merge(EncoreMessageStorageTest, ClusterWorkflowEngine.layer),
  TestRunner.layer,
);

describe("WorkflowActor.rerun", () => {
  it.scopedLive("rerun-of-completed-workflow lets re-execute trigger handler again", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);

      const Replay = Actor.fromWorkflow("ReplayWorkflow", {
        payload: { id: Schema.String },
        success: Schema.Number,
        id: (p: { id: string }) => p.id,
      });

      const handlers = Actor.toLayer(Replay, () => Ref.updateAndGet(counter, (n) => n + 1));

      return yield* Effect.gen(function* () {
        const first = yield* Replay.execute({ id: "alpha" });
        expect(first).toBe(1);

        const before = yield* Replay.peek({ id: "alpha" });
        expect(before._tag).toBe("Success");

        yield* Replay.rerun({ id: "alpha" });

        const after = yield* Replay.peek({ id: "alpha" });
        expect(after._tag).toBe("Pending");

        // Second execute should run the handler again (counter increments).
        const second = yield* Replay.execute({ id: "alpha" });
        expect(second).toBe(2);
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster)),
  );

  it.scopedLive("rerun-of-non-existent-execId is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const Noop = Actor.fromWorkflow("RerunNoopWorkflow", {
        payload: { id: Schema.String },
        success: Schema.String,
        id: (p: { id: string }) => p.id,
      });

      const handlers = Actor.toLayer(Noop, (p) => Effect.succeed(`done:${p.id}`));

      return yield* Effect.gen(function* () {
        // Never sent — rerun should be a clean no-op.
        yield* Noop.rerun({ id: "never-sent" });
        expect(true).toBe(true);
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster)),
  );

  it.scopedLive("rerun-while-running interrupts the fiber and clears state", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);

      const Slow = Actor.fromWorkflow("SlowWorkflow", {
        payload: { id: Schema.String },
        success: Schema.String,
        id: (p: { id: string }) => p.id,
      });

      const handlers = Actor.toLayer(Slow, (payload) =>
        Effect.gen(function* () {
          yield* Ref.update(started, (n) => n + 1);
          // Sleep long enough that rerun interrupts before completion.
          yield* Effect.sleep("2 seconds");
          return `late:${payload.id}`;
        }),
      );

      return yield* Effect.gen(function* () {
        // Fork the long execute so we don't block on it.
        const fiber = yield* Effect.forkScoped(Slow.execute({ id: "long" }));

        // Let the handler start.
        yield* Effect.sleep("100 millis");
        const startedCount = yield* Ref.get(started);
        expect(startedCount).toBe(1);

        // Rerun cancels the running fiber + clears the address.
        yield* Slow.rerun({ id: "long" });

        // Reap the forked fiber (interrupted or otherwise).
        yield* Fiber.interrupt(fiber);

        // After rerun + interrupt, state should be Pending (not Success).
        const after = yield* Slow.peek({ id: "long" });
        expect(after._tag).toBe("Pending");
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster), Effect.timeout("10 seconds")),
  );

  it.scopedLive("rerun clears cached activity replies (re-runs activities on next execute)", () =>
    Effect.gen(function* () {
      const activityCount = yield* Ref.make(0);

      const WithActivity = Actor.fromWorkflow("ActivityWorkflow", {
        payload: { id: Schema.String },
        success: Schema.Number,
        id: (p: { id: string }) => p.id,
      });

      const handlers = Actor.toLayer(
        WithActivity,
        (_payload, step) =>
          Effect.gen(function* () {
            // Activity replies are persisted at the workflow's EntityAddress.
            // First run: increments to 1. After rerun: handler runs again AND
            // the activity replay should miss the cache, incrementing to 2.
            const value = yield* step.run(
              "increment",
              Ref.updateAndGet(activityCount, (n) => n + 1),
            );
            return value;
            // step.run leaks WorkflowInstance/Scope in its env signature; the
            // engine provides them at runtime, so we erase here for the toLayer
            // overload's RX inference.
          }) as Effect.Effect<number, never, never>,
      );

      return yield* Effect.gen(function* () {
        const first = yield* WithActivity.execute({ id: "act" });
        expect(first).toBe(1);

        yield* WithActivity.rerun({ id: "act" });

        const second = yield* WithActivity.execute({ id: "act" });
        // Activity ran a second time because rerun wiped the cached reply.
        expect(second).toBe(2);
      }).pipe(Effect.provide(handlers));
    }).pipe(Effect.provide(TestCluster)),
  );

  // Regression: a workflow with `step.sleep` registers a DurableClock
  // sub-entity at `entityType=Workflow/-/DurableClock`. Without explicit
  // cleanup, `.rerun` leaves the clock entry behind — when the duration
  // elapses, it fires into a workflow that no longer expects it. The fix
  // mirrors upstream `clearClock` in ClusterWorkflowEngine.js:124-134:
  // `clearAddress` on the clock's EntityAddress (same shardGroup as parent,
  // entityId = workflow executionId, entityType = "Workflow/-/DurableClock").
  it.scopedLive(
    "rerun clears DurableClock sub-entity (step.sleep cleanup)",
    () =>
      Effect.gen(function* () {
        const driver = yield* MessageStorage.MemoryDriver;

        const Sleeper = Actor.fromWorkflow("ClockClearWorkflow", {
          payload: { id: Schema.String },
          success: Schema.String,
          id: (p: { id: string }) => p.id,
        });

        // Force the durable-clock path (default threshold is 60s — anything
        // shorter goes to an in-memory Activity and never persists a clock
        // entity row, so the bug is not observable). `inMemoryThreshold: 0`
        // pushes every sleep through the DurableClock entity regardless of
        // duration. 10s wakeUp ensures the clock is still pending when rerun.
        const handlers = Actor.toLayer(Sleeper, (payload, step) =>
          Effect.gen(function* () {
            yield* step.sleep("nap", "10 seconds", { inMemoryThreshold: "1 millis" });
            return `awake:${payload.id}`;
          }),
        );

        const countClockEntries = (): number => {
          let count = 0;
          for (const entry of driver.requests.values()) {
            const env = entry.envelope as Envelope.Encoded;
            if ("address" in env && env.address.entityType === "Workflow/-/DurableClock") {
              count++;
            }
          }
          return count;
        };

        return yield* Effect.gen(function* () {
          // Fork — execute blocks on the 10s sleep, never resolves in this test.
          const fiber = yield* Effect.forkScoped(Sleeper.execute({ id: "clock" }));

          // Poll for the clock entry to land in storage. step.sleep schedules
          // the clock asynchronously, so a tight check would race.
          yield* Effect.gen(function* () {
            for (let i = 0; i < 20; i++) {
              if (countClockEntries() > 0) return;
              yield* Effect.sleep("50 millis");
            }
          });
          expect(countClockEntries()).toBeGreaterThan(0);

          // Rerun should wipe the clock entry alongside the workflow's own state.
          yield* Sleeper.rerun({ id: "clock" });
          yield* Fiber.interrupt(fiber);

          expect(countClockEntries()).toBe(0);
        }).pipe(Effect.provide(handlers));
      }).pipe(Effect.provide(TestCluster), Effect.timeout("15 seconds")),
    20_000,
  );
});
