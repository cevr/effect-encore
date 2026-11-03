import { describe, expect, it } from "effect-bun-test";
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import type { Entity as ClusterEntity } from "effect/cluster";
import { Entity, MessageStorage, ShardingConfig, TestRunner } from "effect/cluster";
import { SqlClient } from "effect/sql";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ActorMailboxService } from "../src/actor-mailbox.js";
import { ActorMailbox, MailboxError } from "../src/actor-mailbox.js";
import { Actor, Client, ClientLayer, fromSqlClient } from "../src/index.js";
import { makeTestMailboxImpl } from "../src/client.js";
import { compileInvocation } from "../src/internal/invocation-compiler.js";

class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

const ClientActor = Actor.fromEntity("ClientLayerActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
  Fail: {
    payload: { input: Schema.String },
    error: ProcessError,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const SchemaPayloadClientActor = Actor.fromEntity("SchemaPayloadClientLayerActor", {
  Process: {
    payload: Schema.Struct({ input: Schema.String }),
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
  Scalar: {
    payload: Schema.String,
    success: Schema.String,
    persisted: true,
    id: (p: string) => p,
  },
});

const LiveOnlyActor = Actor.fromEntity("ClientLayerLiveOnly", {
  Ping: {
    payload: { input: Schema.String },
    success: Schema.String,
    id: (p: { input: string }) => p.input,
  },
});

// eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity name param is invariant
// oxlint-disable-next-line effect/noAs -- the Client transport seam erases the invariant entity name and RPC union
const processEntity = ClientActor._meta.entity as ClusterEntity.Entity<string, any>;
// eslint-disable-next-line typescript-eslint/no-explicit-any
// oxlint-disable-next-line effect/noAs -- the Client transport seam erases the invariant entity name and RPC union
const liveOnlyEntity = LiveOnlyActor._meta.entity as ClusterEntity.Entity<string, any>;
// eslint-disable-next-line typescript-eslint/no-explicit-any -- entity name param is invariant
// oxlint-disable-next-line effect/noAs -- the Client transport seam erases the invariant entity name and RPC union
const schemaPayloadEntity = SchemaPayloadClientActor._meta.entity as ClusterEntity.Entity<
  string,
  any
>;

const processDefs = ClientActor._meta.internalDefinitions ?? ClientActor._meta.definitions;
const liveOnlyDefs = LiveOnlyActor._meta.internalDefinitions ?? LiveOnlyActor._meta.definitions;
const schemaPayloadDefs =
  SchemaPayloadClientActor._meta.internalDefinitions ?? SchemaPayloadClientActor._meta.definitions;

const processInvocation = (input: string) =>
  compileInvocation(processEntity, "Process", processDefs["Process"], { input });
const failInvocation = (input: string) =>
  compileInvocation(processEntity, "Fail", processDefs["Fail"], { input });
const pingInvocation = (input: string) =>
  compileInvocation(liveOnlyEntity, "Ping", liveOnlyDefs["Ping"], { input });
const schemaPayloadInvocation = (input: string) =>
  compileInvocation(schemaPayloadEntity, "Process", schemaPayloadDefs["Process"], { input });
const scalarPayloadInvocation = (input: string) =>
  compileInvocation(schemaPayloadEntity, "Scalar", schemaPayloadDefs["Scalar"], input);

describe("Client.layer.memory", () => {
  it.scopedLive("send mints the frozen 3-tuple ExecId via the wire-builder inside the seam", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const execId = yield* client.send(processInvocation("widget"));
      expect(String(execId)).toBe("widget\x00Process\x00widget");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );

  it.scopedLive("peek is Pending while no consumer has driven a reply terminal", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processInvocation("p1"));
      const result = yield* client.peek(processEntity, "p1\x00Process\x00p1", processDefs);
      expect(result._tag).toBe("Pending");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );

  it.scopedLive("send rejects a non-persisted op loudly (persisted gate)", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const exit = yield* client.send(pingInvocation("hi")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(MailboxError);
        }
      }
    }).pipe(Effect.provide(ClientLayer.memory)),
  );

  it.scopedLive("flush + redeliver run without a consumer (control ops moved inside)", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processInvocation("ctl"));
      yield* client.flush(processEntity, "ctl");
      yield* client.redeliver(processEntity, "ctl");
      const after = yield* client.peek(processEntity, "ctl\x00Process\x00ctl", processDefs);
      expect(after._tag).toBe("Pending");
    }).pipe(Effect.provide(ClientLayer.memory)),
  );
});

