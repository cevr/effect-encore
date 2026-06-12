import { Effect, Option, Stream } from "effect";
import type { DurableTableError } from "../vendor/durable-operators/index.ts";
import type { ActorTableService } from "./actor-table.ts";
import { decodeOutcome } from "./outcome.ts";
import { type ExecId, Pending, type PeekResult } from "./receipt.ts";

/** Non-blocking read of a completion row. Pending if absent. */
export const peekReply = (
  table: ActorTableService,
  execId: ExecId,
): Effect.Effect<PeekResult, DurableTableError> =>
  Effect.map(table.replies.get(execId), (opt) =>
    Option.isSome(opt) ? decodeOutcome(opt.value.exit) : Pending,
  );

/**
 * Block until the completion row for `execId` exists, then return it. Built
 * from the public replay-then-tail `rows()` feed (DurableTable exposes no
 * public `waitForStoredRow`): the reply replays immediately if already
 * present, otherwise the subscription tails until it arrives. `runHead`
 * resolves on the first matching row.
 */
export const waitForReply = (
  table: ActorTableService,
  execId: ExecId,
): Effect.Effect<PeekResult, DurableTableError> =>
  table.replies.rows().pipe(
    Stream.filter((row) => row.execId === execId),
    Stream.map((row) => decodeOutcome(row.exit)),
    Stream.runHead,
    Effect.map((opt) => Option.getOrElse(opt, () => Pending)),
  );
