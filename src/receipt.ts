import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import { MessageStorage } from "effect/unstable/cluster";
import type { MalformedMessage, PersistenceError } from "effect/unstable/cluster/ClusterError";
import type { RpcMessage } from "effect/unstable/rpc";
import { ActorAddressResolver } from "./actor-address-resolver.js";

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
    // Degenerate forms are load-bearing: a bare id with no separators maps to
    // entityId == tag == primaryKey == execId (see the module header).
    const firstSep = execId.indexOf("\x00");
    if (firstSep < 0) {
      return { entityId: execId, tag: execId, primaryKey: execId };
    }
    const secondSep = execId.indexOf("\x00", firstSep + 1);
    if (secondSep < 0) {
      return {
        entityId: execId.slice(0, firstSep),
        tag: execId.slice(firstSep + 1),
        primaryKey: execId,
      };
    }
    return {
      entityId: execId.slice(0, firstSep),
      tag: execId.slice(firstSep + 1, secondSep),
      primaryKey: execId.slice(secondSep + 1),
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

// ── Exit → PeekResult classification (pure, unit-testable) ────────────────
//
// Lifted out of `actor.ts` so the Exit-classification logic is unit-testable
// without a live cluster. The encoded-vs-real Exit asymmetry is preserved
// exactly: the **entity** await path maps an `RpcMessage.ExitEncoded` (the
// shape persisted in `cluster_replies`), while the **workflow** poll path maps
// a real `Exit.Exit` by walking its `Cause` tree.

/** The success and error schema slots used to decode stored replies. */
export interface ReplyDef {
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
}

export type ReplyDefs = Record<string, ReplyDef>;

/**
 * Decode `value` through `schema` if present. On decode failure the raw value
 * is returned unchanged (the reply was already validated on the wire; this is
 * a best-effort typed-view, not a gate).
 */
export const decodeValue = (
  schema: Schema.Top | undefined,
  value: unknown,
): Effect.Effect<unknown> => {
  if (!schema) return Effect.succeed(value);
  // Decoding is best-effort: an undecodable value falls back to the raw input.
  // The schema is type-erased here, so its decoding services are unknown; the
  // assertion drops them because callers never supply them.
  const decode = Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown>;
  return Effect.map(
    Effect.option(decode),
    Option.getOrElse(() => value),
  );
};

/**
 * Map the encoded reply Exit (entity path) to a `PeekResult`, decoding the
 * success/error payload through the operation's schema slots when available.
 */
export const mapExitToPeekResult = (
  exit: RpcMessage.ExitEncoded<unknown, unknown>,
  def?: ReplyDef,
): Effect.Effect<PeekResult> => {
  if (exit._tag === "Success") {
    return Effect.map(decodeValue(def?.success, exit.value), Success);
  }

  const cause = exit.cause[0];
  if (!cause) return Effect.succeed(Pending);

  switch (cause._tag) {
    case "Fail":
      return Effect.map(decodeValue(def?.error, cause.error), Failure);
    case "Die":
      return Effect.succeed(Defect(cause.defect));
    case "Interrupt":
      return Effect.succeed(Interrupted);
    default:
      return Effect.succeed(Pending);
  }
};

/**
 * Map a real `Exit.Exit` (workflow poll path) to a `PeekResult` by walking its
 * `Cause` tree. Unlike the entity path this Exit is not encoded, so the error
 * is read straight off the cause rather than schema-decoded.
 */
export const mapExitToWorkflowPeekResult = (exit: Exit.Exit<unknown, unknown>): PeekResult => {
  if (Exit.isSuccess(exit)) {
    return Success(exit.value);
  }
  const cause = exit.cause;
  const errorOpt = Cause.findErrorOption(cause);
  if (Option.isSome(errorOpt)) return Failure(errorOpt.value);

  const defectResult = Cause.findDefect(cause);
  if (defectResult._tag === "Success") return Defect(defectResult.success);

  const interruptResult = Cause.findInterrupt(cause);
  if (interruptResult._tag === "Success") return Interrupted;

  return Pending;
};

// ── Stored reply lookup ────────────────────────────────────────────────────

export const peekStoredReply = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity protocols are type-erased here.
  entity: ClusterEntity.Entity<string, any>,
  execId: string,
  definitions?: ReplyDefs,
): Effect.Effect<
  PeekResult,
  PersistenceError | MalformedMessage,
  MessageStorage.MessageStorage | ActorAddressResolver
> => {
  const parsed = ExecIdCodec.decode(execId);

  return Effect.gen(function* () {
    const storage = yield* MessageStorage.MessageStorage;
    const resolver = yield* ActorAddressResolver;
    const address = resolver.resolveEntity(entity, parsed.entityId);
    const maybeRequestId = yield* storage.requestIdForPrimaryKey({
      address,
      tag: parsed.tag,
      id: parsed.primaryKey,
    });
    if (Option.isNone(maybeRequestId)) return Pending;

    const replies = yield* storage.repliesForUnfiltered([maybeRequestId.value]);
    const last = replies[replies.length - 1];
    if (last === undefined || last._tag !== "WithExit") return Pending;

    return yield* mapExitToPeekResult(last.exit, definitions?.[parsed.tag]);
  });
};
