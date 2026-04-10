import { Effect } from "effect";
import type { ActorDefinition, OperationDefinitions } from "./actor.js";

export type Ref<Ops extends OperationDefinitions> = {
  readonly [K in keyof Ops]: {
    readonly call: Ops[K]["payload"] extends Record<string, unknown>
      ? (payload: {
          readonly [F in keyof Ops[K]["payload"]]: unknown;
        }) => Effect.Effect<unknown, unknown>
      : () => Effect.Effect<unknown, unknown>;
  };
};

export const buildRef = <Ops extends OperationDefinitions>(
  operations: Ops,
  rpcClient: Record<string, Function>,
): Ref<Ops> => {
  const ref = {} as Record<string, unknown>;
  for (const tag of Object.keys(operations)) {
    const hasPayload = operations[tag]?.payload !== undefined;
    ref[tag] = {
      call: (payload?: unknown) => {
        const fn = rpcClient[tag];
        return hasPayload ? fn?.(payload) : fn?.();
      },
    };
  }
  return ref as Ref<Ops>;
};

export const client = <Name extends string, Ops extends OperationDefinitions>(
  actor: ActorDefinition<Name, Ops>,
): Effect.Effect<(entityId: string) => Ref<Ops>, never, never> =>
  Effect.map(
    (actor.entity as unknown as { client: Effect.Effect<Function> }).client,
    (makeClient) =>
      (entityId: string): Ref<Ops> => {
        const rpcClient = makeClient(entityId) as Record<string, Function>;
        return buildRef(actor.operations, rpcClient);
      },
  ) as Effect.Effect<(entityId: string) => Ref<Ops>, never, never>;
