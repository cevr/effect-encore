import { describe, expect, it } from "effect-bun-test/v3";
import { Effect, Layer, Ref, Schema } from "effect";
import {
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  TestRunner,
} from "@effect/cluster";
import { Actor, SendAndAwaitTimeout } from "../src/index.js";

class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

// A shared invocation counter so the dedup case can assert the handler runs once.
const Counter = Ref.unsafeMake(0);

const SendAwaitActor = Actor.fromEntity("SendAwaitActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
  Fail: {
    payload: { input: Schema.String },
    error: ProcessError,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
  Count: {
    payload: { input: Schema.String },
    success: Schema.Number,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
  Hang: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const sendAwaitHandlers = Actor.toLayer(SendAwaitActor, {
  Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  Fail: () => Effect.fail(new ProcessError({ message: "bad input" })),
  Count: () => Ref.updateAndGet(Counter, (n) => n + 1),
  Hang: () => Effect.never,
});

const TestCluster = TestRunner.layer;

// The timeout case hosts a `Hang` handler that runs `Effect.never`. When the
// test scope closes, the entity must terminate; the default
// `entityTerminationTimeout` (15s) would block scope finalization past the
// 5s framework timeout. We replicate `TestRunner.layer` here with a short
// `entityTerminationTimeout` so the never-completing entity is reaped quickly
// on teardown instead of hanging.
const FastTerminationCluster = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
  Layer.provide(ShardingConfig.layer({ entityTerminationTimeout: "100 millis" })),
);

describe("OperationHandle.sendAndAwait", () => {
  it.scopedLive("returns the handler's decoded success value", () =>
    Effect.gen(function* () {
      const value = yield* SendAwaitActor.Process.sendAndAwait(
        { input: "hello" },
        { timeout: "5 seconds" },
      );
      expect(value).toBe("processed: hello");
    }).pipe(Effect.provide(sendAwaitHandlers), Effect.provide(TestCluster)),
  );

  it.scopedLive("surfaces a typed handler failure in the error channel", () =>
    Effect.gen(function* () {
      const error = yield* SendAwaitActor.Fail.sendAndAwait(
        { input: "bad" },
        { timeout: "5 seconds" },
      ).pipe(Effect.flip);
      expect(error._tag).toBe("ProcessError");
      expect((error as ProcessError).message).toBe("bad input");
    }).pipe(Effect.provide(sendAwaitHandlers), Effect.provide(TestCluster)),
  );

  it.scopedLive("fails with SendAndAwaitTimeout when the reply never becomes terminal", () =>
    Effect.gen(function* () {
      const error = yield* SendAwaitActor.Hang.sendAndAwait(
        { input: "stuck" },
        { timeout: "300 millis" },
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(SendAndAwaitTimeout);
      const timeout = error as SendAndAwaitTimeout;
      expect(timeout.entityType).toBe("SendAwaitActor");
      expect(timeout.execId).toBe("stuck\x00Hang\x00stuck");
    }).pipe(Effect.provide(sendAwaitHandlers), Effect.provide(FastTerminationCluster)),
  );

  it.scopedLive("dedups: a second call with the same payload returns the persisted result", () =>
    Effect.gen(function* () {
      yield* Ref.set(Counter, 0);
      const first = yield* SendAwaitActor.Count.sendAndAwait(
        { input: "dedup" },
        { timeout: "5 seconds" },
      );
      const second = yield* SendAwaitActor.Count.sendAndAwait(
        { input: "dedup" },
        { timeout: "5 seconds" },
      );
      expect(first).toBe(1);
      expect(second).toBe(1);
      const invocations = yield* Ref.get(Counter);
      expect(invocations).toBe(1);
    }).pipe(Effect.provide(sendAwaitHandlers), Effect.provide(TestCluster)),
  );
});
