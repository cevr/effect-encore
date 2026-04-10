import { describe, expect, it, test } from "effect-bun-test";
import type { Layer } from "effect";
import { Context, DateTime, Effect, PrimaryKey, Schema } from "effect";
import { ClusterSchema, ShardingConfig } from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
import { Actor, Testing } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const effectTest = it.scopedLive.layer(TestShardingConfig);

const Counter = Actor.make("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
  },
  GetCount: {
    success: Schema.Number,
  },
});

// Use entity.toLayer directly — it infers handler types from the Rpcs
const handlerLayer = Counter.entity.toLayer({
  Increment: (request) => Effect.succeed(request.payload.amount + 1),
  GetCount: () => Effect.succeed(42),
}) as unknown as Layer.Layer<never>;

describe("Actor.make", () => {
  test("defines a multi-operation actor with typed payload/success/error schemas", () => {
    expect(Counter.name).toBe("Counter");
    expect(Counter._tag).toBe("ActorDefinition");
    expect(Counter.entity).toBeDefined();
    expect(Counter.operations).toBeDefined();
    expect(Object.keys(Counter.operations)).toEqual(["Increment", "GetCount"]);
  });

  test("compiles operations into Entity under the hood", () => {
    expect(Counter.entity).toBeDefined();
  });

  test("attaches persisted annotation when persisted: true", () => {
    const Persisted = Actor.make("Persisted", {
      Save: {
        payload: { data: Schema.String },
        success: Schema.Void,
        persisted: true,
      },
    });
    const rpc = Persisted.entity.protocol.requests.get("Save")!;
    const val = Context.get(rpc.annotations, ClusterSchema.Persisted);
    expect(val).toBe(true);
  });

  test("attaches primaryKey extractor from definition", () => {
    const WithPK = Actor.make("WithPK", {
      Op: {
        payload: { id: Schema.String },
        success: Schema.Void,
        persisted: true,
        primaryKey: (p: { id: string }) => p.id,
      },
    });
    expect(WithPK.operations["Op"]!.primaryKey).toBeDefined();
    const pk = WithPK.operations["Op"]!.primaryKey!({ id: "abc" } as never);
    expect(pk).toBe("abc");
  });

  test("operations without explicit persisted: true use cluster default", () => {
    const rpc = Counter.entity.protocol.requests.get("Increment")!;
    const result = Context.getOption(rpc.annotations, ClusterSchema.Persisted);
    expect(Counter.operations["Increment"]!.persisted).toBeUndefined();
    expect(result._tag).toBe("Some");
  });
});

const Ping = Actor.single("Ping", {
  payload: { message: Schema.String },
  success: Schema.String,
});

const pingHandlers = Ping.entity.toLayer({
  Ping: (request) => Effect.succeed(`pong: ${request.payload.message}`),
}) as unknown as Layer.Layer<never>;

describe("Actor.single", () => {
  effectTest("defines a single-operation actor — no operation namespace on ref", () =>
    Effect.gen(function* () {
      expect(Ping.name).toBe("Ping");
      expect(Ping._tag).toBe("SingleActorDefinition");
      expect(Ping.operationTag).toBe("Ping");

      const makeRef = yield* Testing.testSingleClient(Ping, pingHandlers);
      const ref = yield* makeRef("p-1");
      const result = yield* ref.call({ message: "hello" });
      expect(result).toBe("pong: hello");
    }),
  );

  test("supports persisted + primaryKey options", () => {
    const PingSave = Actor.single("PingSave", {
      payload: { msg: Schema.String },
      success: Schema.String,
      persisted: true,
      primaryKey: (p: { msg: string }) => p.msg,
    });
    expect(PingSave.operation.persisted).toBe(true);
    expect(PingSave.operation.primaryKey).toBeDefined();
    const rpc = PingSave.entity.protocol.requests.get("PingSave")!;
    const val = Context.get(rpc.annotations, ClusterSchema.Persisted);
    expect(val).toBe(true);
  });
});

describe("Actor.client", () => {
  effectTest("returns a function (entityId) => Ref with typed operations", () =>
    Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Counter, handlerLayer);
      const ref = yield* makeRef("counter-1");
      expect(ref["Increment"]).toBeDefined();
      expect(ref["Increment"]?.call).toBeDefined();
      expect(ref["GetCount"]).toBeDefined();
      expect(ref["GetCount"]?.call).toBeDefined();
    }),
  );
});

describe("deliverAt", () => {
  test("attaches DeliverAt.symbol to payload instances when deliverAt is configured", () => {
    const Delayed = Actor.make("Delayed", {
      Process: {
        payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
        success: Schema.Void,
        persisted: true,
        primaryKey: (p: { id: string }) => p.id,
        deliverAt: (p: { deliverAt: DateTime.DateTime }) => p.deliverAt,
      },
    });

    // Get the compiled Rpc's payload schema and instantiate it
    const rpc = Delayed.entity.protocol.requests.get("Process")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.makeUnsafe(Date.now());
    const instance = new (payloadSchema as unknown as new (args: unknown) => unknown)({
      id: "test-123",
      deliverAt: now,
    });

    // DeliverAt.symbol should be on the instance
    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(now.epochMilliseconds);
  });

  test("attaches PrimaryKey.symbol to payload instances when primaryKey is configured", () => {
    const WithPK = Actor.make("WithPKPayload", {
      Op: {
        payload: { id: Schema.String },
        success: Schema.Void,
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
    const Plain = Actor.make("Plain", {
      Op: {
        payload: { value: Schema.String },
        success: Schema.Void,
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
    const DelayedOnly = Actor.make("DelayedOnly", {
      Fire: {
        payload: { when: Schema.DateTimeUtc },
        success: Schema.Void,
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

  test("accepts pre-built Schema.Class as payload — uses it directly", () => {
    class CustomPayload extends Schema.Class<CustomPayload>("test/CustomPayload")({
      id: Schema.String,
      value: Schema.Number,
    }) {
      [PrimaryKey.symbol](): string {
        return this.id;
      }
    }

    const WithCustom = Actor.make("WithCustom", {
      Process: {
        payload: CustomPayload,
        success: Schema.String,
        persisted: true,
      },
    });

    // The Rpc should use CustomPayload directly
    const rpc = WithCustom.entity.protocol.requests.get("Process")!;
    const instance = new CustomPayload({ id: "xyz", value: 42 });

    // PrimaryKey should work since it's on the class
    expect(instance[PrimaryKey.symbol]()).toBe("xyz");

    // The schema used by the Rpc should be the original class
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

    const Scheduled = Actor.make("Scheduled", {
      Run: {
        payload: ScheduledPayload,
        success: Schema.Void,
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
