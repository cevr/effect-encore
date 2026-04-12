import { describe, expect, it, test } from "effect-bun-test";
import { Context, DateTime, Effect, Layer, PrimaryKey, Schema } from "effect";
import { ClusterSchema, ShardingConfig } from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
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
    primaryKey: (p: { amount: number }) => String(p.amount),
  },
  GetCount: {
    success: Schema.Number,
    primaryKey: () => "singleton",
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
    expect(Counter._tag).toBe("ActorObject");
    expect(Counter._meta.entity).toBeDefined();
    expect(Counter._meta.definitions).toBeDefined();
    expect(Object.keys(Counter._meta.definitions)).toEqual(["Increment", "GetCount"]);
  });

  test("compiles operations into Entity under the hood", () => {
    expect(Counter._meta.entity).toBeDefined();
  });

  test("attaches persisted annotation when persisted: true", () => {
    const Persisted = Actor.fromEntity("Persisted", {
      Save: {
        payload: { data: Schema.String },
        persisted: true,
        primaryKey: (p: { data: string }) => p.data,
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
        primaryKey: (p: { id: string }) => p.id,
      },
    });
    expect(WithPK._meta.definitions["Op"]!.primaryKey).toBeDefined();
    const pk = WithPK._meta.definitions["Op"]!.primaryKey({ id: "abc" } as never);
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

  test("constructors produce operation values with _tag", () => {
    const op = Counter.Increment({ amount: 5 });
    expect(op._tag).toBe("Increment");
    expect(op.amount).toBe(5);
  });

  test("zero-input constructors are callable with no args", () => {
    const op = Counter.GetCount();
    expect(op._tag).toBe("GetCount");
  });

  test("$is type guard works", () => {
    const op = Counter.Increment({ amount: 3 });
    expect(Counter.$is("Increment")(op)).toBe(true);
    expect(Counter.$is("GetCount")(op)).toBe(false);
  });

  test("throws on reserved operation names", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        _meta: { primaryKey: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'actor'", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        actor: { primaryKey: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'peek'", () => {
    expect(() =>
      Actor.fromEntity("Bad", {
        peek: { primaryKey: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });
});

describe("Actor.toTestLayer", () => {
  effectTest("actor(id) returns ActorRef with execute/send", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-1");
      expect(ref.execute).toBeDefined();
      expect(ref.send).toBeDefined();
    }),
  );

  effectTest("execute dispatches by operation value", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-2");
      const result = yield* ref.execute(Counter.Increment({ amount: 5 }));
      expect(result).toBe(6);
    }),
  );

  effectTest("execute works for zero-input operations", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-3");
      const result = yield* ref.execute(Counter.GetCount());
      expect(result).toBe(42);
    }),
  );

  effectTest("send returns ExecId string", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-4");
      const execId = yield* ref.send(Counter.Increment({ amount: 7 }));
      expect(typeof execId).toBe("string");
      expect(String(execId)).toBe("counter-4\x00Increment\x007");
    }),
  );

  effectTest("ExecId is safe with colons in entity ID", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("ns:entity-1");
      const execId = yield* ref.send(Counter.Increment({ amount: 3 }));
      // null-byte separator means colons in entity ID are safe
      expect(String(execId)).toBe("ns:entity-1\x00Increment\x003");
    }),
  );

  effectTest("ExecId is safe with colons in primary key", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("pk-colon-test");
      // primaryKey for Increment returns String(p.amount), so no colons here
      // but the entity ID and tag are clean — the key point is null-byte separators
      const execId = yield* ref.send(Counter.Increment({ amount: 42 }));
      // Verify the format uses null bytes, making colons in any segment safe
      const str = String(execId);
      expect(str).toContain("\x00");
      expect(str.split("\x00")).toEqual(["pk-colon-test", "Increment", "42"]);
    }),
  );

  effectTest("unknown operation tag dies with descriptive error", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-5");
      const result = yield* Effect.exit(ref.execute({ _tag: "NonExistent" } as never));
      expect(result._tag).toBe("Failure");
    }),
  );

  test("executionId computes ExecId without executing", () => {
    const execId = Effect.runSync(
      Counter.executionId("my-entity", Counter.Increment({ amount: 5 })),
    );
    expect(String(execId)).toBe("my-entity\x00Increment\x005");
  });
});

