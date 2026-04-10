import { Effect } from "effect";
import type { Rpc, RpcClient } from "effect/unstable/rpc";
import type { OperationConfig, OperationConfigs } from "./actor.js";
import { makeCastReceipt } from "./receipt.js";
import type { CastReceipt } from "./receipt.js";

// ── Ref: typed per-operation handle ────────────────────────────────────────

export type OperationHandle<Current extends Rpc.Any, E = never> = {
  readonly call: (
    ...args: [Rpc.Payload<Current>] extends [void] ? [] : [payload: Rpc.PayloadConstructor<Current>]
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current> | E>;
  readonly cast: (
    ...args: [Rpc.Payload<Current>] extends [void] ? [] : [payload: Rpc.PayloadConstructor<Current>]
  ) => Effect.Effect<CastReceipt, Rpc.Error<Current> | E>;
};

export type Ref<Rpcs extends Rpc.Any, E = never> = {
  readonly [Current in Rpcs as Current["_tag"]]: OperationHandle<Current, E>;
};

export type SingleRef<R extends Rpc.Any, E = never> = OperationHandle<R, E>;

// ── Build refs from RpcClient ──────────────────────────────────────────────

export const buildRef = <Rpcs extends Rpc.Any, E>(
  actorName: string,
  entityId: string,
  operations: OperationConfigs,
  rpcClient: RpcClient.RpcClient<Rpcs, E>,
): Ref<Rpcs, E> => {
  const client = rpcClient as Record<string, Function>;
  const ref = {} as Record<string, unknown>;

  for (const tag of Object.keys(operations)) {
    const op = operations[tag] as OperationConfig;
    const hasPayload = op["payload"] !== undefined;
    const fn = client[tag];

    ref[tag] = {
      call: (payload?: unknown) => (hasPayload ? fn?.(payload) : fn?.()),
      cast: (payload?: unknown) => {
        const discardCall = hasPayload
          ? fn?.(payload, { discard: true })
          : fn?.(undefined, { discard: true });
        return Effect.map(discardCall ?? Effect.void, () =>
          makeCastReceipt({
            actorType: actorName,
            entityId,
            operation: tag,
            primaryKey: op["primaryKey"]
              ? (op["primaryKey"] as Function)(payload)
              : crypto.randomUUID(),
          }),
        );
      },
    };
  }

  return ref as Ref<Rpcs, E>;
};

export const buildSingleRef = <R extends Rpc.Any, E>(
  actorName: string,
  entityId: string,
  operationTag: string,
  operation: OperationConfig,
  rpcClient: RpcClient.RpcClient<R, E>,
): SingleRef<R, E> => {
  const client = rpcClient as Record<string, Function>;
  const hasPayload = operation["payload"] !== undefined;
  const fn = client[operationTag];

  return {
    call: ((payload?: unknown) => (hasPayload ? fn?.(payload) : fn?.())) as SingleRef<R, E>["call"],
    cast: ((payload?: unknown) => {
      const discardCall = hasPayload
        ? fn?.(payload, { discard: true })
        : fn?.(undefined, { discard: true });
      return Effect.map(discardCall ?? Effect.void, () =>
        makeCastReceipt({
          actorType: actorName,
          entityId,
          operation: operationTag,
          primaryKey: operation["primaryKey"]
            ? (operation["primaryKey"] as Function)(payload)
            : crypto.randomUUID(),
        }),
      );
    }) as SingleRef<R, E>["cast"],
  };
};
