import type { Entity as ClusterEntity } from "effect/cluster";
import {
  ClusterSchema,
  EntityAddress,
  EntityId,
  EntityType,
  ShardId,
  Sharding,
  ShardingConfig,
} from "effect/cluster";
import type { Workflow as UpstreamWorkflow } from "effect/workflow";
import { Context, Effect, Layer } from "effect";

/* eslint-disable typescript-eslint/no-explicit-any -- entity Rpcs type-erased at runtime */
export interface ActorAddressResolverService {
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

export class ActorAddressResolver extends Context.Service<
  ActorAddressResolver,
  ActorAddressResolverService
>()("effect-encore/actor-address-resolver/ActorAddressResolver") {}

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
type WorkflowValue = Parameters<ActorAddressResolverService["resolveWorkflow"]>[0];

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

      return ActorAddressResolver.of({
        resolveEntity,
        ...workflowResolvers,
      });
    }),
  );

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

    return ActorAddressResolver.of({
      resolveEntity,
      ...workflowResolvers,
    });
  }),
);

export const ActorAddressResolverLayer = {
  fromConfig,
  fromSharding,
};
