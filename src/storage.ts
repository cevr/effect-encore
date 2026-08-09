/**
 * EncoreMessageStorage — encore-internal extension of upstream MessageStorage.
 *
 * Adds `deleteEnvelope(requestId)`: surgical removal of a single message
 * envelope (and its replies) by Snowflake id. Required by `<Op>.rerun(payload)`
 * to clear exactly one execId's persisted state without nuking the entire
 * entity address.
 *
 * Adapters provide BOTH tags:
 * - upstream `MessageStorage.MessageStorage` is still required by the runner
 *   (effect-cluster owns it for normal entity routing).
 * - `EncoreMessageStorage` is required by encore actor methods that need
 *   surgical delete (`.rerun`).
 *
 * Use `fromMessageStorage(storage, ext)` to build an `EncoreMessageStorage`
 * value from an upstream storage plus the extension method, or `layer(ext)`
 * to compose an effect Layer providing both tags.
 */
import {
  ClusterError,
  MessageStorage,
  ShardingConfig,
  SqlMessageStorage,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import type { PersistenceError } from "effect/unstable/cluster/ClusterError";
import type * as Snowflake from "effect/unstable/cluster/Snowflake";
import { Context, Effect, Layer } from "effect";
import type * as Crypto from "effect/Crypto";

// ─── Shape ──────────────────────────────────────────────────────────────────

export type EncoreMessageStorageShape = MessageStorage.MessageStorage["Service"] & {
  readonly deleteEnvelope: (
    requestId: Snowflake.Snowflake,
  ) => Effect.Effect<void, PersistenceError>;
};

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

export class EncoreMessageStorage extends Context.Service<
  EncoreMessageStorage,
  EncoreMessageStorageShape
>()("effect-encore/storage/EncoreMessageStorage") {}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build an `EncoreMessageStorage` value from an upstream `MessageStorage`
 * shape plus the encore-specific extension. Adapters use this when their
 * underlying client (Mongo, Redis, in-memory) implements both the upstream
 * methods and `deleteEnvelope`.
 */
export const fromMessageStorage = (
  storage: MessageStorage.MessageStorage["Service"],
  ext: {
    readonly deleteEnvelope: (
      requestId: Snowflake.Snowflake,
    ) => Effect.Effect<void, PersistenceError>;
  },
): EncoreMessageStorageShape => ({
  ...storage,
  deleteEnvelope: ext.deleteEnvelope,
});

/**
 * Layer composer: takes a Layer providing upstream `MessageStorage` and the
 * encore-specific extension, and produces a Layer providing BOTH the upstream
 * tag and `EncoreMessageStorage`.
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
): Layer.Layer<MessageStorage.MessageStorage | EncoreMessageStorage, E, RIn> =>
  Layer.merge(
    upstream,
    Layer.effect(
      EncoreMessageStorage,
      Effect.gen(function* () {
        const storage = yield* MessageStorage.MessageStorage;
        return fromMessageStorage(storage, ext);
      }),
    ).pipe(Layer.provide(upstream)),
  );

export const fromSqlClientWithShardingConfig = (
  options?: SqlMessageStorageOptions,
): Layer.Layer<
  MessageStorage.MessageStorage | EncoreMessageStorage,
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
    EncoreMessageStorage,
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
  MessageStorage.MessageStorage | EncoreMessageStorage,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> => fromSqlClientWithShardingConfig(options).pipe(Layer.provide(ShardingConfig.layerDefaults));
