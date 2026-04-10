import { describe, expect, it } from "bun:test";
import type { Layer } from "effect";
import { Effect, Exit, Schema, Stream } from "effect";
import { ShardingConfig, TestRunner } from "effect/unstable/cluster";
import { Actor, Peek, Receipt, Testing } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

const Validator = Actor.make("Validator", {
  Validate: {
    payload: { input: Schema.String },
    success: Schema.String,
    error: ValidationError,
  },
});

const validatorHandlers = Validator.entity.toLayer({
  Validate: (request) =>
    request.payload.input === "bad"
      ? Effect.fail(new ValidationError({ message: "invalid input" }))
      : Effect.succeed(`validated: ${request.payload.input}`),
}) as unknown as Layer.Layer<never>;

describe("Ref.call", () => {
  it("sends message and awaits handler completion — returns success value", async () => {
    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Validator, validatorHandlers);
      const ref = yield* makeRef("v-1");
      return yield* ref["Validate"]!.call({ input: "good" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("validated: good");
  });

  it("surfaces handler errors in the error channel", async () => {
    const exit = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(Validator, validatorHandlers);
      const ref = yield* makeRef("v-1");
      return yield* ref["Validate"]!.call({ input: "bad" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("surfaces handler defects as defects", async () => {
    const BoomActor = Actor.make("Boom", {
      Explode: { success: Schema.Void },
    });
    const boomHandlers = BoomActor.entity.toLayer({
      Explode: () => Effect.die("kaboom"),
    }) as unknown as Layer.Layer<never>;

    const exit = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(BoomActor, boomHandlers);
      const ref = yield* makeRef("b-1");
      return yield* ref["Explode"]!.call();
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("works without MessageStorage (non-persisted path)", async () => {
    // Non-persisted actor — call should work with just makeTestClient
    const VolatileActor = Actor.make("Volatile", {
      Ping: { success: Schema.String },
    });
    const volatileHandlers = VolatileActor.entity.toLayer({
      Ping: () => Effect.succeed("pong"),
    }) as unknown as Layer.Layer<never>;

    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(VolatileActor, volatileHandlers);
      const ref = yield* makeRef("vol-1");
      return yield* ref["Ping"]!.call();
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe("pong");
  });
});

const CastActor = Actor.make("CastActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    primaryKey: (p: { input: string }) => p.input,
  },
});

const castHandlers = CastActor.entity.toLayer({
  Process: (request) => Effect.succeed(`processed: ${request.payload.input}`),
}) as unknown as Layer.Layer<never>;

describe("Ref.cast", () => {
  it("sends persisted message with discard: true — returns CastReceipt immediately", async () => {
    const receipt = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(CastActor, castHandlers);
      const ref = yield* makeRef("c-1");
      return yield* ref["Process"]!.cast({ input: "data" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(receipt._tag).toBe("CastReceipt");
  });

  it("receipt contains actorType, entityId, operation, primaryKey", async () => {
    const receipt = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(CastActor, castHandlers);
      const ref = yield* makeRef("c-2");
      return yield* ref["Process"]!.cast({ input: "mykey" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(receipt.actorType).toBe("CastActor");
    expect(receipt.entityId).toBe("c-2");
    expect(receipt.operation).toBe("Process");
    expect(receipt.primaryKey).toBe("mykey");
  });

  it("auto-generates primaryKey when payload has no PrimaryKey", async () => {
    const SimpleActor = Actor.make("Simple", {
      Do: {
        payload: { x: Schema.Number },
        success: Schema.Number,
        persisted: true,
      },
    });
    const simpleHandlers = SimpleActor.entity.toLayer({
      Do: (req) => Effect.succeed(req.payload.x * 2),
    }) as unknown as Layer.Layer<never>;

    const receipt = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(SimpleActor, simpleHandlers);
      const ref = yield* makeRef("s-1");
      return yield* ref["Do"]!.cast({ x: 5 });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(receipt.primaryKey).toBeDefined();
    expect(receipt.primaryKey.length).toBeGreaterThan(0);
  });

  it("cast still returns CastReceipt even without cluster persistence", async () => {
    // Cast with discard:true returns a CastReceipt from our library layer,
    // independent of whether cluster persisted it. The receipt is constructed
    // client-side from the primaryKey function.
    const receipt = await Effect.gen(function* () {
      const makeRef = yield* Testing.testClient(CastActor, castHandlers);
      const ref = yield* makeRef("c-persist-1");
      return yield* ref["Process"]!.cast({ input: "test" });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(receipt._tag).toBe("CastReceipt");
    expect(receipt.primaryKey).toBe("test");
  });
});

describe("Ref.watch", () => {
  it("emits Pending then Success when handler completes, then completes stream", async () => {
    const result = await Effect.gen(function* () {
      // Use real cluster path so replies go to MessageStorage
      const makeClient = yield* CastActor.entity.client;
      const client = makeClient("w-1");

      // Cast to fire-and-forget
      yield* client.Process({ input: "watch-test" }, { discard: true });

      const receipt = Receipt.makeCastReceipt({
        actorType: "CastActor",
        entityId: "w-1",
        operation: "Process",
        primaryKey: "watch-test",
      });

      // Watch polls until terminal
      return yield* Peek.watch(CastActor, receipt, {
        interval: "50 millis",
      }).pipe(Stream.runCollect);
    }).pipe(
      Effect.provide(castHandlers),
      Effect.provide(TestRunner.layer),
      Effect.scoped,
      Effect.runPromise,
    );

    // Should have at least one entry, ending with Success
    const arr = Array.from(result);
    expect(arr.length).toBeGreaterThan(0);
    const last = arr[arr.length - 1]!;
    expect(last._tag).toBe("Success");
    if (last._tag === "Success") {
      expect(last.value).toBe("processed: watch-test");
    }
  });
});

describe("single-operation ref", () => {
  it("call/cast are directly on ref — no operation namespace", async () => {
    const SingleActor = Actor.single("SingleOp", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      persisted: true,
      primaryKey: (p: { n: number }) => String(p.n),
    });

    const singleHandlers = SingleActor.entity.toLayer({
      SingleOp: (req) => Effect.succeed(req.payload.n * 3),
    }) as unknown as Layer.Layer<never>;

    const result = await Effect.gen(function* () {
      const makeRef = yield* Testing.testSingleClient(SingleActor, singleHandlers);
      const ref = yield* makeRef("single-1");
      return yield* ref.call({ n: 5 });
    }).pipe(Effect.scoped, Effect.provide(TestShardingConfig), Effect.runPromise);

    expect(result).toBe(15);
  });
});
