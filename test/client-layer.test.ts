/**
 * Deep `Client` transport seam coverage (E5).
 *
 * The `Client` Tag OWNS `send / peek / flush / redeliver / resolve` and pulls
 * the wire-envelope builder INSIDE the seam (decision #1, CONTEXT.md:21-25).
 * This file drives each of the four adapters
 * (`fromConfig` / `fromSharding` / `memory` / `test`) end-to-end and pins three
 * load-bearing invariants the move risks:
 *
 * 1. The persisted-gate annotation-derivation (`client.ts` mirror of
 *    `Sharding.makeClient`) survived the move byte-identical — a persisted op
 *    actually persists after the wire-builder moved inside the seam (NOT a smoke
 *    test).
 * 2. `Snowflake.Generator` resolves under `fromSharding` — `Sharding.layer`
 *    hides its own generator, so the adapter MUST bundle one or `Client.send`
 *    dies with "Service not found: Snowflake.Generator".
 * 3. `Client.peek` composes the `ReplySource` seam — a real consumer drives a
 *    reply terminal and `peek` classifies it.
 */
import { describe, expect, it } from "effect-bun-test";
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import { Entity, MessageStorage, ShardingConfig, TestRunner } from "effect/unstable/cluster";
import type { ActorMailboxShape } from "../src/index.js";
import { Actor, ActorMailbox, Client, ClientLayer, MailboxError } from "../src/index.js";
import { makeTestMailboxImpl } from "../src/client.js";

class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

const ClientActor = Actor.fromEntity("ClientLayerActor", {
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
});

// A live-only (non-persisted) op to exercise the persisted gate.
const LiveOnlyActor = Actor.fromEntity("ClientLayerLiveOnly", {
  Ping: {
    payload: { input: Schema.String },
    success: Schema.String,
    id: (p: { input: string }) => p.input,
  },
});

// Widen to the type-erased entity the Client surface accepts (production casts
// the same way at actor.ts).
// eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity name param is invariant
const processEntity = ClientActor._meta.entity as ClusterEntity.Entity<string, any>;
// eslint-disable-next-line typescript-eslint/no-explicit-any
const liveOnlyEntity = LiveOnlyActor._meta.entity as ClusterEntity.Entity<string, any>;

const processDefs = ClientActor._meta.internalDefinitions ?? ClientActor._meta.definitions;
const liveOnlyDefs = LiveOnlyActor._meta.internalDefinitions ?? LiveOnlyActor._meta.definitions;

const processOpValue = (input: string) => ({ _tag: "Process", input });
const failOpValue = (input: string) => ({ _tag: "Fail", input });
const pingOpValue = (input: string) => ({ _tag: "Ping", input });

// ── Client.layer.memory — self-contained producer (no consumer) ────────────

describe("Client.layer.memory", () => {
  it.scopedLive("send mints the frozen 3-tuple ExecId via the wire-builder inside the seam", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const execId = yield* client.send(
        processEntity,
        "Process",
        processDefs["Process"],
        processOpValue("widget"),
      );
      // ExecId is the frozen 3-tuple wire format, minted inside Client.send.
      expect(String(execId)).toBe("widget\x00Process\x00widget");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );

  it.scopedLive("peek is Pending while no consumer has driven a reply terminal", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processEntity, "Process", processDefs["Process"], processOpValue("p1"));
      const result = yield* client.peek(processEntity, "p1\x00Process\x00p1", processDefs);
      expect(result._tag).toBe("Pending");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );

  it.scopedLive("send rejects a non-persisted op loudly (persisted gate)", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const exit = yield* client
        .send(liveOnlyEntity, "Ping", liveOnlyDefs["Ping"], pingOpValue("hi"))
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(MailboxError);
        }
      }
    }).pipe(Effect.provide(ClientLayer.memory)),
  );

  it.scopedLive("flush + redeliver run without a consumer (control ops moved inside)", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processEntity, "Process", processDefs["Process"], processOpValue("ctl"));
      // Both control ops resolve through the captured storage; neither throws.
      yield* client.flush(processEntity, "ctl");
      yield* client.redeliver(processEntity, "ctl");
      const after = yield* client.peek(processEntity, "ctl\x00Process\x00ctl", processDefs);
      expect(after._tag).toBe("Pending");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );
});

