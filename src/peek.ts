import { Effect, Option } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import type { MalformedMessage, PersistenceError } from "effect/unstable/cluster/ClusterError";
import type { RpcMessage } from "effect/unstable/rpc";
import type { ActorDefinition, OperationConfigs } from "./actor.js";
import type { CastReceipt, PeekResult } from "./receipt.js";
import { Defect, Failure, Interrupted, Pending, Success } from "./receipt.js";

// ── Errors ────────────────────────────────────────────────────────────────

export class NoPrimaryKeyError {
  readonly _tag = "NoPrimaryKeyError";
  readonly message: string;
  constructor(readonly receipt: CastReceipt) {
    this.message = `Cannot peek receipt for ${receipt.actorType}.${receipt.operation}: no primaryKey defined on operation`;
  }
}

// ── peek ──────────────────────────────────────────────────────────────────

export const peek = <Name extends string, Ops extends OperationConfigs>(
  actor: ActorDefinition<Name, Ops>,
  receipt: CastReceipt,
): Effect.Effect<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const op = actor.operations[receipt.operation];
  if (!op || !op["primaryKey"]) {
    return Effect.die(new NoPrimaryKeyError(receipt));
  }

  return Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    const storage = yield* MessageStorage.MessageStorage;

    const entityId = EntityId.make(receipt.entityId);
    const group = actor.entity.getShardGroup(entityId);
    const shardId = sharding.getShardId(entityId, group);

    const address = EntityAddress.make({
      entityType: EntityType.make(receipt.actorType),
      entityId,
      shardId,
    });

    const maybeRequestId = yield* storage.requestIdForPrimaryKey({
      address,
      tag: receipt.operation,
      id: receipt.primaryKey,
    });

    if (Option.isNone(maybeRequestId)) {
      return Pending as PeekResult;
    }

    const replies = yield* storage.repliesForUnfiltered([maybeRequestId.value]);
    const last = replies[replies.length - 1];

    if (!last || last._tag !== "WithExit") {
      return Pending as PeekResult;
    }

    return mapExitToPeekResult(last.exit);
  });
};

// ── Exit → PeekResult mapping ────────────────────────────────────────────

const mapExitToPeekResult = (exit: RpcMessage.ExitEncoded<unknown, unknown>): PeekResult => {
  if (exit._tag === "Success") {
    return Success(exit.value);
  }

  const cause = exit.cause[0];
  if (!cause) return Pending;

  switch (cause._tag) {
    case "Fail":
      return Failure(cause.error);
    case "Die":
      return Defect(cause.defect);
    case "Interrupt":
      return Interrupted;
  }
};
