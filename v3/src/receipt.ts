import { Schema } from "effect";

export class CastReceipt extends Schema.Class<CastReceipt>("effect-encore/CastReceipt")({
  _tag: Schema.Literal("CastReceipt"),
  actorType: Schema.String,
  entityId: Schema.String,
  operation: Schema.String,
  primaryKey: Schema.optional(Schema.String),
}) {}

export const makeCastReceipt = (options: {
  readonly actorType: string;
  readonly entityId: string;
  readonly operation: string;
  readonly primaryKey?: string | undefined;
}): CastReceipt =>
  new CastReceipt({
    _tag: "CastReceipt",
    actorType: options.actorType,
    entityId: options.entityId,
    operation: options.operation,
    primaryKey: options.primaryKey,
  });

export type PeekResult<A = unknown, E = unknown> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Defect"; readonly cause: unknown };

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

export const isPending = <A, E>(result: PeekResult<A, E>): result is { _tag: "Pending" } =>
  result._tag === "Pending";

export const isSuccess = <A, E>(
  result: PeekResult<A, E>,
): result is { _tag: "Success"; value: A } => result._tag === "Success";

export const isFailure = <A, E>(
  result: PeekResult<A, E>,
): result is { _tag: "Failure"; error: E } => result._tag === "Failure";

export const isTerminal = <A, E>(result: PeekResult<A, E>): boolean => result._tag !== "Pending";