const FromConfigStorage = MessageStorage.layerMemory.pipe(
  Layer.provideMerge(ShardingConfig.layer()),
);

const SqlStorage = fromSqlClient().pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(BunCrypto.layer),
);
const SqlClientLayer = ClientLayer.fromConfig.pipe(
  Layer.provideMerge(SqlStorage),
  Layer.provideMerge(ShardingConfig.layer()),
);

describe("Client.layer.fromConfig", () => {
  it.scopedLive("persisted send lands in the explicitly-provided storage", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const storage = yield* MessageStorage.MessageStorage;
      yield* client.send(processInvocation("cfg"));
      const address = client.resolve(processEntity, "cfg");
      const unprocessed = yield* storage.unprocessedMessages([address.shardId]);
      expect(unprocessed.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(ClientLayer.fromConfig.pipe(Layer.provideMerge(FromConfigStorage)))),
  );

  it.scopedLive("public send deduplicates schema payloads in SQL storage", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const sql = yield* SqlClient.SqlClient;
      yield* client.send(schemaPayloadInvocation("sql-public-dup"));
      yield* client.send(schemaPayloadInvocation("sql-public-dup"));
      yield* client.send(scalarPayloadInvocation("sql-scalar-dup"));
      yield* client.send(scalarPayloadInvocation("sql-scalar-dup"));

      const rows = yield* sql<{ readonly count: number | bigint }>`
        SELECT COUNT(*) AS count
        FROM cluster_messages
        WHERE entity_type = ${schemaPayloadEntity.type}
          AND entity_id = ${"sql-public-dup"}
          AND tag = ${"Process"}
      `;
      const scalarRows = yield* sql<{ readonly count: number | bigint }>`
        SELECT COUNT(*) AS count
        FROM cluster_messages
        WHERE entity_type = ${schemaPayloadEntity.type}
          AND entity_id = ${"sql-scalar-dup"}
          AND tag = ${"Scalar"}
      `;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.count)).toBe("1");
      expect(scalarRows).toHaveLength(1);
      expect(String(scalarRows[0]?.count)).toBe("1");
    }).pipe(Effect.provide(SqlClientLayer)),
  );
});

const consumerHandlers = Actor.toLayer(ClientActor, {
  Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  Fail: () => Effect.fail(ProcessError.make({ message: "bad" })),
});

const FromShardingLayer = ClientLayer.fromSharding.pipe(Layer.provideMerge(TestRunner.layer));

const FromShardingWithHandlers = ClientLayer.fromSharding.pipe(
  Layer.provideMerge(consumerHandlers),
  Layer.provideMerge(TestRunner.layer),
);

describe("Client.layer.fromSharding", () => {
  it.scopedLive(
    "Snowflake resolves under fromSharding (no 'Service not found: Snowflake.Generator')",
    () =>
      Effect.gen(function* () {
        const client = yield* Client;
        const execId = yield* client.send(processInvocation("snow"));
        expect(String(execId)).toBe("snow\x00Process\x00snow");
      }).pipe(Effect.provide(FromShardingLayer)),
  );

  it.scopedLive("send → handler processes → peek classifies Success → flush clears", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(processInvocation("e2e"));

      const terminal = yield* Effect.retry(
        Effect.filterOrFail(
          client.peek(processEntity, "e2e\x00Process\x00e2e", processDefs),
          (result) => result._tag === "Success",
          () => "pending",
        ),
        { times: 50 },
      );
      expect(terminal._tag).toBe("Success");
      if (terminal._tag === "Success") {
        expect(terminal.value).toBe("processed: e2e");
      }

      yield* client.flush(processEntity, "e2e");
      const afterFlush = yield* client.peek(processEntity, "e2e\x00Process\x00e2e", processDefs);
      expect(afterFlush._tag).toBe("Pending");
    }).pipe(Effect.provide(FromShardingWithHandlers)),
  );

  it.scopedLive("peek classifies a typed handler Failure from stored replies", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      yield* client.send(failInvocation("nope"));
      const terminal = yield* Effect.retry(
        Effect.filterOrFail(
          client.peek(processEntity, "nope\x00Fail\x00nope", processDefs),
          (result) => result._tag === "Failure",
          () => "pending",
        ),
        { times: 50 },
      );
      expect(terminal._tag).toBe("Failure");
      if (terminal._tag === "Failure") {
        expect(terminal.error).toBeInstanceOf(ProcessError);
      }
    }).pipe(Effect.provide(FromShardingWithHandlers)),
  );
});

