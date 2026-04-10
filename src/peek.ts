import { Duration, Effect, Option, Schedule, Stream } from "effect";
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
import { Defect, Failure, Interrupted, isTerminal, Pending, Success } from "./receipt.js";

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
      entityType: EntityType.make(actor.name),
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

// ── watch ─────────────────────────────────────────────────────────────────

export const watch = <Name extends string, Ops extends OperationConfigs>(
  actor: ActorDefinition<Name, Ops>,
  receipt: CastReceipt,
  options?: { readonly interval?: Duration.Input },
): Stream.Stream<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const interval = options?.interval ?? Duration.millis(200);
  return Stream.fromEffectSchedule(peek(actor, receipt), Schedule.spaced(interval)).pipe(
    Stream.changesWith(peekResultEquals),
    Stream.takeUntil(isTerminal),
  );
};

const peekResultEquals = (a: PeekResult, b: PeekResult): boolean => {
  if (a._tag !== b._tag) return false;
  if (a._tag === "Success" && b._tag === "Success") return a.value === b.value;
  if (a._tag === "Failure" && b._tag === "Failure") return a.error === b.error;
  if (a._tag === "Defect" && b._tag === "Defect") return a.cause === b.cause;
  return true;
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
