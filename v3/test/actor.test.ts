import { describe, expect, it, test } from "effect-bun-test/v3";
import { Context, DateTime, Effect, Layer, PrimaryKey, Schema } from "effect";
import { ClusterSchema, ShardingConfig } from "@effect/cluster";
import * as DeliverAt from "@effect/cluster/DeliverAt";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Counter = Actor.fromEntity("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
    id: (p: { amount: number }) => String(p.amount),
  },
  GetCount: {
    success: Schema.Number,
    id: () => "singleton",
  },
});

const CounterTest = Layer.provide(
  Actor.toTestLayer(Counter, {
    Increment: ({ operation }) => Effect.succeed(operation.amount + 1),
    GetCount: () => Effect.succeed(42),
  }),
  TestShardingConfig,
);

const effectTest = it.scopedLive.layer(CounterTest);

describe("Actor.fromEntity", () => {
  test("defines a multi-operation actor with typed input/output/error schemas", () => {
    expect(Counter._meta.name).toBe("Counter");
    expect(Counter._tag).toBe("EntityActor");
    expect(Counter.name).toBe("Counter");
    expect(Counter.type).toBe("Counter");
    expect(Counter._meta.entity).toBeDefined();
    expect(Counter._meta.definitions).toBeDefined();
    expect(Object.keys(Counter._meta.definitions)).toEqual(["Increment", "GetCount"]);
  });

  test("compiles operations into Entity under the hood", () => {
    expect(Counter._meta.entity).toBeDefined();
  });

  test("Actor.isEntity returns true for entity actors", () => {
    expect(Actor.isEntity(Counter)).toBe(true);
    expect(Actor.isWorkflow(Counter)).toBe(false);
  });

  test("attaches persisted annotation when persisted: true", () => {
    const Persisted = Actor.fromEntity("Persisted", {
      Save: {
        payload: { data: Schema.String },
        persisted: true,
        id: (p: { data: string }) => p.data,
      },
    });
    const rpc = Persisted._meta.entity.protocol.requests.get("Save")!;
    const val = Context.get(rpc.annotations, ClusterSchema.Persisted);
    expect(val).toBe(true);
  });

  test("attaches primaryKey extractor from definition", () => {
    const WithPK = Actor.fromEntity("WithPK", {
      Op: {
        payload: { id: Schema.String },
        persisted: true,
        id: (p: { id: string }) => p.id,
      },
    });
    expect(WithPK._meta.definitions["Op"]!.id).toBeDefined();
    const pk = WithPK._meta.definitions["Op"]!.id({ id: "abc" } as never);
    expect(pk).toBe("abc");
  });

  test("operations without explicit persisted: true use cluster default", () => {
    const rpc = Counter._meta.entity.protocol.requests.get("Increment")!;
    const result = Context.getOption(rpc.annotations, ClusterSchema.Persisted);
    expect(
      (Counter._meta.definitions["Increment"] as Record<string, unknown>)["persisted"],
    ).toBeUndefined();
    expect(result._tag).toBe("Some");
  });

  test("operation handles expose make() to produce operation values with _tag", () => {
    const op = Counter.Increment.make({ amount: 5 });
    expect(op._tag).toBe("Increment");
    expect((op as unknown as { amount: number }).amount).toBe(5);
  });

  test("zero-input handles allow make() with no args", () => {
    const op = Counter.GetCount.make(undefined as never);
    expect(op._tag).toBe("GetCount");
  });

  test("$is type guard works on values produced by make()", () => {
    const op = Counter.Increment.make({ amount: 3 });
    expect(Counter.$is("Increment")(op)).toBe(true);
    expect(Counter.$is("GetCount")(op)).toBe(false);
  });

  test("each operation handle is tagged OperationHandle", () => {
    expect(Counter.Increment._tag).toBe("OperationHandle");
    expect(Counter.GetCount._tag).toBe("OperationHandle");
    expect(Counter.Increment.name).toBe("Increment");
    expect(Counter.GetCount.name).toBe("GetCount");
  });

  test("throws on reserved operation names", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        _meta: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'interrupt'", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        interrupt: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'flush'", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        flush: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'redeliver'", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        redeliver: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("every non-handle property on ActorObject is in RESERVED_KEYS", () => {
    const operationNames = new Set(Object.keys(Counter._meta.definitions));
    const allKeys = Object.keys(Counter);
    const infrastructureKeys = allKeys.filter((k) => !operationNames.has(k));

    // Every infrastructure key should be blocked by the reserved check
    for (const key of infrastructureKeys) {
      expect(() =>
        Actor.fromEntity("ReservedCheck", {
          [key]: { id: () => "x" },
        } as never),
      ).toThrow(/collides with reserved/);
    }
  });
});

