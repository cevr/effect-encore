/**
 * ActorAddressResolver — pure address resolution, decoupled from full Sharding.
 *
 * **Why this exists.** Encore's ops impls (`flush`, `redeliver`, `rerun`,
 * `peek`) and the producer-side mailbox path only need address computation —
 * `(entityType, entityId, shardId)`. Today they all require the full
 * `Sharding` Tag, which transitively requires `Runners` +
 * `RunnerStorage` and registers an entity manager as a side effect. That
 * forces ops-only hosts (e.g. an admin UI) to spin up entity managers they
 * don't want, and it forces producer-only hosts to host the consumer side of
 * `Sharding.makeClient` (which deadlocks on `notifyLocal` when no handler is
 * registered).
 *
 * **What this does.** A narrow Tag with three address-computation methods
 * (`resolveEntity`, `resolveWorkflow`, `resolveWorkflowClock`). Two factories:
 *
 * - `fromConfig` requires only `ShardingConfig` — pure data, no runners, no
 *   entity managers, no message processing. Identical math to upstream's
 *   `Sharding.getShardId`. Use this in producer-only and ops-only hosts.
 * - `fromSharding` requires full `Sharding` — adapter for hosts that
 *   already host the cluster runtime (consumer processes that DO process
 *   mailboxes). Delegates to `sharding.getShardId`.
 *
 * Both factories MUST produce identical addresses for the same
 * `(entityId, shardGroup)` — otherwise producer-side dispatch via
 * `ActorMailbox` would land on a different shard than the consumer expects.
 * This invariant is pinned by `address-resolver.test.ts`.
 */