// ── Client.layer.fromConfig — producer over an explicit storage stack ──────

const FromConfigStorage = MessageStorage.layerMemory.pipe(
  Layer.provideMerge(ShardingConfig.layer()),
);

describe("Client.layer.fromConfig", () => {
  it.scopedLive("persisted send lands in the explicitly-provided storage", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const storage = yield* MessageStorage.MessageStorage;
      yield* client.send(processEntity, "Process", processDefs["Process"], processOpValue("cfg"));
      const address = client.resolve(processEntity, "cfg");
      const unprocessed = yield* storage.unprocessedMessages([address.shardId]);
      expect(unprocessed.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(ClientLayer.fromConfig.pipe(Layer.provideMerge(FromConfigStorage)))),
  );
});

// ── Client.layer.fromSharding — consumer host drives the full round-trip ───

const consumerHandlers = Actor.toLayer(ClientActor, {
  Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  Fail: () => Effect.fail(ProcessError.make({ message: "bad" })),
});

const FromShardingLayer = ClientLayer.fromSharding.pipe(Layer.provideMerge(TestRunner.layer));

const FromShardingWithHandlers = ClientLayer.fromSharding.pipe(
  Layer.provideMerge(consumerHandlers),
  Layer.provideMerge(TestRunner.layer),
);

describe("Client.layer.fromSharding", () => {
  it.scopedLive(
    "Snowflake resolves under fromSharding (no 'Service not found: Snowflake.Generator')",
    () =>
      Effect.gen(function* () {
        const client = yield* Client;
        // Would die with a Snowflake.Generator service-not-found if the adapter
        // failed to bundle its own generator (Sharding.layer hides its own).
        const execId = yield* client.send(
          processEntity,
          "Process",
          processDefs["Process"],
          processOpValue("snow"),
        );
        expect(String(execId)).toBe("snow\x00Process\x00snow");
      }).pipe(Effect.provide(FromShardingLayer)),
  );

  it.scopedLive("send → handler processes → peek classifies Success → flush clears", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processEntity, "Process", processDefs["Process"], processOpValue("e2e"));

      // Poll until the consumer has driven the reply terminal.
      const terminal = yield* Effect.retry(
        Effect.flatMap(client.peek(processEntity, "e2e\x00Process\x00e2e", processDefs), (r) => {
          if (r._tag === "Success") return Effect.succeed(r);
          return Effect.fail("pending");
        }),
        { times: 50 },
      );
      expect(terminal._tag).toBe("Success");
      if (terminal._tag === "Success") {
        expect(terminal.value).toBe("processed: e2e");
      }

      yield* client.flush(processEntity, "e2e");
      const afterFlush = yield* client.peek(processEntity, "e2e\x00Process\x00e2e", processDefs);
      expect(afterFlush._tag).toBe("Pending");
    }).pipe(Effect.provide(FromShardingWithHandlers)),
  );

  it.scopedLive("peek classifies a typed handler Failure through the ReplySource seam", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processEntity, "Fail", processDefs["Fail"], failOpValue("nope"));
      const terminal = yield* Effect.retry(
        Effect.flatMap(client.peek(processEntity, "nope\x00Fail\x00nope", processDefs), (r) => {
          if (r._tag === "Failure") return Effect.succeed(r);
          return Effect.fail("pending");
        }),
        { times: 50 },
      );
      expect(terminal._tag).toBe("Failure");
      if (terminal._tag === "Failure") {
        expect((terminal.error as ProcessError)._tag).toBe("ProcessError");
      }
    }).pipe(Effect.provide(FromShardingWithHandlers)),
  );
});

