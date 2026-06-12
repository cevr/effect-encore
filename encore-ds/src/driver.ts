import { Effect, Stream } from "effect";
import type { ActorTableService } from "./actor-table.ts";
import { CANCEL_TAG } from "./mailbox.ts";
import type { ExecId } from "./receipt.ts";

// ─────────────────────────────────────────────────────────────────────────
// driver.ts — Delivery != preemption (design invariant 7).
//
// Storage makes the cancel durable + observable; the driver decides how the
// running turn reacts. Here: a watcher fiber tails the inbox feed for a cancel
// targeting this ExecId and races the step. If the cancel wins, the step fiber
// is interrupted — the cancel is observable mid-flight, not just at boundaries.
// ─────────────────────────────────────────────────────────────────────────

/** Completes when a cancel message for `execId` appears on the feed. Its own
 *  independent `rows()` subscription, so it observes the cancel even while the
 *  step fiber is busy. */
const watchCancel = (table: ActorTableService, execId: ExecId): Effect.Effect<void> =>
  table.messages.rows().pipe(
    Stream.filter((m) => m.tag === CANCEL_TAG && m.payload === execId),
    Stream.runHead,
    Effect.asVoid,
    // The feed read can only fail with DurableTableError; treat a watcher
    // failure as "no cancel" rather than killing the step.
    Effect.catchCause(() => Effect.never),
  );

/**
 * Run a step alongside the cancel watcher. If the cancel arrives first, the
 * step fiber is interrupted (the step's resulting Exit is Interrupted, which
 * `exitToOutcome` records). Otherwise the step's value/failure flows through.
 */
export const runStep = <A, E, R>(
  table: ActorTableService,
  execId: ExecId,
  step: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.raceFirst(
    step,
    Effect.flatMap(watchCancel(table, execId), () => Effect.interrupt),
  );
