import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, Schema } from "effect";
import { ShardingConfig, TestRunner } from "effect/cluster";
import type { Entity as ClusterEntity } from "effect/cluster";
import { ActorAddressResolver, ActorAddressResolverLayer } from "../src/actor-address-resolver.js";
import { Actor } from "../src/index.js";

const TestActor = Actor.fromEntity("ParityActor", {
  Run: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const FromConfigCluster = ActorAddressResolverLayer.fromConfig.pipe(
  Layer.provide(ShardingConfig.layer()),
);
const FromShardingCluster = ActorAddressResolverLayer.fromSharding.pipe(
  Layer.provideMerge(TestRunner.layer),
);

const entityIds = [
  "a",
  "abc",
  "order-12345",
  "tenant:42:org:abc",
  "🌮",
  "x".repeat(64),
  "0",
  "00000000-0000-0000-0000-000000000000",
];

// eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity name param is invariant; production casts the same way at actor.ts
// oxlint-disable-next-line effect/noAs -- the upstream resolver seam erases the invariant entity name and RPC union
const testEntity = TestActor._meta.entity as ClusterEntity.Entity<string, any>;

describe("ActorAddressResolver parity (fromConfig vs fromSharding)", () => {
  for (const entityId of entityIds) {
    it.scopedLive(`produces identical EntityAddress for "${entityId}"`, () =>
      Effect.all({
        fromConfigAddress: Effect.gen(function* () {
          const resolver = yield* ActorAddressResolver;
          return resolver.resolveEntity(testEntity, entityId);
        }).pipe(Effect.provide(FromConfigCluster)),
        fromShardingAddress: Effect.gen(function* () {
          const resolver = yield* ActorAddressResolver;
          return resolver.resolveEntity(testEntity, entityId);
        }).pipe(Effect.provide(FromShardingCluster)),
      }).pipe(
        Effect.tap(({ fromConfigAddress, fromShardingAddress }) =>
          Effect.sync(() => {
            expect(fromConfigAddress.entityType).toBe(fromShardingAddress.entityType);
            expect(fromConfigAddress.entityId).toBe(fromShardingAddress.entityId);
            expect(fromConfigAddress.shardId.group).toBe(fromShardingAddress.shardId.group);
            expect(fromConfigAddress.shardId.id).toBe(fromShardingAddress.shardId.id);
          }),
        ),
      ),
    );
  }
});