// ── toTestLayer — public `.send` over the inline test-mailbox composition ───
//
// NOTE: `Actor.toTestLayer` does NOT compose `Client.layer.test`; it builds the
// deep Client by composing `clientServiceLayer` directly over its own injected
// test mailbox + shared support stack, so peek/flush/control read the SAME
// bundled storage rather than a second isolated one. For an ENTITY actor that
// shared storage buys consistent control-op + Pending-peek observation, NOT a
// reply round-trip: the injected `Entity.makeTestClient` path routes the handler
// reply through an in-memory `RpcServer.makeNoSerialization` (bypassing the
// `entityManager`, the only writer of replies to `MessageStorage`) and the
// `{ discard: true }` consumer drops it — so the reply reaches no storage,
// shared or not. (The `fromWorkflow` test path is the one whose engine persists
// replies, so its `peek` can reach `Success`; see `workflow.test.ts`.) This
// block exercises the inline composition: the public `.send` (now
// `Client`-channeled) routes back through the per-entity rpcClient with
// `{ discard: true }`. The exported `Client.layer.test` adapter is driven
// directly in the block below.

const TestShardingConfig = ShardingConfig.layer({ entityTerminationTimeout: 0 });
const ClientActorTest = Layer.provide(
  Actor.toTestLayer(ClientActor, {
    Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
    Fail: () => Effect.fail(ProcessError.make({ message: "bad" })),
  }),
  TestShardingConfig,
);

describe("Actor.toTestLayer (inline test-mailbox composition)", () => {
  const layerTest = it.scopedLive.layer(ClientActorTest);

  layerTest("public .send routes through the inline test mailbox (Client-channeled dispatch)", () =>
    Effect.gen(function* () {
      const execId = yield* ClientActor.Process.send({ input: "tst" });
      expect(String(execId)).toBe("tst\x00Process\x00tst");
    }),
  );
});

// ── Client.layer.test — the exported adapter, driven DIRECTLY ───────────────
//
// `Client.layer.test` is the ONLY adapter that builds the deep Client over an
// INJECTED `ActorMailbox` (decision #1's 4th adapter); it bundles pure-data
// resolver/storage/snowflake internally so its sole outstanding requirement is
// `ActorMailbox` + `ShardingConfig`. `Actor.toTestLayer` does NOT consume it
// (it inlines `clientServiceLayer` over its own bundled storage, which — per the
// narrowed contract above — buys control-op + Pending-peek observation, NOT a
// handler-reply round-trip). So we drive the exported adapter DIRECTLY here.
//
// Contract note (NARROWED — see client.ts `test` adapter doc): this adapter is
// send-routing + control/peek-over-its-own-storage. It does NOT support a
// `send → peek → Success/Failure` reply round-trip, and that is NOT a
// storage-sharing oversight — it is structural. The injected per-entity test
// client is `Entity.makeTestClient`, a raw `RpcServer.makeNoSerialization` that
// bypasses the `entityManager` (the ONLY component that persists handler replies
// to `MessageStorage`). The handler's reply is an in-memory RPC response that
// the `{ discard: true }` consumer throws away — it reaches NO storage, shared
// or not. So `send` followed by `peek` is `Pending` here BY CONSTRUCTION (we
// assert exactly that below). The actual `send → peek → Success/Failure`
// round-trip is covered by `Client.layer.fromSharding` (real cluster runtime,
// above) and the `fromWorkflow` test path (`workflow.test.ts`). The load-bearing
// behavior THIS adapter OWNS end-to-end: `send` routes the prebuilt
// `OutgoingRequest` through the INJECTED mailbox, and `peek`/`flush`/`redeliver`
// operate over the adapter's bundled storage. We assert all of it — `send`
// routing is proven by capturing the dispatched envelope in the injected
// mailbox; the immediate-`peek` Pending pins the narrowed reply contract; and
// `flush`/`redeliver`/`peek` are exercised against the adapter's storage.

