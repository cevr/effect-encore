import { describe, expect, it } from "bun:test";
import type { Layer } from "effect";
import { Context, Effect, Schema } from "effect";
import { ClusterSchema, ShardingConfig } from "effect/unstable/cluster";
import { Actor, Testing } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

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
  it("defines a multi-operation actor with typed payload/success/error schemas", () => {
    expect(Counter.name).toBe("Counter");
    expect(Counter._tag).toBe("ActorDefinition");
    expect(Counter.entity).toBeDefined();
    expect(Counter.operations).toBeDefined();
    expect(Object.keys(Counter.operations)).toEqual(["Increment", "GetCount"]);
  });

  it("compiles operations into Entity under the hood", () => {
    expect(Counter.entity).toBeDefined();
  });

  it("attaches persisted annotation when persisted: true", () => {
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

  it("attaches primaryKey extractor from definition", () => {
    const WithPK = Actor.make("WithPK", {
      Op: {
        payload: { id: Schema.String },
        success: Schema.Void,
        persisted: true,
        primaryKey: (p: { id: string }) => p.id,
      },
    });
    expect(WithPK.operations["Op"]!.primaryKey).toBeDefined();
    // Verify it's wired — calling primaryKey on a payload returns the key
    const pk = WithPK.operations["Op"]!.primaryKey!({ id: "abc" } as never);
    expect(pk).toBe("abc");
  });

  it("operations without explicit persisted: true use cluster default", () => {
    // Cluster defaults all RPCs to persisted: true. Our DSL only sets the
    // annotation explicitly when persisted: true is specified.
    const rpc = Counter.entity.protocol.requests.get("Increment")!;
    const result = Context.getOption(rpc.annotations, ClusterSchema.Persisted);
    // Cluster sets a default — either present or not, but the operation
    // config does not have persisted set
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
  it("defines a single-operation actor — no operation namespace on ref", async () => {
    expect(Ping.name).toBe("Ping");
    expect(Ping._tag).toBe("SingleActorDefinition");
    expect(Ping.operationTag).toBe("Ping");

    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testSingleClient(Ping, pingHandlers);
      const ref = yield* makeRef("p-1");
      return yield* ref.call({ message: "hello" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("pong: hello");
  });

  it("supports persisted + primaryKey options", () => {
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
  it("returns a function (entityId) => Ref with typed operations", async () => {
    const program = Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Counter, handlerLayer);
      const ref = yield* makeRef("counter-1");
      expect(ref["Increment"]).toBeDefined();
      expect(ref["Increment"]?.call).toBeDefined();
      expect(ref["GetCount"]).toBeDefined();
      expect(ref["GetCount"]?.call).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig));

    await Effect.runPromise(program);
  });
});
