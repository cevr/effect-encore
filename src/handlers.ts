import type { Effect, Layer } from "effect";
import type { Entity } from "effect/unstable/cluster";
import type { Rpc } from "effect/unstable/rpc";
import type { ActorDefinition, ActorRpcs, OperationConfigs } from "./actor.js";

export const handlers = <
  Name extends string,
  Ops extends OperationConfigs,
  Rpcs extends Rpc.Any = ActorRpcs<Ops>,
  Handlers extends Entity.HandlersFrom<Rpcs> = Entity.HandlersFrom<Rpcs>,
>(
  actor: ActorDefinition<Name, Ops, Rpcs>,
  build: Handlers | Effect.Effect<Handlers>,
): Layer.Layer<never> => {
  return actor.entity.toLayer(build as Entity.HandlersFrom<Rpcs>) as Layer.Layer<never>;
};
