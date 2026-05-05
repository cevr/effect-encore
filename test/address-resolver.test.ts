/**
 * Parity test: ActorAddressResolverLayer.fromConfig vs ActorAddressResolverLayer.fromSharding
 * MUST produce identical EntityAddress for the same (entityId, shardGroup).
 *
 * This pins the djb2 + bit-mix replication in `actor-address-resolver.ts`
 * against upstream's `Sharding.getShardId`. If they ever drift, producer-side
 * dispatch via ActorMailbox would land on a different shard than the consumer
 * expects.
 */
import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, Schema } from "effect";
import { ShardingConfig, TestRunner } from "effect/unstable/cluster";
import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import { Actor, ActorAddressResolver, ActorAddressResolverLayer } from "../src/index.js";

const TestActor = Actor.fromEntity("ParityActor", {
  Run: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

// fromConfig only needs ShardingConfig — provide it directly. TestRunner.layer
// consumes ShardingConfig internally and does not expose it outward, so we use
// the plain ShardingConfig.layer() here. Both layers see the same default
// config so shard math is identical.
const FromConfigCluster = ActorAddressResolverLayer.fromConfig.pipe(
  Layer.provide(ShardingConfig.layer()),
);
// fromSharding delegates to live Sharding, which TestRunner.layer provides.
const FromShardingCluster = ActorAddressResolverLayer.fromSharding.pipe(
  Layer.provideMerge(TestRunner.layer),
);

// Cover a spread of entityId shapes so a regression in djb2 surfaces.
const entityIds = [
  "a",
  "abc",
  "order-12345",
  "tenant:42:org:abc",
  "🌮", // multi-byte
  "x".repeat(64),
  "0",
  "00000000-0000-0000-0000-000000000000",
];

// eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity name param is invariant; production casts the same way at actor.ts
const testEntity = TestActor._meta.entity as ClusterEntity.Entity<string, any>;

describe("ActorAddressResolver parity (fromConfig vs fromSharding)", () => {
  for (const entityId of entityIds) {
    it.scopedLive(`produces identical EntityAddress for ${JSON.stringify(entityId)}`, () =>
      Effect.gen(function* () {
        const fromConfigAddress = yield* Effect.gen(function* () {
          const resolver = yield* ActorAddressResolver;
          return resolver.resolveEntity(testEntity, entityId);
        }).pipe(Effect.provide(FromConfigCluster));

        const fromShardingAddress = yield* Effect.gen(function* () {
          const resolver = yield* ActorAddressResolver;
          return resolver.resolveEntity(testEntity, entityId);
        }).pipe(Effect.provide(FromShardingCluster));

        expect(fromConfigAddress.entityType).toBe(fromShardingAddress.entityType);
        expect(fromConfigAddress.entityId).toBe(fromShardingAddress.entityId);
        expect(fromConfigAddress.shardId.group).toBe(fromShardingAddress.shardId.group);
        expect(fromConfigAddress.shardId.id).toBe(fromShardingAddress.shardId.id);
      }),
    );
  }
});
