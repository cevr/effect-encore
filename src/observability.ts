export { CurrentAddress } from "effect/cluster/Entity";

export const defaultSpanAttributes = (actorName: string) =>
  ({
    "actor.name": actorName,
    "actor.library": "effect-encore",
  }) satisfies Record<string, string>;