describe("OperationHandle dispatch via toTestLayer", () => {
  effectTest("execute(payload) dispatches by tag and resolves handler result", () =>
    Effect.gen(function* () {
      const result = yield* Counter.Increment.execute({ amount: 5 });
      expect(result).toBe(6);
    }),
  );

  effectTest("execute works for zero-input operations", () =>
    Effect.gen(function* () {
      const result = yield* Counter.GetCount.execute(undefined as never);
      expect(result).toBe(42);
    }),
  );

  effectTest("send(payload) returns ExecId encoding entityId/tag/primaryKey", () =>
    Effect.gen(function* () {
      const execId = yield* Counter.Increment.send({ amount: 7 });
      expect(typeof execId).toBe("string");
      // entityId === primaryKey === String(amount) === "7"
      expect(String(execId)).toBe("7\x00Increment\x007");
    }),
  );

  effectTest("ExecId uses null-byte separator (colons in segments are safe)", () =>
    Effect.gen(function* () {
      const NsCounter = Actor.fromEntity("NsCounter", {
        Bump: {
          payload: { ns: Schema.String, amount: Schema.Number },
          success: Schema.Number,
          id: (p: { ns: string; amount: number }) => ({
            entityId: `ns:${p.ns}`,
            primaryKey: String(p.amount),
          }),
        },
      });
      const NsTest = Layer.provide(
        Actor.toTestLayer(NsCounter, {
          Bump: ({ operation }) => Effect.succeed(operation.amount + 1),
        }),
        TestShardingConfig,
      );

      yield* Effect.gen(function* () {
        const execId = yield* NsCounter.Bump.send({ ns: "tenant-1", amount: 3 });
        expect(String(execId)).toBe("ns:tenant-1\x00Bump\x003");
        const str = String(execId);
        expect(str).toContain("\x00");
        expect(str.split("\x00")).toEqual(["ns:tenant-1", "Bump", "3"]);
      }).pipe(Effect.provide(NsTest));
    }),
  );

  test("executionId(payload) computes ExecId without dispatching", () => {
    const execId = Effect.runSync(Counter.Increment.executionId({ amount: 5 }));
    expect(String(execId)).toBe("5\x00Increment\x005");
  });
});

describe("scalar payload", () => {
  const Echo = Actor.fromEntity("Echo", {
    Say: {
      payload: Schema.String,
      success: Schema.String,
      id: (msg: string) => msg,
    },
  });

  const EchoTest = Layer.provide(
    Actor.toTestLayer(Echo, {
      Say: ({ operation }) => Effect.succeed(`echo: ${operation._payload}`),
    }),
    TestShardingConfig,
  );

  const scalarTest = it.scopedLive.layer(EchoTest);

  test("make() produces operation value with _payload key for scalar payload", () => {
    const op = Echo.Say.make("hello");
    expect(op._tag).toBe("Say");
    expect((op as unknown as { _payload: string })._payload).toBe("hello");
  });

  scalarTest("execute round-trips scalar payload through handler", () =>
    Effect.gen(function* () {
      const result = yield* Echo.Say.execute("world");
      expect(result).toBe("echo: world");
    }),
  );

  scalarTest("send returns ExecId with scalar primaryKey", () =>
    Effect.gen(function* () {
      const execId = yield* Echo.Say.send("test");
      expect(String(execId)).toBe("test\x00Say\x00test");
    }),
  );
});

