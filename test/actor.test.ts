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
  effectTest("actor(id) returns ActorRef with call/cast", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-1");
      expect(ref.call).toBeDefined();
      expect(ref.cast).toBeDefined();
    }),
  );

  effectTest("call dispatches by operation value", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-2");
      const result = yield* ref.call(Counter.Increment({ amount: 5 }));
      expect(result).toBe(6);
    }),
  );

  effectTest("call works for zero-input operations", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-3");
      const result = yield* ref.call(Counter.GetCount());
      expect(result).toBe(42);
    }),
  );

  effectTest("cast returns ExecId string", () =>
    Effect.gen(function* () {
      const ref = yield* Counter.actor("counter-4");
      const execId = yield* ref.cast(Counter.Increment({ amount: 7 }));
      expect(typeof execId).toBe("string");
      expect(String(execId)).toBe("counter-4:Increment:7");
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
