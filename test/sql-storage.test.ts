import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Snowflake } from "effect/unstable/cluster";
import { EncoreMessageStorage, fromSqlClient } from "../src/index.js";

const layer = fromSqlClient().pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);
const test = it.live.layer(layer);

describe("SQL EncoreMessageStorage", () => {
  test("deleteEnvelope removes one request and its replies", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* EncoreMessageStorage;

      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, payload, request_id, processed)
          VALUES
          (${"100"}, ${"req-100"}, ${"shard-1"}, ${"Actor"}, ${"a"}, ${0}, ${"Run"}, ${"{}"}, ${"100"}, ${false})
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

      yield* storage.deleteEnvelope(Snowflake.Snowflake("100"));

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
