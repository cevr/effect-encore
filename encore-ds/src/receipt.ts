import { Schema } from "effect";

// ── ExecId — branded execution identifier ────────────────────────────────
//
// Ported verbatim from effect-encore. The format is intentionally identical:
//   `entityId\0tag\0primaryKey`  (null-byte separated — safe with colons in
//   any segment). Keeping the exact format means peek/watch/waitFor and any
//   consumer that round-trips an ExecId behaves the same across backbones.

declare const ExecIdBrand: unique symbol;

export type ExecId<Success = unknown, Error = unknown> = string & {
  readonly [ExecIdBrand]: {
    readonly success: Success;
    readonly error: Error;
  };
};

export const makeExecId = <S = unknown, E = unknown>(id: string): ExecId<S, E> =>
  id as ExecId<S, E>;

const SEP = "\u0000";

export const execIdOf = <S = unknown, E = unknown>(
  entityId: string,
  tag: string,
  primaryKey: string,
): ExecId<S, E> => makeExecId(`${entityId}${SEP}${tag}${SEP}${primaryKey}`);

export interface ExecIdParts {
  readonly entityId: string;
  readonly tag: string;
  readonly primaryKey: string;
}

export const parseExecId = (execId: string): ExecIdParts => {
  const parts = execId.split(SEP);
  if (parts.length === 3) {
    return { entityId: parts[0]!, tag: parts[1]!, primaryKey: parts[2]! };
  }
  // Fallback: treat the whole string as all three (mirrors encore's tolerant
  // parse for ids that were not minted in the three-segment form).
  return { entityId: execId, tag: execId, primaryKey: execId };
};

// ── PeekResult ───────────────────────────────────────────────────────────

export type PeekResult<A = unknown, E = unknown> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Defect"; readonly cause: unknown }
  | { readonly _tag: "Suspended" };

export const Pending: PeekResult = { _tag: "Pending" };

export const Success = <A>(value: A): PeekResult<A, never> => ({
  _tag: "Success",
  value,
});

export const Failure = <E>(error: E): PeekResult<never, E> => ({
  _tag: "Failure",
  error,
});

export const Interrupted: PeekResult = { _tag: "Interrupted" };

export const Defect = (cause: unknown): PeekResult => ({ _tag: "Defect", cause });

export const Suspended: PeekResult = { _tag: "Suspended" };

export const isPending = <A, E>(r: PeekResult<A, E>): r is { _tag: "Pending" } =>
  r._tag === "Pending";

export const isSuccess = <A, E>(r: PeekResult<A, E>): r is { _tag: "Success"; value: A } =>
  r._tag === "Success";

export const isFailure = <A, E>(r: PeekResult<A, E>): r is { _tag: "Failure"; error: E } =>
  r._tag === "Failure";

export const isSuspended = <A, E>(r: PeekResult<A, E>): r is { _tag: "Suspended" } =>
  r._tag === "Suspended";

export const isTerminal = <A, E>(r: PeekResult<A, E>): boolean =>
  r._tag !== "Pending" && r._tag !== "Suspended";

// ── PeekResult Schema ────────────────────────────────────────────────────

export const PeekResultSchema = <Success extends Schema.Top, Error extends Schema.Top>(
  success: Success,
  error: Error,
) =>
  Schema.Union([
    Schema.TaggedStruct("Pending", {}),
    Schema.TaggedStruct("Success", { value: success }),
    Schema.TaggedStruct("Failure", { error }),
    Schema.TaggedStruct("Interrupted", {}),
    Schema.TaggedStruct("Defect", { cause: Schema.Unknown }),
    Schema.TaggedStruct("Suspended", {}),
  ]);
