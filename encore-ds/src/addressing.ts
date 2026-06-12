import { execIdOf, type ExecId } from "./receipt.ts";

// ─────────────────────────────────────────────────────────────────────────
// addressing.ts — THE ONLY SEAM THAT KNOWS PHYSICAL STREAM LAYOUT.
//
// Per the design contract (encore-ds-design.md §8): whether one actor maps to
// one stream, or many cold actors multiplex onto a shared stream, is decided
// here and nowhere else. Nothing in mailbox/activation/replies/driver may
// assume stream-per-actor. Today: stream-per-actor.
// ─────────────────────────────────────────────────────────────────────────

/** Physical stream URL for an actor's mailbox (inbox + owner + replies live
 *  in collections on this one stream). v1: one stream per (type, actorId). */
export const actorStreamUrl = (baseUrl: string, actorType: string, actorId: string): string => {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/encore/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}`;
};

// ── id() resolution — mirrors effect-encore's resolveId ──────────────────
//
// A single `id` fn yields either a string (entityId === primaryKey) or a
// `{ entityId, primaryKey? }` object (primaryKey defaults to entityId).

export type EntityIdReturn = string | { readonly entityId: string; readonly primaryKey?: string };

export interface ResolvedId {
  readonly entityId: string;
  readonly primaryKey: string;
}

export const resolveId = (raw: EntityIdReturn): ResolvedId =>
  typeof raw === "string"
    ? { entityId: raw, primaryKey: raw }
    : { entityId: raw.entityId, primaryKey: raw.primaryKey ?? raw.entityId };

/** Derive the opaque ExecId for an operation dispatch. Pure + deterministic:
 *  `entityId\0tag\0primaryKey`, exactly as effect-encore. */
export const deriveExecId = <S = unknown, E = unknown>(
  tag: string,
  resolved: ResolvedId,
): ExecId<S, E> => execIdOf<S, E>(resolved.entityId, tag, resolved.primaryKey);
