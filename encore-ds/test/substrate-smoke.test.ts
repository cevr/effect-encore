import { DurableStreamTestServer } from "@durable-streams/server";
import { Effect, Schema, type Scope } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DurableTable } from "../vendor/durable-operators/index.ts";

// Bare-minimum substrate check: one collection, one insertOrGet, one get.
// Isolates the vendored DurableTable + durable-streams client + server from any
// encore-ds layering. Mirrors firegrid's own durable-table.test.ts pattern.

let server: DurableStreamTestServer;
let baseUrl: string;

beforeAll(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" });
  baseUrl = await server.start();
});
afterAll(async () => {
  if (server !== undefined) await server.stop();
});

const Table = DurableTable("smoke", {
  rows: Schema.Struct({
    id: DurableTable.primaryKey(Schema.String),
    value: Schema.Number,
  }),
});

const run = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(eff));

it("substrate: insertOrGet then get round-trips on one stream", async () => {
  const url = `${baseUrl}/v1/stream/smoke-${crypto.randomUUID()}`;
  const out = await run(
    Effect.gen(function* () {
      const t = yield* Table;
      const ins = yield* t.rows.insertOrGet({ id: "a", value: 1 });
      const dup = yield* t.rows.insertOrGet({ id: "a", value: 1 });
      const got = yield* t.rows.get("a");
      return { insTag: ins._tag, dupTag: dup._tag, got };
    }).pipe(
      Effect.provide(Table.layer({ streamOptions: { url, contentType: "application/json" } })),
    ),
  );
  expect(out.insTag).toBe("Inserted");
  expect(out.dupTag).toBe("Found");
  expect(out.got._tag).toBe("Some");
});