// A recording `ActorMailbox` impl: captures each dispatched envelope (proving
// `Client.send`, channeled through the adapter, reaches the INJECTED mailbox),
// then routes it on through the real per-entity test path via
// `makeTestMailboxImpl` (the same wrapper `toTestLayer` uses).
const directHandlerLayer = ClientActor._meta.entity.toLayer({
  Process: ({ operation }: { operation: { input: string } }) =>
    Effect.succeed(`processed: ${operation.input}`),
  Fail: () => Effect.fail(ProcessError.make({ message: "bad" })),
} as never);

const dispatchedRef = Effect.runSync(
  Ref.make<ReadonlyArray<{ tag: string; entityId: string }>>([]),
);

const injectedMailboxLayer = Layer.effectContext(
  Effect.gen(function* () {
    const makeClient = (yield* Entity.makeTestClient(
      ClientActor._meta.entity,
      directHandlerLayer,
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- makeTestClient return is type-erased; mirrors actor.ts:1515
    )) as (entityId: string) => Effect.Effect<any>;
    const routing = makeTestMailboxImpl(makeClient);
    const recording: ActorMailboxShape = {
      send: (request) =>
        Ref.update(dispatchedRef, (xs) => [
          ...xs,
          {
            tag: String(request.envelope.tag),
            entityId: String(request.envelope.address.entityId),
          },
        ]).pipe(Effect.flatMap(() => routing.send(request))),
    };
    return Context.empty().pipe(Context.add(ActorMailbox, recording));
  }),
);

// `Client.layer.test` over the injected mailbox + ShardingConfig — the FULL
// declared requirement of the exported adapter, satisfied directly.
const directTestClientLayer = ClientLayer.test.pipe(
  Layer.provide(
    Layer.merge(Layer.provide(injectedMailboxLayer, TestShardingConfig), TestShardingConfig),
  ),
);

describe("Client.layer.test (exported adapter, driven directly)", () => {
  const layerTest = it.scopedLive.layer(directTestClientLayer);

  layerTest(
    "send routes through the INJECTED mailbox; send→peek is Pending (reply discarded); flush/redeliver run on its storage",
    () =>
      Effect.gen(function* () {
        const client = yield* Client;
        yield* Ref.set(dispatchedRef, []);

        // send: the wire-builder runs inside the seam, mints the frozen 3-tuple
        // ExecId, and dispatches the prebuilt request through the INJECTED mailbox.
        const execId = yield* client.send(
          processEntity,
          "Process",
          processDefs["Process"],
          processOpValue("adapter"),
        );
        expect(String(execId)).toBe("adapter\x00Process\x00adapter");

        // The injected mailbox saw the dispatch — proving `Client.layer.test`
        // actually routes `send` through the adapter-supplied `ActorMailbox`
        // (NOT a bundled producer mailbox like `memory`/`fromConfig`).
        const dispatched = yield* Ref.get(dispatchedRef);
        expect(dispatched).toEqual([{ tag: "Process", entityId: "adapter" }]);

        // Narrowed reply contract, asserted DIRECTLY: `send` followed by `peek`
        // is `Pending` on this transport — the injected per-entity test client
        // (`Entity.makeTestClient`) routes the reply through an in-memory
        // `RpcServer.makeNoSerialization` that bypasses the `entityManager`, so
        // the handler reply reaches NO storage and the `{ discard: true }`
        // consumer drops it. A `Success`/`Failure` round-trip is structurally
        // impossible here (covered by `fromSharding` / `fromWorkflow` instead).
        const afterSend = yield* client.peek(
          processEntity,
          "adapter\x00Process\x00adapter",
          processDefs,
        );
        expect(afterSend._tag).toBe("Pending");

        // peek/flush/redeliver operate over the adapter's own in-memory storage.
        yield* client.flush(processEntity, "adapter");
        yield* client.redeliver(processEntity, "adapter");
        const after = yield* client.peek(
          processEntity,
          "adapter\x00Process\x00adapter",
          processDefs,
        );
        expect(after._tag).toBe("Pending");
      }),
  );
});
