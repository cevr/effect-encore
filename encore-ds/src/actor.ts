import { Effect, type Schema } from "effect";
import type { DurableTableError } from "../vendor/durable-operators/index.ts";
import { type Handlers, activate } from "./activation.ts";
import { type EntityIdReturn, deriveExecId, resolveId } from "./addressing.ts";
import { type ActorTableService, withActor } from "./actor-table.ts";
import type { EncoreConfig } from "./config.ts";
import { type InboxMessage, enqueue } from "./mailbox.ts";
import { peekReply, waitForReply } from "./replies.ts";
import { type ExecId, type PeekResult, isFailure, isSuccess } from "./receipt.ts";

// ── Operation definition ─────────────────────────────────────────────────

export interface OperationDef<P = unknown, S = unknown, E = unknown> {
  /** Deterministic id: string (entityId === primaryKey) or
   *  { entityId, primaryKey? }. Drives addressing + dedup + ExecId. */
  readonly id: (payload: P) => EntityIdReturn;
  readonly payload?: Schema.Codec<P, unknown>;
  readonly success?: Schema.Codec<S, unknown>;
  readonly error?: Schema.Codec<E, unknown>;
}

// `any` in the constraint position keeps the invariant `Schema.Codec` fields
// from rejecting concrete operation defs (exactOptionalPropertyTypes variance).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperationDef = OperationDef<any, any, any>;

type PayloadOf<D> = D extends OperationDef<infer P, infer _S, infer _E> ? P : never;
type SuccessOf<D> = D extends OperationDef<infer _P, infer S, infer _E> ? S : never;
type ErrorOf<D> = D extends OperationDef<infer _P, infer _S, infer E> ? E : never;

// ── Per-operation handle (payload-only methods) ──────────────────────────

export interface OperationHandle<P, S, E> {
  /** Pure, deterministic ExecId for this dispatch. */
  readonly executionId: (payload: P) => ExecId<S, E>;
  /** Producer-only: enqueue (idempotent) and return the ExecId. No handler
   *  needs to be registered in this process. */
  readonly send: (payload: P) => Effect.Effect<ExecId<S, E>, DurableTableError, EncoreConfig>;
  /** Enqueue then await the terminal outcome; surface the success value or fail
   *  with the operation's error. */
  readonly execute: (payload: P) => Effect.Effect<S, E | DurableTableError, EncoreConfig>;
  /** Non-blocking status. */
  readonly peek: (payload: P) => Effect.Effect<PeekResult<S, E>, DurableTableError, EncoreConfig>;
  /** Block until terminal, then return the PeekResult. */
  readonly waitFor: (
    payload: P,
  ) => Effect.Effect<PeekResult<S, E>, DurableTableError, EncoreConfig>;
  /** Escape hatch: build the inbox message without dispatching. */
  readonly make: (payload: P) => InboxMessage;
}

const makeHandle = <P, S, E>(
  actorType: string,
  tag: string,
  def: OperationDef<P, S, E>,
): OperationHandle<P, S, E> => {
  const idOf = (payload: P): { execId: ExecId<S, E>; entityId: string } => {
    const resolved = resolveId(def.id(payload));
    return { execId: deriveExecId<S, E>(tag, resolved), entityId: resolved.entityId };
  };

  const make = (payload: P): InboxMessage => {
    const { execId } = idOf(payload);
    return { msgId: execId, tag, payload: JSON.stringify(payload) };
  };

  const executionId = (payload: P): ExecId<S, E> => idOf(payload).execId;

  const send = (payload: P): Effect.Effect<ExecId<S, E>, DurableTableError, EncoreConfig> => {
    const { execId, entityId } = idOf(payload);
    return withActor(actorType, entityId, (table) =>
      Effect.as(enqueue(table, make(payload)), execId),
    );
  };

  const peek = (payload: P): Effect.Effect<PeekResult<S, E>, DurableTableError, EncoreConfig> => {
    const { execId, entityId } = idOf(payload);
    return withActor(
      actorType,
      entityId,
      (table) => peekReply(table, execId) as Effect.Effect<PeekResult<S, E>, DurableTableError>,
    );
  };

  const waitFor = (
    payload: P,
  ): Effect.Effect<PeekResult<S, E>, DurableTableError, EncoreConfig> => {
    const { execId, entityId } = idOf(payload);
    return withActor(
      actorType,
      entityId,
      (table) => waitForReply(table, execId) as Effect.Effect<PeekResult<S, E>, DurableTableError>,
    );
  };

  const execute = (payload: P): Effect.Effect<S, E | DurableTableError, EncoreConfig> => {
    const { execId, entityId } = idOf(payload);
    return withActor(actorType, entityId, (table) =>
      Effect.gen(function* () {
        yield* enqueue(table, make(payload));
        const result = (yield* waitForReply(table, execId)) as PeekResult<S, E>;
        if (isSuccess(result)) return result.value;
        if (isFailure(result)) return yield* Effect.fail(result.error);
        if (result._tag === "Defect") return yield* Effect.die(result.cause);
        return yield* Effect.interrupt;
      }),
    );
  };

  return { executionId, send, execute, peek, waitFor, make };
};

// ── Entity actor ─────────────────────────────────────────────────────────

export type EntityActor<Defs extends Record<string, AnyOperationDef>> = {
  readonly name: string;
} & {
  readonly [Tag in keyof Defs & string]: OperationHandle<
    PayloadOf<Defs[Tag]>,
    SuccessOf<Defs[Tag]>,
    ErrorOf<Defs[Tag]>
  >;
} & {
  /**
   * Host this entity: claim the drain for `entityId` and run handlers until
   * interrupted. Activation-based — fork it, interrupt to release.
   */
  readonly activate: <R>(
    entityId: string,
    handlers: {
      readonly [Tag in keyof Defs & string]?: (
        payload: PayloadOf<Defs[Tag]>,
      ) => Effect.Effect<SuccessOf<Defs[Tag]>, ErrorOf<Defs[Tag]>, R>;
    },
    options?: { readonly workerId?: string; readonly epoch?: number },
  ) => Effect.Effect<void, DurableTableError, R | EncoreConfig>;
};

export const fromEntity = <const Defs extends Record<string, AnyOperationDef>>(
  name: string,
  defs: Defs,
): EntityActor<Defs> => {
  const handles: Record<string, OperationHandle<unknown, unknown, unknown>> = {};
  for (const tag of Object.keys(defs)) {
    handles[tag] = makeHandle(name, tag, defs[tag] as OperationDef);
  }

  const activateEntity = <R>(
    entityId: string,
    handlers: Handlers<R>,
    options?: { readonly workerId?: string; readonly epoch?: number },
  ): Effect.Effect<void, DurableTableError, R | EncoreConfig> =>
    withActor(name, entityId, (table: ActorTableService) =>
      activate(table, options?.workerId ?? "worker", handlers, { epoch: options?.epoch ?? 0 }),
    );

  return {
    name,
    ...handles,
    activate: activateEntity,
  } as unknown as EntityActor<Defs>;
};
