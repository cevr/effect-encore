import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Entity as ClusterEntity } from "effect/cluster";
import { MessageStorage } from "effect/cluster";
import type { MalformedMessage, PersistenceError } from "effect/cluster/ClusterError";
import type { RpcMessage } from "effect/rpc";
import { ActorAddressResolver } from "./actor-address-resolver.js";

declare const ExecIdBrand: unique symbol;

export type ExecId<Success = unknown, Error = unknown> = string & {
  readonly [ExecIdBrand]: {
    readonly success: Success;
    readonly error: Error;
  };
};

export function makeExecId<S = unknown, E = unknown>(id: string): ExecId<S, E>;
export function makeExecId(id: string): string {
  return id;
}

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

export type PeekResult<A = unknown, E = unknown> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Defect"; readonly cause: unknown }
  | { readonly _tag: "Suspended" };

export const Pending = { _tag: "Pending" } satisfies PeekResult;

export const Success = <A>(value: A): PeekResult<A, never> => ({
  _tag: "Success",
  value,
});

export const Failure = <E>(error: E): PeekResult<never, E> => ({
  _tag: "Failure",
  error,
});

export const Interrupted = { _tag: "Interrupted" } satisfies PeekResult;

export const Defect = (cause: unknown) =>
  ({
    _tag: "Defect",
    cause,
  }) satisfies PeekResult;

export const Suspended = { _tag: "Suspended" } satisfies PeekResult;

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

export interface ReplyDef {
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
}

export type ReplyDefs = Record<string, ReplyDef>;

function eraseSchemaDecodingServices(
  effect: Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<unknown, unknown>;
function eraseSchemaDecodingServices(
  effect: Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<unknown, unknown, unknown> {
  return effect;
}

export const decodeValue = <Input>(
  schema: Schema.Top | void,
  value: Input,
): Effect.Effect<unknown> => {
  if (!schema) return Effect.succeed(value);
  const decode = eraseSchemaDecodingServices(Schema.decodeUnknownEffect(schema)(value));
  return Effect.map(
    Effect.option(decode),
    Option.getOrElse(() => value),
  );
};

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

export const mapExitToWorkflowPeekResult = <A, E>(exit: Exit.Exit<A, E>): PeekResult<A, E> => {
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
    const lastOption = Option.fromNullishOr(replies[replies.length - 1]);
    if (Option.isNone(lastOption) || lastOption.value._tag !== "WithExit") return Pending;
    const last = lastOption.value;

    return yield* mapExitToPeekResult(last.exit, definitions?.[parsed.tag]);
  });
};