import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import {
  ClusterSchema,
  EntityAddress,
  EntityId,
  EntityType,
  ShardId,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster";
import type { Workflow as UpstreamWorkflow } from "effect/unstable/workflow";
import { Context, Effect, Layer } from "effect";

// ─── Shape ──────────────────────────────────────────────────────────────────

/* eslint-disable typescript-eslint/no-explicit-any -- entity Rpcs type-erased at runtime */
export interface ActorAddressResolverShape {
  readonly resolveEntity: (
    entity: ClusterEntity.Entity<string, any>,
    entityId: string,
  ) => EntityAddress.EntityAddress;
  readonly resolveWorkflow: (
    workflow: UpstreamWorkflow.Workflow<any, any, any, any>,
    executionId: string,
  ) => EntityAddress.EntityAddress;
  readonly resolveWorkflowClock: (
    workflow: UpstreamWorkflow.Workflow<any, any, any, any>,
    executionId: string,
  ) => EntityAddress.EntityAddress;
}
/* eslint-enable typescript-eslint/no-explicit-any */

// ─── Tag ────────────────────────────────────────────────────────────────────

export class ActorAddressResolver extends Context.Service<
  ActorAddressResolver,
  ActorAddressResolverShape
>()("effect-encore/actor-address-resolver/ActorAddressResolver") {}

// ─── Internal: hash math (mirror of effect/unstable/cluster's internal hash) ──
//
// djb2 + bit-mix, copied from upstream's internal hash function.
// Replicated rather than imported because the upstream module is internal.
// Pinned to upstream behavior by `address-resolver.test.ts` parity test.

const hashOptimize = (n: number): number => (n & 0xbfffffff) | ((n >>> 1) & 0x40000000);

const hashString = (str: string): number => {
  let h = 5381;
  let i = str.length;
  while (i) {
    // eslint-disable-next-line typescript-eslint/no-magic-numbers -- djb2
    h = (h * 33) ^ str.charCodeAt(--i);
  }
  return hashOptimize(h);
};

const computeShardId = (
  entityId: string,
  group: string,
  shardsPerGroup: number,
): ShardId.ShardId => {
  const id = Math.abs(hashString(entityId) % shardsPerGroup) + 1;
  return ShardId.make(group, id);
};

type ResolveShardId = Sharding.Sharding["Service"]["getShardId"];
type WorkflowValue = Parameters<ActorAddressResolverShape["resolveWorkflow"]>[0];

const makeWorkflowResolvers = (getShardId: ResolveShardId) => {
  const resolve = (workflow: WorkflowValue, executionId: string, entityType: string) => {
    const entityId = EntityId.make(executionId);
    const shardGroup = Context.get(workflow.annotations, ClusterSchema.ShardGroup)(entityId);
    return EntityAddress.make({
      entityType: EntityType.make(entityType),
      entityId,
      shardId: getShardId(entityId, shardGroup),
    });
  };

  return {
    resolveWorkflow: (workflow: WorkflowValue, executionId: string) =>
      resolve(workflow, executionId, `Workflow/${workflow._tag}`),
    resolveWorkflowClock: (workflow: WorkflowValue, executionId: string) =>
      resolve(workflow, executionId, "Workflow/-/DurableClock"),
  };
};

// ─── Layers ─────────────────────────────────────────────────────────────────

/**
 * Pure-data resolver built from `ShardingConfig` alone.
 *
 * Use in producer-only and ops-only hosts that must NOT spin up entity
 * managers as a side effect of needing addresses.
 */
const fromConfig: Layer.Layer<ActorAddressResolver, never, ShardingConfig.ShardingConfig> =
  Layer.effect(
    ActorAddressResolver,
    Effect.gen(function* () {
      const config = yield* ShardingConfig.ShardingConfig;
      const shardsPerGroup = config.shardsPerGroup;
      const workflowResolvers = makeWorkflowResolvers((entityId, group) =>
        computeShardId(entityId, group, shardsPerGroup),
      );

      /* eslint-disable typescript-eslint/no-explicit-any -- entity Rpcs type-erased */
      const resolveEntity = (
        entity: ClusterEntity.Entity<string, any>,
        actorId: string,
      ): EntityAddress.EntityAddress => {
        const entityId = EntityId.make(actorId);
        const shardGroup = entity.getShardGroup(entityId);
        return EntityAddress.make({
          entityType: entity.type,
          entityId,
          shardId: computeShardId(entityId, shardGroup, shardsPerGroup),
        });
      };

      /* eslint-enable typescript-eslint/no-explicit-any */

      return {
        resolveEntity,
        ...workflowResolvers,
      };
    }),
  );

/**
 * Adapter for hosts that already provide full `Sharding`. Delegates
 * `getShardId` to the live runtime so config drift between producer and
 * consumer is impossible.
 */
const fromSharding: Layer.Layer<ActorAddressResolver, never, Sharding.Sharding> = Layer.effect(
  ActorAddressResolver,
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    const workflowResolvers = makeWorkflowResolvers(sharding.getShardId);

    /* eslint-disable typescript-eslint/no-explicit-any -- entity Rpcs type-erased */
    const resolveEntity = (
      entity: ClusterEntity.Entity<string, any>,
      actorId: string,
    ): EntityAddress.EntityAddress => {
      const entityId = EntityId.make(actorId);
      const shardGroup = entity.getShardGroup(entityId);
      return EntityAddress.make({
        entityType: entity.type,
        entityId,
        shardId: sharding.getShardId(entityId, shardGroup),
      });
    };

    /* eslint-enable typescript-eslint/no-explicit-any */

    return {
      resolveEntity,
      ...workflowResolvers,
    };
  }),
);

/**
 * Layer factories. Layers are exposed as a namespace alongside the Tag.
 *
 * @example
 * ```ts
 * import { ActorAddressResolver, ActorAddressResolverLayer } from "effect-encore";
 *
 * // producer-only / ops-only host:
 * Layer.provide(ActorAddressResolverLayer.fromConfig)
 *
 * // consumer host with full Sharding:
 * Layer.provide(ActorAddressResolverLayer.fromSharding)
 * ```
 */
export const ActorAddressResolverLayer = {
  fromConfig,
  fromSharding,
} as const;