const TestShardingConfig = ShardingConfig.layer({ entityTerminationTimeout: 0 });
const ClientActorTest = Layer.provide(
  Actor.toTestLayer(ClientActor, {
    Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
    Fail: () => Effect.fail(ProcessError.make({ message: "bad" })),
  }),
  TestShardingConfig,
);

describe("Actor.toTestLayer (inline test-mailbox composition)", () => {
  const layerTest = it.scopedLive.layer(ClientActorTest);

  layerTest("public .send routes through the inline test mailbox (Client-channeled dispatch)", () =>
    Effect.gen(function* () {
      const execId = yield* ClientActor.Process.send({ input: "tst" });
      expect(String(execId)).toBe("tst\x00Process\x00tst");
    }),
  );
});

// oxlint-disable-next-line effect/noAs -- upstream toLayer erases this test handler map to never
const directHandlerLayer = ClientActor._meta.entity.toLayer({
  Process: ({ payload }: { payload: { input: string } }) =>
    Effect.succeed(`processed: ${payload.input}`),
  Fail: () => Effect.fail(ProcessError.make({ message: "bad" })),
} as never);

const dispatchedRef = Ref.makeUnsafe<ReadonlyArray<{ tag: string; entityId: string }>>([]);

const injectedMailboxLayer = Layer.effectContext(
  Effect.gen(function* () {
    // oxlint-disable-next-line effect/noAs -- upstream makeTestClient returns a type-erased client factory
    const makeClient = (yield* Entity.makeTestClient(
      ClientActor._meta.entity,
      directHandlerLayer,
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- makeTestClient return is type-erased; mirrors actor.ts:1515
    )) as (entityId: string) => Effect.Effect<any>;
    const routing = makeTestMailboxImpl(makeClient);
    const recording: ActorMailboxService = {
      send: (request) =>
        Ref.update(dispatchedRef, (xs) => [
          ...xs,
          {
            tag: String(request.envelope.tag),
            entityId: String(request.envelope.address.entityId),
          },
        ]).pipe(Effect.flatMap(() => routing.send(request))),
    };
    return Context.empty().pipe(Context.add(ActorMailbox, recording));
  }),
);

const directTestClientLayer = ClientLayer.test.pipe(
  Layer.provide(
    Layer.merge(Layer.provide(injectedMailboxLayer, TestShardingConfig), TestShardingConfig),
  ),
);

describe("Client.layer.test (exported adapter, driven directly)", () => {
  const layerTest = it.scopedLive.layer(directTestClientLayer);

  layerTest(
    "send routes through the INJECTED mailbox; send→peek is Pending (reply discarded); flush/redeliver run on its storage",
    () =>
      Effect.gen(function* () {
        const client = yield* Client;
        yield* Ref.set(dispatchedRef, []);

        const execId = yield* client.send(processInvocation("adapter"));
        expect(String(execId)).toBe("adapter\x00Process\x00adapter");

        const dispatched = yield* Ref.get(dispatchedRef);
        expect(dispatched).toEqual([{ tag: "Process", entityId: "adapter" }]);

        const afterSend = yield* client.peek(
          processEntity,
          "adapter\x00Process\x00adapter",
          processDefs,
        );
        expect(afterSend._tag).toBe("Pending");

        yield* client.flush(processEntity, "adapter");
        yield* client.redeliver(processEntity, "adapter");
        const after = yield* client.peek(
          processEntity,
          "adapter\x00Process\x00adapter",
          processDefs,
        );
        expect(after._tag).toBe("Pending");
      }),
  );
});
