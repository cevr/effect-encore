import { ClusterError, MessageStorage, ShardingConfig, SqlMessageStorage } from "effect/cluster";
import { SqlClient } from "effect/sql";
import type { PersistenceError } from "effect/cluster/ClusterError";
import type { EntityAddress } from "effect/cluster";
import type * as Snowflake from "effect/cluster/Snowflake";
import { Context, Effect, Layer } from "effect";
import type { Digest } from "effect/crypto";

export interface MessageDeletionService {
  readonly deleteInvocation: (input: {
    readonly address: EntityAddress.EntityAddress;
    readonly tag: string;
    readonly primaryKey: string;
  }) => Effect.Effect<void, PersistenceError>;
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

export class MessageDeletion extends Context.Service<MessageDeletion, MessageDeletionService>()(
  "effect-encore/storage/MessageDeletion",
) {}

export const fromMessageStorage = (
  storage: MessageStorage.MessageStorage["Service"],
  ext: {
    readonly deleteEnvelope: (
      requestId: Snowflake.Snowflake,
    ) => Effect.Effect<void, PersistenceError>;
  },
): MessageDeletionService => ({
  deleteInvocation: ({ address, tag, primaryKey }) =>
    Effect.gen(function* () {
      const requestId = yield* storage.requestIdForPrimaryKey({ address, tag, id: primaryKey });
      if (requestId._tag === "None") return;
      yield* ext.deleteEnvelope(requestId.value);
    }),
});

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
  SqlClient.SqlClient | ShardingConfig.ShardingConfig | Digest.Digest
> => {
  const tables = sqlTables(options);
  const upstream: Layer.Layer<
    MessageStorage.MessageStorage,
    never,
    SqlClient.SqlClient | ShardingConfig.ShardingConfig | Digest.Digest
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
  SqlClient.SqlClient | Digest.Digest
> => fromSqlClientWithShardingConfig(options).pipe(Layer.provide(ShardingConfig.layerDefaults));
