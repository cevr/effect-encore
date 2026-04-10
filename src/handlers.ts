import type { Layer } from "effect";
import type { ActorDefinition, OperationDefinitions } from "./actor.js";

export const handlers = <Name extends string, Ops extends OperationDefinitions>(
  actor: ActorDefinition<Name, Ops>,
  handlerMap: Record<string, Function>,
): Layer.Layer<never, never, never> => {
  return (actor.entity as unknown as { toLayer: Function }).toLayer(handlerMap) as Layer.Layer<
    never,
    never,
    never
  >;
};
