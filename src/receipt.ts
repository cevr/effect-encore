import { Schema } from "effect";

// ── ExecId — branded execution identifier ────────────────────────────────

declare const ExecIdBrand: unique symbol;

export type ExecId<Success = unknown, Error = unknown> = string & {
  readonly [ExecIdBrand]: {
    readonly success: Success;
    readonly error: Error;
  };
};

export const makeExecId = <S = unknown, E = unknown>(id: string): ExecId<S, E> =>
  id as ExecId<S, E>;

// ── ExecIdCodec — single mint/parse boundary ─────────────────────────────
//
// The entity ExecId wire format is `${entityId}\x00${tag}\x00${primaryKey}`.
// This 3-tuple is persisted into `cluster_messages` dedup identity, so the
// byte layout is a FROZEN wire contract — centralizing construction here must
// not normalize/escape segments. `encode` is the single mint; `decode` is the
// verbatim parse (single-separator and no-separator fallbacks preserved), so a
// no-separator id (single-segment workflow `makeExecId(executionId)`) decodes
// to `entityId == tag == primaryKey == execId`.

export interface ExecIdComponents {
  readonly entityId: string;
  readonly tag: string;
  readonly primaryKey: string;
}

export const ExecIdCodec = {
  encode: <S = unknown, E = unknown>(components: ExecIdComponents): ExecId<S, E> =>
    makeExecId<S, E>(`${components.entityId}\x00${components.tag}\x00${components.primaryKey}`),

  decode: (execId: string): ExecIdComponents => {
    const firstSep = execId.indexOf("\x00");
    const secondSep = firstSep >= 0 ? execId.indexOf("\x00", firstSep + 1) : -1;
    return {
      entityId: firstSep >= 0 ? execId.slice(0, firstSep) : execId,
      tag:
        secondSep >= 0
          ? execId.slice(firstSep + 1, secondSep)
          : firstSep >= 0
            ? execId.slice(firstSep + 1)
            : execId,
      primaryKey: secondSep >= 0 ? execId.slice(secondSep + 1) : execId,
    };
  },
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

export const Defect = (cause: unknown): PeekResult => ({
  _tag: "Defect",
  cause,
});

export const Suspended: PeekResult = { _tag: "Suspended" };

export const isPending = <A, E>(result: PeekResult<A, E>): result is { _tag: "Pending" } =>
  result._tag === "Pending";

export const isSuccess = <A, E>(
  result: PeekResult<A, E>,
): result is { _tag: "Success"; value: A } => result._tag === "Success";

export const isFailure = <A, E>(
  result: PeekResult<A, E>,
): result is { _tag: "Failure"; error: E } => result._tag === "Failure";

export const isSuspended = <A, E>(result: PeekResult<A, E>): result is { _tag: "Suspended" } =>
  result._tag === "Suspended";

export const isTerminal = <A, E>(result: PeekResult<A, E>): boolean =>
  result._tag !== "Pending" && result._tag !== "Suspended";

// ── PeekResult Schema ───────────────────────────────────────────────────

export const PeekResultSchema = <Success extends Schema.Top, Error extends Schema.Top>(
  success: Success,
  error: Error,
) =>
  Schema.Union([
    Schema.TaggedStruct("Pending", {}),
    Schema.TaggedStruct("Success", { value: success }),
    Schema.TaggedStruct("Failure", { error: error }),
    Schema.TaggedStruct("Interrupted", {}),
    Schema.TaggedStruct("Defect", { cause: Schema.Unknown }),
    Schema.TaggedStruct("Suspended", {}),
  ]);
