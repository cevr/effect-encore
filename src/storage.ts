/**
 * MessageDeletion owns the deletion operations that Effect does not provide.
 *
 * Effect owns normal message storage. Encore only resolves and deletes one
 * invocation or one address for rerun operations.
 *
 * Adapters provide BOTH tags:
 * - upstream `MessageStorage.MessageStorage` is still required by the runner
 *   (effect-cluster owns it for normal entity routing).
 * - internal `MessageDeletion` is required by Encore rerun methods.
 *
 * Use `fromMessageStorage(storage, ext)` to build the deletion service.
 * Use `layer(upstream, ext)` to provide both services.
 */
import {
  ClusterError,
  MessageStorage,
  ShardingConfig,
  SqlMessageStorage,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import type { PersistenceError } from "effect/unstable/cluster/ClusterError";
import type { EntityAddress } from "effect/unstable/cluster";
import type * as Snowflake from "effect/unstable/cluster/Snowflake";
import { Context, Effect, Layer } from "effect";
import type * as Crypto from "effect/Crypto";

// ─── Shape ──────────────────────────────────────────────────────────────────

export interface MessageDeletionShape {
  readonly deleteInvocation: (input: {
    readonly address: EntityAddress.EntityAddress;
    readonly tag: string;
    readonly primaryKey: string;
  }) => Effect.Effect<void, PersistenceError>;
  readonly deleteAddress: (
    address: EntityAddress.EntityAddress,
  ) => Effect.Effect<void, PersistenceError>;
}

export interface SqlMessageStorageOptions {
  readonly prefix?: string;
}

const defaultSqlPrefix = "cluster";

const sqlTables = (options?: SqlMessageStorageOptions) => {
  const prefix = options?.prefix ?? defaultSqlPrefix;
  return {
    messages: `${prefix}_messages`,
    replies: `${prefix}_replies`,
  };
};

// ─── Tag ────────────────────────────────────────────────────────────────────

export class MessageDeletion extends Context.Service<MessageDeletion, MessageDeletionShape>()(
  "effect-encore/storage/MessageDeletion",
) {}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build deletion operations from Effect storage and one adapter method.
 */
export const fromMessageStorage = (
  storage: MessageStorage.MessageStorage["Service"],
  ext: {
    readonly deleteEnvelope: (
      requestId: Snowflake.Snowflake,
    ) => Effect.Effect<void, PersistenceError>;
  },
): MessageDeletionShape => ({
  deleteInvocation: ({ address, tag, primaryKey }) =>
    Effect.gen(function* () {
      const requestId = yield* storage.requestIdForPrimaryKey({ address, tag, id: primaryKey });
      if (requestId._tag === "None") return;
      yield* ext.deleteEnvelope(requestId.value);
    }),
  deleteAddress: storage.clearAddress,
});

/**
 * Layer composer: takes a Layer providing upstream `MessageStorage` and the
 * encore-specific extension, and produces a Layer providing BOTH the upstream
 * tag and the internal deletion service.
 *
 * Adapters that haven't implemented `deleteEnvelope` should pass an `ext`
 * that fails loud (e.g. `Effect.die("not implemented")`) rather than silently
 * coarsening to `flush` — the goal is to surface unimplemented capability
 * immediately, not paper over it.
 */
export const layer = <RIn, E>(
  upstream: Layer.Layer<MessageStorage.MessageStorage, E, RIn>,
  ext: {
    readonly deleteEnvelope: (
      requestId: Snowflake.Snowflake,
    ) => Effect.Effect<void, PersistenceError>;
  },
): Layer.Layer<MessageStorage.MessageStorage | MessageDeletion, E, RIn> =>
  Layer.merge(
    upstream,
    Layer.effect(
      MessageDeletion,
      Effect.gen(function* () {
        const storage = yield* MessageStorage.MessageStorage;
        return fromMessageStorage(storage, ext);
      }),
    ).pipe(Layer.provide(upstream)),
  );

export const fromSqlClientWithShardingConfig = (
  options?: SqlMessageStorageOptions,
): Layer.Layer<
  MessageStorage.MessageStorage | MessageDeletion,
  never,
  SqlClient.SqlClient | ShardingConfig.ShardingConfig | Crypto.Crypto
> => {
  const tables = sqlTables(options);
  const upstream: Layer.Layer<
    MessageStorage.MessageStorage,
    never,
    SqlClient.SqlClient | ShardingConfig.ShardingConfig | Crypto.Crypto
  > = SqlMessageStorage.layer;
  const encore = Layer.effect(
    MessageDeletion,
    Effect.gen(function* () {
      const storage = yield* MessageStorage.MessageStorage;
      const sql = yield* SqlClient.SqlClient;
      return fromMessageStorage(storage, {
        deleteEnvelope: (requestId) => {
          const id = String(requestId);
          return sql`DELETE FROM ${sql(tables.replies)} WHERE request_id = ${id}`.pipe(
            Effect.andThen(sql`DELETE FROM ${sql(tables.messages)} WHERE request_id = ${id}`),
            sql.withTransaction,
            Effect.asVoid,
            (effect) => ClusterError.PersistenceError.refail(effect),
          );
        },
      });
    }),
  );
  return Layer.merge(upstream, encore.pipe(Layer.provide(upstream)));
};

export const fromSqlClient = (
  options?: SqlMessageStorageOptions,
): Layer.Layer<
  MessageStorage.MessageStorage | MessageDeletion,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> => fromSqlClientWithShardingConfig(options).pipe(Layer.provide(ShardingConfig.layerDefaults));
