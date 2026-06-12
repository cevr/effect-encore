import { Effect } from "effect";
import type { DurableTableError } from "../vendor/durable-operators/index.ts";
import type { ActorTableService } from "./actor-table.ts";

/** Control-message tag for a cancel signal. Carried as a normal inbox message
 *  whose payload is the target ExecId; skipped by the job drain, observed by
 *  the driver's cancel watcher (driver.ts). */
export const CANCEL_TAG = "__cancel";

export interface InboxMessage {
  readonly msgId: string;
  readonly tag: string;
  readonly payload: string;
}

/**
 * Enqueue == `insertOrGet` on the messages collection. PK is the ExecId, so a
 * duplicate send resolves to `Found` and writes no second event — and we treat
 * `Found` as enqueued, exactly as effect-encore treats `SaveResult.Duplicate`
 * as enqueued for fire-and-forget `.send`. Idempotent by construction.
 */
export const enqueue = (
  table: ActorTableService,
  msg: InboxMessage,
): Effect.Effect<void, DurableTableError> => Effect.asVoid(table.messages.insertOrGet(msg));
