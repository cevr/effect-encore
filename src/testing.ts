import { Effect } from "effect";
import type { Layer, Scope } from "effect";
import { Entity, type ShardingConfig, type Sharding } from "effect/unstable/cluster";
import type { Rpc } from "effect/unstable/rpc";
import type {
  ActorDefinition,
  ActorRpcs,
  OperationConfig,
  OperationConfigs,
  OperationRpc,
  SingleActorDefinition,
} from "./actor.js";
import { buildRef, buildSingleRef } from "./client.js";
import type { Ref, SingleRef } from "./client.js";

export const testClient = <
  Name extends string,
  Ops extends OperationConfigs,
  Rpcs extends Rpc.Any = ActorRpcs<Ops>,
  LA = never,
  LE = never,
  LR = never,
>(
  actor: ActorDefinition<Name, Ops, Rpcs>,
  handlerLayer: Layer.Layer<LA, LE, LR>,
): Effect.Effect<
  (entityId: string) => Effect.Effect<Ref<Rpcs>>,
  LE,
  | Scope.Scope
  | ShardingConfig.ShardingConfig
  | Exclude<LR, Sharding.Sharding>
  | Rpc.MiddlewareClient<Rpcs>
> =>
  Effect.map(
    Entity.makeTestClient(actor.entity, handlerLayer),
    (makeClient) =>
      (entityId: string): Effect.Effect<Ref<Rpcs>> =>
        Effect.map(makeClient(entityId), (rpcClient) =>
          buildRef<Rpcs, never>(actor.name, entityId, actor.operations, rpcClient),
        ),
  );

export const testSingleClient = <
  Name extends string,
  C extends OperationConfig,
  R extends Rpc.Any = OperationRpc<Name, C>,
  LA = never,
  LE = never,
  LR = never,
>(
  actor: SingleActorDefinition<Name, C, R>,
  handlerLayer: Layer.Layer<LA, LE, LR>,
): Effect.Effect<
  (entityId: string) => Effect.Effect<SingleRef<R>>,
  LE,
  | Scope.Scope
  | ShardingConfig.ShardingConfig
  | Exclude<LR, Sharding.Sharding>
  | Rpc.MiddlewareClient<R>
> =>
  Effect.map(
    Entity.makeTestClient(actor.entity, handlerLayer),
    (makeClient) =>
      (entityId: string): Effect.Effect<SingleRef<R>> =>
        Effect.map(makeClient(entityId), (rpcClient) =>
          buildSingleRef<R, never>(
            actor.name,
            entityId,
            actor.operationTag,
            actor.operation as OperationConfig,
            rpcClient,
          ),
        ),
  );
