import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, PrimaryKey, Ref, Schema } from "effect";
import {
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  TestRunner,
} from "effect/cluster";
import { ActorAddressResolverLayer } from "../src/actor-address-resolver.js";
import { ClientLayer, Actor, SendAndAwaitTimeout } from "../src/index.js";

const senderOnlyStorage = MessageStorage.layerMemory.pipe(
  Layer.provideMerge(ShardingConfig.layer()),
);
const senderOnlyHost = Layer.mergeAll(
  ClientLayer.fromConfig,
  ActorAddressResolverLayer.fromConfig,
).pipe(Layer.provideMerge(senderOnlyStorage));

class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

const Counter = Ref.makeUnsafe(0);

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
    success: Schema.Finite,
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
  Fail: () => Effect.fail(ProcessError.make({ message: "bad input" })),
  Count: () => Ref.updateAndGet(Counter, (n) => n + 1),
  Hang: () => Effect.never,
});

const TestCluster = TestRunner.layer;

class RoutedKey extends Schema.Class<RoutedKey>("send-await/RoutedKey")({
  region: Schema.String,
  seq: Schema.Finite,
}) {
  routingKey(): string {
    return `${this.region}-${this.seq}`;
  }
  [PrimaryKey.symbol](): string {
    return this.routingKey();
  }
}

const ClassPayloadActor = Actor.fromEntity("ClassPayloadActor", {
  Process: {
    payload: RoutedKey,
    success: Schema.String,
    persisted: true,
    id: (p: RoutedKey) => p.routingKey(),
  },
});

const classPayloadHandlers = Actor.toLayer(ClassPayloadActor, {
  Process: ({ operation }) => Effect.succeed(`routed: ${operation.region}-${operation.seq}`),
});

const FastTerminationCluster = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
  Layer.provide(ShardingConfig.layer({ entityTerminationTimeout: "100 millis" })),
);

const sendAwaitHandlersLayer = sendAwaitHandlers.pipe(Layer.provideMerge(TestCluster));
const sendAwaitFastLayer = sendAwaitHandlers.pipe(Layer.provideMerge(FastTerminationCluster));
const classPayloadHandlersLayer = classPayloadHandlers.pipe(Layer.provideMerge(TestCluster));

describe("OperationHandle.sendAndAwait", () => {
  it.scopedLive("returns the handler's decoded success value", () =>
    Effect.gen(function* () {
      const value = yield* SendAwaitActor.Process.sendAndAwait(
        { input: "hello" },
        { timeout: "5 seconds" },
      );
      expect(value).toBe("processed: hello");
    }).pipe(Effect.provide(sendAwaitHandlersLayer)),
  );

  it.scopedLive("surfaces a typed handler failure in the error channel", () =>
    Effect.gen(function* () {
      const error = yield* SendAwaitActor.Fail.sendAndAwait(
        { input: "bad" },
        { timeout: "5 seconds" },
      ).pipe(Effect.flip);
      expect(error._tag).toBe("ProcessError");
      if (error._tag === "ProcessError") {
        expect(error.message).toBe("bad input");
      }
    }).pipe(Effect.provide(sendAwaitHandlersLayer)),
  );

  it.scopedLive("fails with SendAndAwaitTimeout when the reply never becomes terminal", () =>
    Effect.gen(function* () {
      const error = yield* SendAwaitActor.Hang.sendAndAwait(
        { input: "stuck" },
        { timeout: "300 millis" },
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(SendAndAwaitTimeout);
      if (error instanceof SendAndAwaitTimeout) {
        expect(error.entityType).toBe("SendAwaitActor");
        expect(error.execId).toBe("stuck\x00Hang\x00stuck");
      }
    }).pipe(Effect.provide(sendAwaitFastLayer)),
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
    }).pipe(Effect.provide(sendAwaitHandlersLayer)),
  );

  it.scopedLive(
    "Schema.Class payload: send→peek agree on the ExecId (class-instance id), sendAndAwait resolves",
    () =>
      Effect.gen(function* () {
        const payload = RoutedKey.make({ region: "us", seq: 7 });
        const fromSend = yield* ClassPayloadActor.Process.send(payload);
        const fromCompute = yield* ClassPayloadActor.Process.executionId(payload);
        expect(String(fromSend)).toBe("us-7\x00Process\x00us-7");
        expect(String(fromSend)).toBe(String(fromCompute));
        const value = yield* ClassPayloadActor.Process.sendAndAwait(payload, {
          timeout: "5 seconds",
        });
        expect(value).toBe("routed: us-7");
      }).pipe(Effect.provide(classPayloadHandlersLayer)),
  );

  it.scopedLive(
    "sender-only Client.layer.memory host can sendAndAwait without another reply service",
    () =>
      Effect.gen(function* () {
        const error = yield* SendAwaitActor.Process.sendAndAwait(
          { input: "sender-only" },
          { timeout: "300 millis" },
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SendAndAwaitTimeout);
        if (error instanceof SendAndAwaitTimeout) {
          expect(error.entityType).toBe("SendAwaitActor");
        }
      }).pipe(Effect.provide(senderOnlyHost)),
  );
});
