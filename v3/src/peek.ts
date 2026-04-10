import { Duration, Effect, Option, Schedule, Stream } from "effect";
import { EntityAddress, EntityId, MessageStorage, Sharding } from "@effect/cluster";
import type { EntityType } from "@effect/cluster";
import type { MalformedMessage, PersistenceError } from "@effect/cluster/ClusterError";
import type { Rpc } from "@effect/rpc";
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
      entityType: actor.name as unknown as EntityType.EntityType,
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

    const replies = yield* storage.repliesForUnfiltered<Rpc.Any>([maybeRequestId.value]);
    const last = replies[replies.length - 1];

    if (!last || last._tag !== "WithExit") {
      return Pending as PeekResult;
    }

    return mapCauseEncodedToPeekResult(last.exit as ExitEncodedShape);
  });
};

// ── watch ─────────────────────────────────────────────────────────────────

export const watch = <Name extends string, Ops extends OperationConfigs>(
  actor: ActorDefinition<Name, Ops>,
  receipt: CastReceipt,
  options?: { readonly interval?: Duration.DurationInput },
): Stream.Stream<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | Sharding.Sharding
> => {
  const interval = options?.interval ?? Duration.millis(200);
  return Stream.repeatEffectWithSchedule(peek(actor, receipt), Schedule.spaced(interval)).pipe(
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

// ── v3 CauseEncoded → PeekResult mapping ─────────────────────────────────
// v3's CauseEncoded is a recursive tree (Empty|Fail|Die|Interrupt|Sequential|Parallel)
// v4 uses a flat array. We walk the tree to find the first meaningful cause.

type CauseEncodedShape =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Fail"; readonly error: unknown }
  | { readonly _tag: "Die"; readonly defect: unknown }
  | { readonly _tag: "Interrupt"; readonly fiberId: unknown }
  | {
      readonly _tag: "Sequential";
      readonly left: CauseEncodedShape;
      readonly right: CauseEncodedShape;
    }
  | {
      readonly _tag: "Parallel";
      readonly left: CauseEncodedShape;
      readonly right: CauseEncodedShape;
    };

type ExitEncodedShape =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly cause: CauseEncodedShape };

const mapCauseEncodedToPeekResult = (exit: ExitEncodedShape): PeekResult => {
  if (exit._tag === "Success") {
    return Success(exit.value);
  }

  const first = findFirstCause(exit.cause);
  if (!first) return Pending;

  switch (first._tag) {
    case "Fail":
      return Failure(first.error);
    case "Die":
      return Defect(first.defect);
    case "Interrupt":
      return Interrupted;
    default:
      return Pending;
  }
};

const findFirstCause = (
  cause: CauseEncodedShape,
):
  | { _tag: "Fail"; error: unknown }
  | { _tag: "Die"; defect: unknown }
  | { _tag: "Interrupt"; fiberId: unknown }
  | null => {
  switch (cause._tag) {
    case "Fail":
    case "Die":
    case "Interrupt":
      return cause;
    case "Empty":
      return null;
    case "Sequential":
    case "Parallel":
      return findFirstCause(cause.left) ?? findFirstCause(cause.right);
  }
};
