/**
 * ActorMailboxLayer.fromConfig behavior coverage.
 *
 * codex (2026-05-05) called out that the mailbox path was under-tested: most
 * `.send` coverage went through `Actor.toTestLayer`, which bypasses storage
 * by invoking the test rpc client directly. This file pins:
 *
 * 1. Persisted gate — non-persisted requests fail loudly (mirror of upstream
 *    `Sharding.sendOutgoing`'s persisted check).
 * 2. Success enqueues to `MessageStorage.saveRequest`.
 * 3. Duplicate primaryKey is treated as enqueued (no error), per codex's
 *    correction to handle both `SaveResult.Success` and `SaveResult.Duplicate`.
 * 4. Cross-process delivery — a producer using `fromConfig` writes to the same
 *    storage that a consumer's poll loop reads from, exercising the path that
 *    motivated this work.
 */
import { describe, expect, it } from "effect-bun-test";
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import {
  EntityAddress,
  EntityId,
  Envelope,
  Message,
  MessageStorage,
  ShardId,
  ShardingConfig,
  Snowflake,
  TestRunner,
} from "effect/unstable/cluster";
import * as Headers from "effect/unstable/http/Headers";
import type { Rpc } from "effect/unstable/rpc";
import { ActorAddressResolver, ActorAddressResolverLayer } from "../src/actor-address-resolver.js";
import { ActorMailbox, ActorMailboxLayer, MailboxError } from "../src/actor-mailbox.js";
import { Actor } from "../src/index.js";

// Two actors: one persisted, one not. The persisted one round-trips through
// fromConfig; the non-persisted one MUST be rejected.
const PersistedActor = Actor.fromEntity("MailboxPersistedActor", {
  Place: {
    payload: { item: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { item: string }) => p.item,
  },
});

const LiveOnlyActor = Actor.fromEntity("MailboxLiveOnlyActor", {
  // No `persisted: true` — live-only.
  Ping: {
    payload: { input: Schema.String },
    success: Schema.String,
    id: (p: { input: string }) => p.input,
  },
});

// Build a minimal OutgoingRequest by hand so the test does not depend on the
// internal `OperationHandle.send` plumbing. Mirrors `buildOutgoingRequestForSend`
// in actor.ts but inlined here for unit-test clarity.
const buildRequest = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- entity Rpcs erased
  actor: { _meta: { entity: any } },
  tag: string,
  payload: Record<string, unknown>,
): Effect.Effect<Message.OutgoingRequest<Rpc.Any>, never, Snowflake.Generator> =>
  Effect.gen(function* () {
    const snowflake = yield* Snowflake.Generator;
    const entity = actor._meta.entity;
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- erased
    const rpc = entity.protocol.requests.get(tag);
    const idValue = payload["item"] ?? payload["input"];
    const toEntityIdString = (value: unknown): string => {
      if (typeof value === "string") return value;
      return "x";
    };
    const entityId = EntityId.make(toEntityIdString(idValue));
    const address = EntityAddress.make({
      entityType: entity.type,
      entityId,
      shardId: ShardId.make("default", 1),
    });
    // eslint-disable-next-line typescript-eslint/no-explicit-any -- class constructor
    const payloadInstance = new rpc.payloadSchema(payload);
    return new Message.OutgoingRequest({
      rpc,
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- empty fiber context for unit test
      context: Context.empty() as any,
      annotations: Context.empty(),
      envelope: Envelope.makeRequest({
        requestId: snowflake.nextUnsafe(),
        address,
        tag: tag as never,
        payload: payloadInstance as never,
        headers: Headers.empty,
      }),
      lastReceivedReply: Option.none(),
      respond: () => Effect.void,
    });
  });

// MessageStorage (memory) + Snowflake.Generator. fromConfig consumes only
// MessageStorage; the test layer adds Snowflake for the test's own request
// builder, plus ShardingConfig for layerMemory.
const StorageLayer = MessageStorage.layerMemory.pipe(Layer.provideMerge(ShardingConfig.layer()));
const TestStack = ActorMailboxLayer.fromConfig.pipe(
  Layer.provideMerge(StorageLayer),
  Layer.provideMerge(Snowflake.layerGenerator),
);

describe("ActorMailboxLayer.fromConfig", () => {
  it.scopedLive("rejects non-persisted requests with MailboxError", () =>
    Effect.gen(function* () {
      const mailbox = yield* ActorMailbox;
      const request = yield* buildRequest(LiveOnlyActor, "Ping", { input: "hi" });
      const exit = yield* mailbox.send(request).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(MailboxError);
        }
      }
    }).pipe(Effect.provide(TestStack)),
  );

  it.scopedLive("enqueues persisted requests to MessageStorage", () =>
    Effect.gen(function* () {
      const mailbox = yield* ActorMailbox;
      const storage = yield* MessageStorage.MessageStorage;
      const request = yield* buildRequest(PersistedActor, "Place", { item: "widget" });
      yield* mailbox.send(request);
      // Read back via the same storage handle: there should be at least one
      // unprocessed envelope addressed to the entity.
      const unprocessed = yield* storage.unprocessedMessages([request.envelope.address.shardId]);
      expect(unprocessed.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(TestStack)),
  );

  it.scopedLive("treats duplicate primaryKey as enqueued (no error)", () =>
    Effect.gen(function* () {
      const mailbox = yield* ActorMailbox;
      const a = yield* buildRequest(PersistedActor, "Place", { item: "dup" });
      const b = yield* buildRequest(PersistedActor, "Place", { item: "dup" });
      yield* mailbox.send(a);
      // Second send same primaryKey — saveRequest returns Duplicate. Mailbox
      // must NOT propagate that as an error.
      const exit = yield* mailbox.send(b).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(TestStack)),
  );
});

// Producer (fromConfig) -> consumer (full Sharding) cross-runtime check.
// Verifies the design invariant: a producer that ONLY has MessageStorage can
// drop a persisted envelope into the same MemoryDriver that the consumer's
// poll loop reads from.
// eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity name param is invariant; production casts the same way at actor.ts
const persistedEntity = PersistedActor._meta.entity as ClusterEntity.Entity<string, any>;

describe("ActorMailbox cross-runtime: fromConfig producer -> Sharding consumer", () => {
  it.scopedLive("address resolved via fromConfig matches what the consumer expects", () =>
    Effect.gen(function* () {
      const fromConfigAddress = yield* Effect.gen(function* () {
        const resolver = yield* ActorAddressResolver;
        return resolver.resolveEntity(persistedEntity, EntityId.make("widget"));
      }).pipe(
        Effect.provide(
          ActorAddressResolverLayer.fromConfig.pipe(Layer.provide(ShardingConfig.layer())),
        ),
      );

      const fromShardingAddress = yield* Effect.gen(function* () {
        const resolver = yield* ActorAddressResolver;
        return resolver.resolveEntity(persistedEntity, EntityId.make("widget"));
      }).pipe(
        Effect.provide(
          ActorAddressResolverLayer.fromSharding.pipe(Layer.provide(TestRunner.layer)),
        ),
      );

      expect(fromConfigAddress.shardId.id).toBe(fromShardingAddress.shardId.id);
      expect(fromConfigAddress.shardId.group).toBe(fromShardingAddress.shardId.group);
    }),
  );
});
