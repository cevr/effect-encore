import { describe, expect, it, test } from "effect-bun-test";
import type { Layer } from "effect";
import { Context, DateTime, Effect, PrimaryKey, Schema } from "effect";
import { ClusterSchema, ShardingConfig } from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const effectTest = it.scopedLive.layer(TestShardingConfig);

const Counter = Actor("Counter", {
  Increment: {
    input: { amount: Schema.Number },
    output: Schema.Number,
  },
  GetCount: {
    output: Schema.Number,
  },
});

const handlerLayer = Counter.handlers({
  Increment: ({ operation }) => Effect.succeed(operation.amount + 1),
  GetCount: () => Effect.succeed(42),
});

describe("Actor()", () => {
  test("defines a multi-operation actor with typed input/output/error schemas", () => {
    expect(Counter.name).toBe("Counter");
    expect(Counter._tag).toBe("ActorObject");
    expect(Counter.entity).toBeDefined();
    expect(Counter.definitions).toBeDefined();
    expect(Object.keys(Counter.definitions)).toEqual(["Increment", "GetCount"]);
  });

  test("compiles operations into Entity under the hood", () => {
    expect(Counter.entity).toBeDefined();
  });

  test("attaches persisted annotation when persisted: true", () => {
    const Persisted = Actor("Persisted", {
      Save: {
        input: { data: Schema.String },
        persisted: true,
      },
    });
    const rpc = Persisted.entity.protocol.requests.get("Save")!;
    const val = Context.get(rpc.annotations, ClusterSchema.Persisted);
    expect(val).toBe(true);
  });

  test("attaches primaryKey extractor from definition", () => {
    const WithPK = Actor("WithPK", {
      Op: {
        input: { id: Schema.String },
        persisted: true,
        primaryKey: (p: { id: string }) => p.id,
      },
    });
    expect(WithPK.definitions["Op"]!.primaryKey).toBeDefined();
    const pk = WithPK.definitions["Op"]!.primaryKey!({ id: "abc" } as never);
    expect(pk).toBe("abc");
  });

  test("operations without explicit persisted: true use cluster default", () => {
    const rpc = Counter.entity.protocol.requests.get("Increment")!;
    const result = Context.getOption(rpc.annotations, ClusterSchema.Persisted);
    expect(Counter.definitions["Increment"]!.persisted).toBeUndefined();
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
});

describe("Actor.client", () => {
  effectTest("returns a function (entityId) => ActorRef with call/cast", () =>
    Effect.gen(function* () {
      const makeRef = yield* Counter.testClient(handlerLayer as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("counter-1");
      expect(ref.call).toBeDefined();
      expect(ref.cast).toBeDefined();
    }),
  );

  effectTest("call dispatches by operation value", () =>
    Effect.gen(function* () {
      const makeRef = yield* Counter.testClient(handlerLayer as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("counter-2");
      const result = yield* ref.call(Counter.Increment({ amount: 5 }));
      expect(result).toBe(6);
    }),
  );

  effectTest("call works for zero-input operations", () =>
    Effect.gen(function* () {
      const makeRef = yield* Counter.testClient(handlerLayer as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("counter-3");
      const result = yield* ref.call(Counter.GetCount());
      expect(result).toBe(42);
    }),
  );
});

describe("deliverAt", () => {
  test("attaches DeliverAt.symbol to payload instances when deliverAt is configured", () => {
    const Delayed = Actor("Delayed", {
      Process: {
        input: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
        persisted: true,
        primaryKey: (p: { id: string }) => p.id,
        deliverAt: (p: { deliverAt: DateTime.DateTime }) => p.deliverAt,
      },
    });

    const rpc = Delayed.entity.protocol.requests.get("Process")!;
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
    const WithPK = Actor("WithPKPayload", {
      Op: {
        input: { id: Schema.String },
        primaryKey: (p: { id: string }) => p.id,
      },
    });

    const rpc = WithPK.entity.protocol.requests.get("Op")!;
    const payloadSchema = rpc.payloadSchema;
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      id: "abc",
    }) as { [PrimaryKey.symbol](): string };

    expect(typeof instance[PrimaryKey.symbol]).toBe("function");
    expect(instance[PrimaryKey.symbol]()).toBe("abc");
  });

  test("payload instances without primaryKey or deliverAt have neither symbol", () => {
    const Plain = Actor("Plain", {
      Op: {
        input: { value: Schema.String },
      },
    });

    const rpc = Plain.entity.protocol.requests.get("Op")!;
    const payloadSchema = rpc.payloadSchema;
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      value: "hello",
    });

    expect(DeliverAt.isDeliverAt(instance)).toBe(false);
    expect(PrimaryKey.symbol in (instance as object)).toBe(false);
  });

  test("deliverAt without primaryKey is valid (delayed but not deduped)", () => {
    const DelayedOnly = Actor("DelayedOnly", {
      Fire: {
        input: { when: Schema.DateTimeUtc },
        persisted: true,
        deliverAt: (p: { when: DateTime.DateTime }) => p.when,
      },
    });

    const rpc = DelayedOnly.entity.protocol.requests.get("Fire")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.makeUnsafe(Date.now());
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      when: now,
    });

    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(PrimaryKey.symbol in (instance as object)).toBe(false);
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

    const WithCustom = Actor("WithCustom", {
      Process: {
        input: CustomPayload,
        output: Schema.String,
        persisted: true,
      },
    });

    const rpc = WithCustom.entity.protocol.requests.get("Process")!;
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

    const Scheduled = Actor("Scheduled", {
      Run: {
        input: ScheduledPayload,
        persisted: true,
      },
    });

    const now = DateTime.makeUnsafe(Date.now());
    const instance = new ScheduledPayload({ id: "s-1", when: now });

    expect(instance[PrimaryKey.symbol]()).toBe("s-1");
    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(now.epochMilliseconds);

    const rpc = Scheduled.entity.protocol.requests.get("Run")!;
    expect(rpc.payloadSchema).toBe(ScheduledPayload);
  });
});
