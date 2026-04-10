import { Effect } from "effect";
import type { Layer, Scope } from "effect";
import { Entity } from "effect/unstable/cluster";
import type { ActorDefinition, OperationDefinitions } from "./actor.js";
import { buildRef } from "./client.js";
import type { Ref } from "./client.js";

export const testClient = <Name extends string, Ops extends OperationDefinitions>(
  actor: ActorDefinition<Name, Ops>,
  handlerLayer: Layer.Layer<never, never, never>,
): Effect.Effect<(entityId: string) => Effect.Effect<Ref<Ops>>, never, Scope.Scope> =>
  Effect.map(
    Entity.makeTestClient(
      actor.entity,
      handlerLayer as Layer.Layer<never, never, never>,
    ) as Effect.Effect<
      (entityId: string) => Effect.Effect<Record<string, Function>>,
      never,
      Scope.Scope
    >,
    (makeClient) =>
      (entityId: string): Effect.Effect<Ref<Ops>> =>
        Effect.map(makeClient(entityId), (rpcClient) => buildRef(actor.operations, rpcClient)),
  );
