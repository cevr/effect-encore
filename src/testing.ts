import { Effect } from "effect";
import type { Layer, Scope } from "effect";
import { Entity } from "effect/unstable/cluster";
import type { Rpc, RpcClient } from "effect/unstable/rpc";
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
>(
  actor: ActorDefinition<Name, Ops, Rpcs>,
  handlerLayer: Layer.Layer<never>,
): Effect.Effect<(entityId: string) => Effect.Effect<Ref<Rpcs>>, never, Scope.Scope> =>
  Effect.map(
    Entity.makeTestClient(actor.entity, handlerLayer as Layer.Layer<never>) as Effect.Effect<
      (entityId: string) => Effect.Effect<RpcClient.RpcClient<Rpcs>>,
      never,
      Scope.Scope
    >,
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
>(
  actor: SingleActorDefinition<Name, C, R>,
  handlerLayer: Layer.Layer<never>,
): Effect.Effect<(entityId: string) => Effect.Effect<SingleRef<R>>, never, Scope.Scope> =>
  Effect.map(
    Entity.makeTestClient(actor.entity, handlerLayer as Layer.Layer<never>) as Effect.Effect<
      (entityId: string) => Effect.Effect<RpcClient.RpcClient<R>>,
      never,
      Scope.Scope
    >,
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