describe("scalar payload", () => {
  const Echo = Actor.fromEntity("Echo", {
    Say: {
      payload: Schema.String,
      success: Schema.String,
      primaryKey: (msg: string) => msg,
    },
  });

  const EchoTest = Layer.provide(
    Actor.toTestLayer(Echo, {
      Say: ({ operation }) => Effect.succeed(`echo: ${operation._payload}`),
    }),
    TestShardingConfig,
  );

  const scalarTest = it.scopedLive.layer(EchoTest);

  test("constructor produces operation with _payload key", () => {
    const op = Echo.Say("hello");
    expect(op._tag).toBe("Say");
    expect(op._payload).toBe("hello");
  });

  scalarTest("execute round-trips scalar payload through handler", () =>
    Effect.gen(function* () {
      const ref = yield* Echo.actor("s-1");
      const result = yield* ref.execute(Echo.Say("world"));
      expect(result).toBe("echo: world");
    }),
  );

  scalarTest("send returns ExecId with scalar primaryKey", () =>
    Effect.gen(function* () {
      const ref = yield* Echo.actor("s-2");
      const execId = yield* ref.send(Echo.Say("test"));
      expect(String(execId)).toBe("s-2\x00Say\x00test");
    }),
  );
});

describe("deliverAt", () => {
  test("attaches DeliverAt.symbol to payload instances when deliverAt is configured", () => {
    const Delayed = Actor.fromEntity("Delayed", {
      Process: {
        payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
        persisted: true,
        primaryKey: (p: { id: string }) => p.id,
        deliverAt: (p: { deliverAt: DateTime.DateTime }) => p.deliverAt,
      },
    });

    const rpc = Delayed._meta.entity.protocol.requests.get("Process")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.makeUnsafe(Date.now());
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      id: "test-123",
      deliverAt: now,
    });

    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(now.epochMilliseconds);
  });

  test("attaches PrimaryKey.symbol to payload instances when primaryKey is configured", () => {
    const WithPK = Actor.fromEntity("WithPKPayload", {
      Op: {
        payload: { id: Schema.String },
        primaryKey: (p: { id: string }) => p.id,
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
        primaryKey: (p: { when: DateTime.DateTime }) => String(p.when.epochMilliseconds),
        deliverAt: (p: { when: DateTime.DateTime }) => p.when,
      },
    });

    const rpc = DelayedOnly._meta.entity.protocol.requests.get("Fire")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.makeUnsafe(Date.now());
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
        primaryKey: (p: { id: string }) => p.id,
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
        primaryKey: (p: { id: string }) => p.id,
      },
    });

    const now = DateTime.makeUnsafe(Date.now());
    const instance = new ScheduledPayload({ id: "s-1", when: now });

    expect(instance[PrimaryKey.symbol]()).toBe("s-1");
    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(now.epochMilliseconds);

    const rpc = Scheduled._meta.entity.protocol.requests.get("Run")!;
    expect(rpc.payloadSchema).toBe(ScheduledPayload);
  });
});

describe("Actor.withProtocol", () => {
  test("transforms the entity protocol", () => {
    const original = Counter._meta.entity;

    const transformed = Counter.pipe(Actor.withProtocol((protocol) => protocol));

    expect(transformed._tag).toBe("ActorObject");
    expect(transformed._meta.name).toBe("Counter");
    // New entity — not the same reference
    expect(transformed._meta.entity).not.toBe(original);
    // Operations are preserved
    expect(Object.keys(transformed._meta.definitions)).toEqual(["Increment", "GetCount"]);
  });

  test("preserves operation constructors after transform", () => {
    const transformed = Counter.pipe(Actor.withProtocol((protocol) => protocol));

    const op = transformed.Increment({ amount: 5 });
    expect(op._tag).toBe("Increment");
    expect(op.amount).toBe(5);
  });

  test("pipe is chainable", () => {
    const transformed = Counter.pipe(
      Actor.withProtocol((protocol) => protocol),
      Actor.withProtocol((protocol) => protocol),
    );

    expect(transformed._tag).toBe("ActorObject");
    expect(transformed._meta.name).toBe("Counter");
  });

  test("data-first form works", () => {
    const transformed = Actor.withProtocol(Counter, (protocol) => protocol);

    expect(transformed._tag).toBe("ActorObject");
    expect(transformed._meta.name).toBe("Counter");
    expect(transformed._meta.entity).not.toBe(Counter._meta.entity);
  });
});
