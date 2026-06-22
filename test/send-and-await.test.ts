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
} from "effect/unstable/cluster";
import {
  ClientLayer,
  Actor,
  ActorAddressResolverLayer,
  SendAndAwaitTimeout,
} from "../src/index.js";

// A sender-only host: the deep `Client` transport seam (`Client.layer.fromConfig`)
// over a SHARED in-memory storage, plus the `ActorAddressResolver` + `MessageStorage`
// the `peek` loop requires directly — all over the SAME memory driver so the
// dispatched envelope and the peek read the same storage.
const senderOnlyStorage = MessageStorage.layerMemory.pipe(
  Layer.provideMerge(ShardingConfig.layer()),
);
const senderOnlyHost = Layer.mergeAll(
  ClientLayer.fromConfig,
  ActorAddressResolverLayer.fromConfig,
).pipe(Layer.provideMerge(senderOnlyStorage));

class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

// A shared invocation counter so the dedup case can assert the handler runs once.
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

// Regression for the --deep finding: `OperationHandle.send` must derive its
// ExecId from the ORIGINAL payload, not the reconstructed `opValue`. For a
// `Schema.Class` payload whose `id` reads a PROTOTYPE METHOD, the struct-spread
// reconstruction inside `buildOpValue` drops the method — so re-deriving the id
// from `opValue` would throw or mint a divergent ExecId, and the `sendAndAwait`
// send→peek round-trip would never reconcile. Exercises send + peek end-to-end
// over a real cluster host (not the test-mailbox shortcut).
class RoutedKey extends Schema.Class<RoutedKey>("send-await/RoutedKey")({
  region: Schema.String,
  seq: Schema.Number,
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
    // id depends on the class instance (prototype method), NOT a bare field.
    id: (p: RoutedKey) => p.routingKey(),
  },
});

const classPayloadHandlers = Actor.toLayer(ClassPayloadActor, {
  // Read plain fields: the decoded operation delivered to the handler is a
  // schema-decoded value, so reconstruct the routing key from its fields rather
  // than relying on the class prototype method surviving the wire round-trip.
  Process: ({ operation }) => Effect.succeed(`routed: ${operation.region}-${operation.seq}`),
});

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

  it.scopedLive(
    "Schema.Class payload: send→peek agree on the ExecId (class-instance id), sendAndAwait resolves",
    () =>
      Effect.gen(function* () {
        const payload = new RoutedKey({ region: "us", seq: 7 });
        // send and executionId (which peek shares) must agree on the ExecId.
        const fromSend = yield* ClassPayloadActor.Process.send(payload);
        const fromCompute = yield* ClassPayloadActor.Process.executionId(payload);
        expect(String(fromSend)).toBe("us-7\x00Process\x00us-7");
        expect(String(fromSend)).toBe(String(fromCompute));
        // End-to-end send→peek: sendAndAwait dispatches then polls peek under the
        // SAME ExecId. If send had derived a divergent id, this would time out
        // instead of resolving the handler value.
        const value = yield* ClassPayloadActor.Process.sendAndAwait(payload, {
          timeout: "5 seconds",
        });
        expect(value).toBe("routed: us-7");
      }).pipe(Effect.provide(classPayloadHandlers), Effect.provide(TestCluster)),
  );

  // Regression: a sender-only host that wires `Client.layer.memory` (the deep
  // Client transport seam over in-memory storage — NO `toLayer`, NO local
  // Sharding, NO `ReplySource`) must be able to call `sendAndAwait` without the
  // `peek`-loop dying with `Service not found: effect-encore/receipt/ReplySource`.
  // With no consumer hosting the entity, the reply never becomes terminal, so
  // the call resolves to a typed `SendAndAwaitTimeout` — a clean failure that
  // proves the seam fell back to `defaultReplySource` instead of leaking
  // `ReplySource` into R.
  //
  // `Client.layer.memory` provides the `Client` Tag but the `peek` loop still
  // requires `MessageStorage | ActorAddressResolver` directly, so those are
  // provided alongside via the same in-memory bundle.
  it.scopedLive(
    "sender-only Client.layer.memory host can sendAndAwait without a ReplySource service",
    () =>
      Effect.gen(function* () {
        const error = yield* SendAwaitActor.Process.sendAndAwait(
          { input: "sender-only" },
          { timeout: "300 millis" },
        ).pipe(Effect.flip);
        // The seam resolved via the default fallback: we reach the poll timeout,
        // NOT a `Service not found: ReplySource` defect.
        expect(error).toBeInstanceOf(SendAndAwaitTimeout);
        expect((error as SendAndAwaitTimeout).entityType).toBe("SendAwaitActor");
      }).pipe(Effect.provide(senderOnlyHost)),
  );
});