describe("deliverAt", () => {
  test("attaches DeliverAt.symbol to payload instances when deliverAt is configured", () => {
    const Delayed = Actor.fromEntity("Delayed", {
      Process: {
        payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
        persisted: true,
        id: (p: { id: string }) => p.id,
        deliverAt: (p: { deliverAt: DateTime.DateTime }) => p.deliverAt,
      },
    });

    const rpc = Delayed._meta.entity.protocol.requests.get("Process")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.unsafeMake(Date.now());
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      id: "test-123",
      deliverAt: now,
    });

    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(DateTime.toEpochMillis(now));
  });

  test("attaches PrimaryKey.symbol to payload instances when primaryKey is configured", () => {
    const WithPK = Actor.fromEntity("WithPKPayload", {
      Op: {
        payload: { id: Schema.String },
        id: (p: { id: string }) => p.id,
      },
    });

    const rpc = WithPK._meta.entity.protocol.requests.get("Op")!;
    const payloadSchema = rpc.payloadSchema;
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      id: "abc",
    }) as { [PrimaryKey.symbol](): string };

    expect(typeof instance[PrimaryKey.symbol]).toBe("function");
    expect(instance[PrimaryKey.symbol]()).toBe("abc");
  });

  test("deliverAt without payload primaryKey symbol is valid (delayed but uses fn primaryKey)", () => {
    const DelayedOnly = Actor.fromEntity("DelayedOnly", {
      Fire: {
        payload: { when: Schema.DateTimeUtc },
        persisted: true,
        id: (p: { when: DateTime.DateTime }) => String(DateTime.toEpochMillis(p.when)),
        deliverAt: (p: { when: DateTime.DateTime }) => p.when,
      },
    });

    const rpc = DelayedOnly._meta.entity.protocol.requests.get("Fire")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.unsafeMake(Date.now());
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      when: now,
    });

    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
  });

  test("accepts pre-built Schema.Class as input — uses it directly", () => {
    class CustomPayload extends Schema.Class<CustomPayload>("test/CustomPayload")({
      id: Schema.String,
      value: Schema.Number,
    }) {
      [PrimaryKey.symbol](): string {
        return this.id;
      }
    }

    const WithCustom = Actor.fromEntity("WithCustom", {
      Process: {
        payload: CustomPayload,
        success: Schema.String,
        persisted: true,
        id: (p: { id: string }) => p.id,
      },
    });

    const rpc = WithCustom._meta.entity.protocol.requests.get("Process")!;
    const instance = new CustomPayload({ id: "xyz", value: 42 });

    expect(instance[PrimaryKey.symbol]()).toBe("xyz");
    expect(rpc.payloadSchema).toBe(CustomPayload);
  });

  test("pre-built Schema.Class with DeliverAt works", () => {
    class ScheduledPayload extends Schema.Class<ScheduledPayload>("test/ScheduledPayload")({
      id: Schema.String,
      when: Schema.DateTimeUtc,
    }) {
      [PrimaryKey.symbol](): string {
        return this.id;
      }
      [DeliverAt.symbol](): DateTime.DateTime {
        return this.when;
      }
    }

    const Scheduled = Actor.fromEntity("Scheduled", {
      Run: {
        payload: ScheduledPayload,
        persisted: true,
        id: (p: { id: string }) => p.id,
      },
    });

    const now = DateTime.unsafeMake(Date.now());
    const instance = new ScheduledPayload({ id: "s-1", when: now });

    expect(instance[PrimaryKey.symbol]()).toBe("s-1");
    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(DateTime.toEpochMillis(now));

    const rpc = Scheduled._meta.entity.protocol.requests.get("Run")!;
    expect(rpc.payloadSchema).toBe(ScheduledPayload);
  });
});

describe("Actor.withProtocol", () => {
  test("transforms the entity protocol", () => {
    const original = Counter._meta.entity;

    const transformed = Counter.pipe(Actor.withProtocol((protocol) => protocol));

    expect(transformed._tag).toBe("EntityActor");
    expect(transformed._meta.name).toBe("Counter");
    // New entity — not the same reference
    expect(transformed._meta.entity).not.toBe(original);
    // Operations are preserved
    expect(Object.keys(transformed._meta.definitions)).toEqual(["Increment", "GetCount"]);
  });

  test("preserves operation handles after transform", () => {
    const transformed = Counter.pipe(Actor.withProtocol((protocol) => protocol));

    expect(transformed.Increment._tag).toBe("OperationHandle");
    const op = transformed.Increment.make({ amount: 5 });
    expect(op._tag).toBe("Increment");
    expect((op as unknown as { amount: number }).amount).toBe(5);
  });

  test("pipe is chainable", () => {
    const transformed = Counter.pipe(
      Actor.withProtocol((protocol) => protocol),
      Actor.withProtocol((protocol) => protocol),
    );

    expect(transformed._tag).toBe("EntityActor");
    expect(transformed._meta.name).toBe("Counter");
  });

  test("data-first form works", () => {
    const transformed = Actor.withProtocol(Counter, (protocol) => protocol);

    expect(transformed._tag).toBe("EntityActor");
    expect(transformed._meta.name).toBe("Counter");
    expect(transformed._meta.entity).not.toBe(Counter._meta.entity);
  });
});
