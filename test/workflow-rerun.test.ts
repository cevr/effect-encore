import { describe, expect, it } from "effect-bun-test";
import { Effect, Fiber, Layer as L, Ref, Schema } from "effect";
import { ClusterWorkflowEngine, MessageStorage, TestRunner } from "effect/cluster";
import { Actor, ClientLayer } from "../src/index.js";

const WorkflowMessageStorageTest = L.effect(
  MessageStorage.MessageStorage,
  Effect.gen(function* () {
    const driver = yield* MessageStorage.MemoryDriver;
    const baseClearAddress = driver.storage.clearAddress;
    return MessageStorage.MessageStorage.of({
      ...driver.storage,
      clearAddress: (address) =>
        Effect.gen(function* () {
          const toDelete: string[] = [];
          for (const [pk, entry] of driver.requestsByPrimaryKey.entries()) {
            const env = entry.envelope;
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
    });
  }),
);

const WorkflowClientTest = ClientLayer.fromSharding.pipe(L.provide(WorkflowMessageStorageTest));

const TestCluster = L.provideMerge(
  L.merge(WorkflowClientTest, ClusterWorkflowEngine.layer),
  TestRunner.layer,
);

describe("WorkflowActor.rerun", () => {
  it.scopedLive("rerun-of-completed-workflow lets re-execute trigger handler again", () => {
    const counter = Ref.makeUnsafe(0);

    const Replay = Actor.fromWorkflow("ReplayWorkflow", {
      payload: { id: Schema.String },
      success: Schema.Finite,
      id: (p: { id: string }) => p.id,
    });

    const handlers = Actor.toLayer(Replay, () => Ref.updateAndGet(counter, (n) => n + 1)).pipe(
      L.provideMerge(TestCluster),
    );

    return Effect.gen(function* () {
      const first = yield* Replay.execute({ id: "alpha" });
      expect(first).toBe(1);

      const before = yield* Replay.peek({ id: "alpha" });
      expect(before._tag).toBe("Success");

      yield* Replay.rerun({ id: "alpha" });

      const after = yield* Replay.peek({ id: "alpha" });
      expect(after._tag).toBe("Pending");

      const second = yield* Replay.execute({ id: "alpha" });
      expect(second).toBe(2);
    }).pipe(Effect.provide(handlers));
  });

  it.scopedLive("rerun-of-non-existent-execId is a no-op (idempotent)", () => {
    const Noop = Actor.fromWorkflow("RerunNoopWorkflow", {
      payload: { id: Schema.String },
      success: Schema.String,
      id: (p: { id: string }) => p.id,
    });

    const handlers = Actor.toLayer(Noop, (p) => Effect.succeed(`done:${p.id}`)).pipe(
      L.provideMerge(TestCluster),
    );

    return Effect.gen(function* () {
      yield* Noop.rerun({ id: "never-sent" });
      expect(true).toBe(true);
    }).pipe(Effect.provide(handlers));
  });

  it.scopedLive("prune removes a completed workflow by execution id", () => {
    const Prunable = Actor.fromWorkflow("PrunableWorkflow", {
      payload: { id: Schema.String },
      success: Schema.String,
      id: (payload: { id: string }) => payload.id,
    });
    const handlers = Actor.toLayer(Prunable, ({ id }) => Effect.succeed(`done:${id}`)).pipe(
      L.provideMerge(TestCluster),
    );

    return Effect.gen(function* () {
      const driver = yield* MessageStorage.MemoryDriver;
      const countEntries = (executionId: string) => {
        let count = 0;
        for (const entry of driver.requests.values()) {
          const envelope = entry.envelope;
          if (
            "address" in envelope &&
            envelope.address.entityType === "Workflow/PrunableWorkflow" &&
            envelope.address.entityId === executionId
          ) {
            count++;
          }
        }
        return count;
      };

      const executionId = yield* Prunable.send({ id: "retained" });
      yield* Prunable.waitForAt(executionId);
      expect(countEntries(executionId)).toBeGreaterThan(0);

      yield* Prunable.prune(executionId);

      expect(countEntries(executionId)).toBe(0);
      expect(yield* Prunable.peekAt(executionId)).toEqual({ _tag: "Pending" });
    }).pipe(Effect.provide(handlers));
  });

  it.scopedLive("rerun-while-running interrupts the fiber and clears state", () => {
    const started = Ref.makeUnsafe(0);

    const Slow = Actor.fromWorkflow("SlowWorkflow", {
      payload: { id: Schema.String },
      success: Schema.String,
      id: (p: { id: string }) => p.id,
    });

    const handlers = Actor.toLayer(Slow, (payload) =>
      Effect.gen(function* () {
        yield* Ref.update(started, (n) => n + 1);
        yield* Effect.sleep("2 seconds");
        return `late:${payload.id}`;
      }),
    ).pipe(L.provideMerge(TestCluster));

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(Slow.execute({ id: "long" }));

      yield* Effect.sleep("100 millis");
      const startedCount = yield* Ref.get(started);
      expect(startedCount).toBe(1);

      yield* Slow.rerun({ id: "long" });

      yield* Fiber.interrupt(fiber);

      const after = yield* Slow.peek({ id: "long" });
      expect(after._tag).toBe("Pending");
    }).pipe(Effect.provide(handlers), Effect.timeout("10 seconds"));
  });

  it.scopedLive("rerun clears cached activity replies (re-runs activities on next execute)", () => {
    const activityCount = Ref.makeUnsafe(0);

    const WithActivity = Actor.fromWorkflow("ActivityWorkflow", {
      payload: { id: Schema.String },
      success: Schema.Finite,
      id: (p: { id: string }) => p.id,
    });

    const handlers = Actor.toLayer(
      WithActivity,
      (_payload, step) =>
        // oxlint-disable-next-line effect/noAs -- The upstream workflow handler erases engine-owned requirements at the toLayer boundary.
        Effect.gen(function* () {
          const value = yield* step.run(
            "increment",
            Ref.updateAndGet(activityCount, (n) => n + 1),
          );
          return value;
        }) as Effect.Effect<number, never, never>,
    ).pipe(L.provideMerge(TestCluster));

    return Effect.gen(function* () {
      const first = yield* WithActivity.execute({ id: "act" });
      expect(first).toBe(1);

      yield* WithActivity.rerun({ id: "act" });

      const second = yield* WithActivity.execute({ id: "act" });
      expect(second).toBe(2);
    }).pipe(Effect.provide(handlers));
  });

  it.scopedLive(
    "rerun clears DurableClock sub-entity (step.sleep cleanup)",
    () => {
      const Sleeper = Actor.fromWorkflow("ClockClearWorkflow", {
        payload: { id: Schema.String },
        success: Schema.String,
        id: (p: { id: string }) => p.id,
      });

      const handlers = Actor.toLayer(Sleeper, (payload, step) =>
        Effect.gen(function* () {
          yield* step.sleep("nap", "10 seconds", { inMemoryThreshold: "1 millis" });
          return `awake:${payload.id}`;
        }),
      ).pipe(L.provideMerge(TestCluster));

      return Effect.gen(function* () {
        const driver = yield* MessageStorage.MemoryDriver;
        const countClockEntries = (): number => {
          let count = 0;
          for (const entry of driver.requests.values()) {
            const env = entry.envelope;
            if ("address" in env && env.address.entityType === "Workflow/-/DurableClock") {
              count++;
            }
          }
          return count;
        };

        const fiber = yield* Effect.forkScoped(Sleeper.execute({ id: "clock" }));

        for (let i = 0; i < 20; i++) {
          if (countClockEntries() > 0) break;
          yield* Effect.sleep("50 millis");
        }
        expect(countClockEntries()).toBeGreaterThan(0);

        yield* Sleeper.rerun({ id: "clock" });
        yield* Fiber.interrupt(fiber);

        expect(countClockEntries()).toBe(0);
      }).pipe(Effect.provide(handlers), Effect.timeout("15 seconds"));
    },
    20_000,
  );
});
