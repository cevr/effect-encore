import { Effect, Schema } from "effect";
import { DurableTable } from "../vendor/durable-operators/index.ts";
import type { DurableTableError } from "../vendor/durable-operators/index.ts";
import { actorStreamUrl } from "./addressing.ts";
import { EncoreConfig } from "./config.ts";

// ─────────────────────────────────────────────────────────────────────────
// One DurableTable == one Durable Stream. An actor owns a single stream that
// carries three collections (invariant: stream-per-actor, §1/§2 of the design):
//   - messages : the durable mailbox. PK = ExecId  => idempotent send.
//   - owner    : the single-writer drain claim. PK = "drain/<epoch>".
//   - replies  : completion records. PK = ExecId  => reply correlation + the
//                durable "already executed" marker that makes replay safe.
// ─────────────────────────────────────────────────────────────────────────

const pk = DurableTable.primaryKey;

export const ActorTable = DurableTable("encore-actor", {
  messages: Schema.Struct({
    msgId: pk(Schema.String),
    tag: Schema.String,
    payload: Schema.String, // JSON-encoded operation payload
  }),
  owner: Schema.Struct({
    key: pk(Schema.String),
    worker: Schema.String,
    epoch: Schema.Number,
  }),
  replies: Schema.Struct({
    execId: pk(Schema.String),
    exit: Schema.String, // JSON-encoded Exit (see encodeExit/decodeExit)
  }),
});

export type ActorTableService = (typeof ActorTable)["Service"];

/**
 * Provision the actor's stream (build the DurableTable layer for its URL) and
 * run `use` with the materialized facade. The layer is scoped to `use`: for an
 * ephemeral `send` it opens and closes around the append; for a long-lived
 * drain it stays open for the whole loop. Concurrent activations are distinct
 * fibers, each providing its own `ActorTable` binding at its own URL — no tag
 * collision, which is what makes stream-per-actor work under one shared tag.
 */
export const withActor = <A, E, R>(
  actorType: string,
  actorId: string,
  use: (table: ActorTableService) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DurableTableError, R | EncoreConfig> =>
  Effect.gen(function* () {
    const cfg = yield* EncoreConfig;
    const url = actorStreamUrl(cfg.baseUrl, actorType, actorId);
    // contentType MUST match the stream's creation content-type, else the
    // server rejects producer appends with a 409 content-type mismatch. The
    // DurableTable producer path posts application/json, so pin it here.
    const layer = ActorTable.layer({
      streamOptions:
        cfg.headers === undefined
          ? { url, contentType: "application/json" }
          : { url, contentType: "application/json", headers: cfg.headers },
    });
    const run = Effect.gen(function* () {
      const table = yield* ActorTable;
      return yield* use(table);
    });
    return yield* Effect.provide(run, layer);
  });
