import { SqliteClient } from "@effect/sql-sqlite-bun";
import { BunCrypto } from "@effect/platform-bun";
import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  EntityAddress,
  EntityId,
  EntityType,
  Envelope,
  ShardId,
  ShardingConfig,
} from "effect/unstable/cluster";
import { Client, ClientLayer, fromSqlClient } from "../src/index.js";
import { MessageDeletion } from "../src/storage.js";

const layer = fromSqlClient().pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(BunCrypto.layer),
);
const test = it.live.layer(layer);
const clientTest = it.live.layer(
  ClientLayer.fromConfig.pipe(Layer.provideMerge([layer, ShardingConfig.layer()])),
);

describe("SQL message deletion", () => {
  test("deleteInvocation removes one request and its replies", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const deletion = yield* MessageDeletion;
      const address = EntityAddress.make({
        entityType: EntityType.make("Actor"),
        entityId: EntityId.make("a"),
        shardId: ShardId.make("default", 1),
      });
      const messageId = Envelope.primaryKeyByAddress({
        address,
        tag: "Run",
        id: "operation-100",
      });

      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, payload, request_id, processed)
          VALUES
          (${"100"}, ${messageId}, ${"shard-1"}, ${"Actor"}, ${"a"}, ${0}, ${"Run"}, ${"{}"}, ${"100"}, ${false})
      `;
      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, request_id, processed)
          VALUES
          (${"101"}, ${"ack-101"}, ${"shard-1"}, ${"Actor"}, ${"a"}, ${1}, ${null}, ${"100"}, ${false})
      `;
      yield* sql`
        INSERT INTO cluster_replies
          (id, kind, request_id, payload, sequence, acked)
          VALUES
          (${"500"}, ${0}, ${"100"}, ${"{}"}, ${0}, ${false})
      `;
      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, payload, request_id, processed)
          VALUES
          (${"200"}, ${"req-200"}, ${"shard-1"}, ${"Actor"}, ${"b"}, ${0}, ${"Run"}, ${"{}"}, ${"200"}, ${false})
      `;
      yield* sql`
        INSERT INTO cluster_replies
          (id, kind, request_id, payload, sequence, acked)
          VALUES
          (${"600"}, ${0}, ${"200"}, ${"{}"}, ${0}, ${false})
      `;

      yield* deletion.deleteInvocation({
        address,
        tag: "Run",
        primaryKey: "operation-100",
      });

      const remainingMessages = yield* sql<{ readonly id: string }>`
        SELECT id FROM cluster_messages ORDER BY id
      `;
      const remainingReplies = yield* sql<{ readonly id: string }>`
        SELECT id FROM cluster_replies ORDER BY id
      `;

      expect(remainingMessages.map((row) => String(row.id))).toEqual(["200"]);
      expect(remainingReplies.map((row) => String(row.id))).toEqual(["600"]);
    }));
});

describe("Client.withTransaction", () => {
  clientTest("rolls back host SQL work through the selected storage adapter", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE transaction_probe (value INTEGER NOT NULL)`;

      yield* client
        .withTransaction(
          sql`INSERT INTO transaction_probe (value) VALUES (42)`.pipe(
            Effect.andThen(Effect.fail("rollback")),
          ),
        )
        .pipe(Effect.flip);

      const rows = yield* sql`SELECT value FROM transaction_probe`;
      expect(rows).toEqual([]);
    }),
  );
});
