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
