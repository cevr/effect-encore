import { describe, expect, it, test } from "effect-bun-test";
import { Context, DateTime, Effect, Layer, PrimaryKey, Schema, SchemaGetter } from "effect";
import { ClusterSchema, ShardingConfig } from "effect/cluster";
import * as DeliverAt from "effect/cluster/DeliverAt";
import { Actor } from "../src/index.js";
import { unwrapOpaquePayload } from "../src/internal/invocation-compiler.js";

// Fixed instant: these cases assert DeliverAt/PrimaryKey wiring, not the clock.
const FIXED_EPOCH_MS = 1_700_000_000_000;

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const Counter = Actor.fromEntity("Counter", {
  Increment: {
    payload: { amount: Schema.Finite },
    success: Schema.Finite,
    id: (p: { amount: number }) => String(p.amount),
  },
  GetCount: {
    success: Schema.Finite,
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
    expect(WithPK._meta.definitions["Op"].id).toBeDefined();
    const pk = WithPK._meta.definitions["Op"].id({ id: "abc" });
    expect(pk).toBe("abc");
  });

  test("operations without explicit persisted: true use cluster default", () => {
    const rpc = Counter._meta.entity.protocol.requests.get("Increment")!;
    const result = Context.getOption(rpc.annotations, ClusterSchema.Persisted);
    expect("persisted" in Counter._meta.definitions["Increment"]).toBe(false);
    expect(result._tag).toBe("Some");
  });

  test("operation handles expose make() to produce operation values with _tag", () => {
    const op = Counter.Increment.make({ amount: 5 });
    expect(op._tag).toBe("Increment");
    expect(op.amount).toBe(5);
  });

  test("zero-input handles allow make() with no args", () => {
    // oxlint-disable-next-line effect/noAs, effect/noNullish -- The nullary operation fixture must supply the public method's uninhabited payload parameter.
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
      // oxlint-disable-next-line effect/noAs -- The invalid reserved-name fixture must bypass the public definition type to verify the runtime guard.
      Actor.fromEntity("Bad", {
        _meta: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'interrupt'", () => {
    expect(() =>
      // oxlint-disable-next-line effect/noAs -- The invalid reserved-name fixture must bypass the public definition type to verify the runtime guard.
      Actor.fromEntity("Bad", {
        interrupt: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'flush'", () => {
    expect(() =>
      // oxlint-disable-next-line effect/noAs -- The invalid reserved-name fixture must bypass the public definition type to verify the runtime guard.
      Actor.fromEntity("Bad", {
        flush: { id: () => "x" },
      } as never),
    ).toThrow(/collides with reserved/);
  });

  test("throws on reserved operation name 'redeliver'", () => {
    expect(() =>
      // oxlint-disable-next-line effect/noAs -- The invalid reserved-name fixture must bypass the public definition type to verify the runtime guard.
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
        // oxlint-disable-next-line effect/noAs -- The generated invalid reserved-name fixture must bypass the public definition type to verify the runtime guard.
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
      // oxlint-disable-next-line effect/noAs, effect/noNullish -- The nullary operation fixture must supply the public method's uninhabited payload parameter.
      const result = yield* Counter.GetCount.execute(undefined as never);
      expect(result).toBe(42);
    }),
  );

  effectTest("send(payload) returns ExecId encoding entityId/tag/primaryKey", () =>
    Effect.gen(function* () {
      const execId = yield* Counter.Increment.send({ amount: 7 });
      expect(execId).toBeTypeOf("string");
      // entityId === primaryKey === String(amount) === "7"
      expect(String(execId)).toBe("7\x00Increment\x007");
    }),
  );

  effectTest("ExecId uses null-byte separator (colons in segments are safe)", () => {
    const NsCounter = Actor.fromEntity("NsCounter", {
      Bump: {
        payload: { ns: Schema.String, amount: Schema.Finite },
        success: Schema.Finite,
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

    return Effect.gen(function* () {
      const execId = yield* NsCounter.Bump.send({ ns: "tenant-1", amount: 3 });
      expect(String(execId)).toBe("ns:tenant-1\x00Bump\x003");
      const str = String(execId);
      expect(str).toContain("\x00");
      expect(str.split("\x00")).toEqual(["ns:tenant-1", "Bump", "3"]);
    }).pipe(Effect.provide(NsTest));
  });

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
    expect(op._payload).toBe("hello");
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

  test("preserves opaque scalar codecs while attaching a primary key carrier", () => {
    const rpc = Echo._meta.entity.protocol.requests.get("Say")!;
    const instance = rpc.payloadSchema.make("hello");
    expect(PrimaryKey.isPrimaryKey(instance)).toBe(true);
    if (PrimaryKey.isPrimaryKey(instance)) {
      expect(PrimaryKey.value(instance)).toBe("hello");
    }
    expect(Schema.encodeUnknownSync(rpc.payloadSchema)(instance)).toBe("hello");
    const decoded = Schema.decodeSync(rpc.payloadSchema)("decoded");
    expect(PrimaryKey.isPrimaryKey(decoded)).toBe(true);
    if (PrimaryKey.isPrimaryKey(decoded)) {
      expect(PrimaryKey.value(decoded)).toBe("decoded");
    }
  });

  test("attaches identity to opaque object-union schemas", () => {
    const UnionActor = Actor.fromEntity("UnionPayload", {
      Run: {
        payload: Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]),
        id: (payload: string | { readonly id: string }) => {
          if (Schema.is(Schema.String)(payload)) return payload;
          return payload.id;
        },
      },
    });
    const rpc = UnionActor._meta.entity.protocol.requests.get("Run")!;
    const scalar = rpc.payloadSchema.make("union-scalar");
    const object = rpc.payloadSchema.make({ id: "union-object" });

    expect(PrimaryKey.isPrimaryKey(scalar)).toBe(true);
    expect(PrimaryKey.isPrimaryKey(object)).toBe(true);
    if (PrimaryKey.isPrimaryKey(scalar) && PrimaryKey.isPrimaryKey(object)) {
      expect(PrimaryKey.value(scalar)).toBe("union-scalar");
      expect(PrimaryKey.value(object)).toBe("union-object");
    }
    expect(Schema.encodeUnknownSync(rpc.payloadSchema)(scalar)).toBe("union-scalar");
    expect(Schema.encodeUnknownSync(rpc.payloadSchema)(object)).toEqual({ id: "union-object" });
  });
});

describe("deliverAt", () => {
  test("attaches PrimaryKey.symbol to schema payload instances", () => {
    const WithSchemaPayload = Actor.fromEntity("WithSchemaPayload", {
      Op: {
        payload: Schema.Struct({ id: Schema.String }),
        id: (payload: { readonly id: string }) => payload.id,
      },
    });

    const rpc = WithSchemaPayload._meta.entity.protocol.requests.get("Op")!;
    const instance = rpc.payloadSchema.make({ id: "schema-abc" });

    expect(PrimaryKey.isPrimaryKey(instance)).toBe(true);
    if (PrimaryKey.isPrimaryKey(instance)) {
      expect(PrimaryKey.value(instance)).toBe("schema-abc");
    }
  });

  test("preserves transformed schema payload codecs while adding identity", () => {
    const DecodedPayload = Schema.Struct({
      id: Schema.String,
      value: Schema.String,
    }).pipe(
      Schema.decodeTo(Schema.Struct({ id: Schema.String, value: Schema.Finite }), {
        decode: SchemaGetter.transform((payload) => ({
          id: payload.id,
          value: Number(payload.value),
        })),
        encode: SchemaGetter.transform((payload) => ({
          id: payload.id,
          value: String(payload.value),
        })),
      }),
    );
    const WithDecodedPayload = Actor.fromEntity("WithDecodedPayload", {
      Op: {
        payload: DecodedPayload,
        id: (payload: { readonly id: string; readonly value: number }) => payload.id,
      },
    });

    const rpc = WithDecodedPayload._meta.entity.protocol.requests.get("Op")!;
    const decodedCarrier = Schema.decodeSync(rpc.payloadSchema)({
      id: "decoded-abc",
      value: "42",
    });
    const decoded = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, value: Schema.Finite }),
    )(unwrapOpaquePayload(decodedCarrier));
    const encoded = Schema.encodeUnknownSync(rpc.payloadSchema)(decodedCarrier);

    expect(decoded.value).toBe(42);
    expect(encoded).toEqual({ id: "decoded-abc", value: "42" });
    expect(PrimaryKey.isPrimaryKey(decodedCarrier)).toBe(true);
    if (PrimaryKey.isPrimaryKey(decodedCarrier)) {
      expect(PrimaryKey.value(decodedCarrier)).toBe("decoded-abc");
    }
  });

  it.scopedLive("preserves transformed Schema.Class methods while adding identity", () => {
    class DecodedPayload extends Schema.Class<DecodedPayload>("test/DecodedPayload")({
      id: Schema.String,
    }) {
      key(): string {
        return this.id;
      }
    }
    const EncodedPayload = Schema.String.pipe(
      Schema.decodeTo(DecodedPayload, {
        decode: SchemaGetter.transform((id) => DecodedPayload.make({ id })),
        encode: SchemaGetter.transform((payload) => payload.id),
      }),
    );
    const WithDecodedClass = Actor.fromEntity("WithDecodedClass", {
      Run: {
        payload: EncodedPayload,
        success: Schema.String,
        id: (payload: DecodedPayload) => payload.key(),
      },
    });
    const rpc = WithDecodedClass._meta.entity.protocol.requests.get("Run")!;
    const decodedCarrier = Schema.decodeSync(rpc.payloadSchema)("class-roundtrip");
    const decoded = Schema.decodeUnknownSync(DecodedPayload)(unwrapOpaquePayload(decodedCarrier));

    expect(Schema.is(DecodedPayload)(decoded)).toBe(true);
    expect(decoded.key()).toBe("class-roundtrip");
    expect(PrimaryKey.isPrimaryKey(decodedCarrier)).toBe(true);
    if (PrimaryKey.isPrimaryKey(decodedCarrier)) {
      expect(PrimaryKey.value(decodedCarrier)).toBe("class-roundtrip");
    }
    expect(Schema.encodeUnknownSync(rpc.payloadSchema)(decodedCarrier)).toBe("class-roundtrip");

    const HandlerLayer = Layer.provide(
      Actor.toTestLayer(WithDecodedClass, {
        Run: ({ operation }) =>
          Effect.succeed(
            `${operation._payload.key()}:${Schema.is(DecodedPayload)(operation._payload)}`,
          ),
      }),
      TestShardingConfig,
    );
    return Effect.gen(function* () {
      const result = yield* WithDecodedClass.Run.execute(DecodedPayload.make({ id: "handler" }));
      expect(result).toBe("handler:true");
    }).pipe(Effect.provide(HandlerLayer));
  });

  test("attaches both identity protocols to schema payload instances", () => {
    const WithSchemaDelivery = Actor.fromEntity("WithSchemaDelivery", {
      Op: {
        payload: Schema.Struct({ id: Schema.String, when: Schema.DateTimeUtc }),
        id: (payload: { readonly id: string }) => payload.id,
        deliverAt: (payload: { readonly when: DateTime.DateTime }) => payload.when,
      },
    });

    const rpc = WithSchemaDelivery._meta.entity.protocol.requests.get("Op")!;
    const when = DateTime.makeUnsafe(FIXED_EPOCH_MS);
    const instance = rpc.payloadSchema.make({ id: "schema-delivery", when });

    expect(PrimaryKey.isPrimaryKey(instance)).toBe(true);
    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    if (PrimaryKey.isPrimaryKey(instance)) {
      expect(PrimaryKey.value(instance)).toBe("schema-delivery");
    }
    if (DeliverAt.isDeliverAt(instance)) {
      expect(DeliverAt.toMillis(instance)).toBe(FIXED_EPOCH_MS);
    }
  });

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
    const now = DateTime.makeUnsafe(FIXED_EPOCH_MS);
    const instance = payloadSchema.make({
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
        id: (p: { id: string }) => p.id,
      },
    });

    const rpc = WithPK._meta.entity.protocol.requests.get("Op")!;
    const payloadSchema = rpc.payloadSchema;
    const instance = payloadSchema.make({
      id: "abc",
    });

    expect(PrimaryKey.isPrimaryKey(instance)).toBe(true);
    if (PrimaryKey.isPrimaryKey(instance)) {
      expect(PrimaryKey.value(instance)).toBe("abc");
    }
  });

  test("deliverAt without payload primaryKey symbol is valid (delayed but uses fn primaryKey)", () => {
    const DelayedOnly = Actor.fromEntity("DelayedOnly", {
      Fire: {
        payload: { when: Schema.DateTimeUtc },
        persisted: true,
        id: (p: { when: DateTime.DateTime }) => String(p.when.epochMilliseconds),
        deliverAt: (p: { when: DateTime.DateTime }) => p.when,
      },
    });

    const rpc = DelayedOnly._meta.entity.protocol.requests.get("Fire")!;
    const payloadSchema = rpc.payloadSchema;
    const now = DateTime.makeUnsafe(FIXED_EPOCH_MS);
    const instance = payloadSchema.make({
      when: now,
    });

    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
  });

  test("accepts pre-built Schema.Class as input — uses it directly", () => {
    class CustomPayload extends Schema.Class<CustomPayload>("test/CustomPayload")({
      id: Schema.String,
      value: Schema.Finite,
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
    const instance = CustomPayload.make({ id: "xyz", value: 42 });

    expect(instance[PrimaryKey.symbol]()).toBe("xyz");
    expect(rpc.payloadSchema).toBe(CustomPayload);
  });

  test("preserves Schema.Class methods while adding identity protocols", () => {
    class ClassWithoutProtocols extends Schema.Class<ClassWithoutProtocols>(
      "test/ClassWithoutProtocols",
    )({
      id: Schema.String,
    }) {
      describe(): string {
        return `payload:${this.id}`;
      }
    }

    const WithClass = Actor.fromEntity("WithClass", {
      Process: {
        payload: ClassWithoutProtocols,
        id: (p: { id: string }) => p.id,
      },
    });
    const rpc = WithClass._meta.entity.protocol.requests.get("Process")!;
    const instance = rpc.payloadSchema.make({ id: "class-make" });
    const decoded = Schema.decodeSync(rpc.payloadSchema)({ id: "class-decode" });

    expect(instance.describe()).toBe("payload:class-make");
    expect(decoded.describe()).toBe("payload:class-decode");
    expect(PrimaryKey.isPrimaryKey(instance)).toBe(true);
    expect(PrimaryKey.isPrimaryKey(decoded)).toBe(true);
    if (PrimaryKey.isPrimaryKey(instance) && PrimaryKey.isPrimaryKey(decoded)) {
      expect(PrimaryKey.value(instance)).toBe("class-make");
      expect(PrimaryKey.value(decoded)).toBe("class-decode");
    }
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

    const now = DateTime.makeUnsafe(FIXED_EPOCH_MS);
    const instance = ScheduledPayload.make({ id: "s-1", when: now });

    expect(instance[PrimaryKey.symbol]()).toBe("s-1");
    expect(DeliverAt.isDeliverAt(instance)).toBe(true);
    expect(DeliverAt.toMillis(instance)).toBe(now.epochMilliseconds);

    const rpc = Scheduled._meta.entity.protocol.requests.get("Run")!;
    expect(rpc.payloadSchema).toBe(ScheduledPayload);
  });
});

describe("send ExecId parity with executionId/peek (Schema.Class payloads)", () => {
  // An Invocation derives identity once from the original payload. The public
  // Operation value also keeps the payload prototype for value dispatch.
  class RoutingKey extends Schema.Class<RoutingKey>("test/RoutingKey")({
    region: Schema.String,
    seq: Schema.Finite,
  }) {
    routingKey(): string {
      return `${this.region}-${this.seq}`;
    }
    [PrimaryKey.symbol](): string {
      return this.routingKey();
    }
  }

  const Routed = Actor.fromEntity("Routed", {
    Process: {
      payload: RoutingKey,
      success: Schema.String,
      persisted: true,
      // id depends on the class instance (prototype method), NOT a bare field.
      id: (p: RoutingKey) => p.routingKey(),
    },
  });

  const RoutedTest = Layer.provide(
    Actor.toTestLayer(Routed, {
      Process: ({ operation }) => Effect.succeed(`routed: ${operation.routingKey()}`),
    }),
    TestShardingConfig,
  );

  const routedTest = it.scopedLive.layer(RoutedTest);

  routedTest("send(payload) ExecId === executionId(payload) for a class-instance id", () =>
    Effect.gen(function* () {
      const payload = RoutingKey.make({ region: "us", seq: 7 });
      const fromSend = yield* Routed.Process.send(payload);
      // entityId === primaryKey === "us-7" (from routingKey()).
      expect(String(fromSend)).toBe("us-7\x00Process\x00us-7");
      // `executionId` and `peek` share the same `execId(payload)` derivation, so
      // matching `executionId` is exactly the parity `peek` relies on.
      const fromCompute = yield* Routed.Process.executionId(payload);
      expect(String(fromSend)).toBe(String(fromCompute));
    }),
  );

  routedTest(
    "ref.send(make(payload)) ExecId === executionId(payload) for a class-instance id",
    () =>
      Effect.gen(function* () {
        const payload = RoutingKey.make({ region: "us", seq: 7 });
        const makeRef = yield* Routed.Context;
        // entityId === routingKey() === "us-7", so the ref binds to that entity.
        const ref = yield* makeRef("us-7");
        const op = Routed.Process.make(payload);
        expect(Object.getPrototypeOf(op)).toBe(RoutingKey.prototype);
        const fromRefSend = yield* ref.send(op);
        expect(String(fromRefSend)).toBe("us-7\x00Process\x00us-7");
        const fromCompute = yield* Routed.Process.executionId(payload);
        expect(String(fromRefSend)).toBe(String(fromCompute));
      }),
  );
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
    expect(op.amount).toBe(5);
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
