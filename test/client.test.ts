import { describe, expect, it } from "effect-bun-test";
import type { Layer } from "effect";
import { Effect, Exit, Schema, Stream } from "effect";
import { ShardingConfig, TestRunner } from "effect/unstable/cluster";
import { Actor, makeCastReceipt, watch } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const test = it.scopedLive.layer(TestShardingConfig);

class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

const Validator = Actor("Validator", {
  Validate: {
    input: { input: Schema.String },
    output: Schema.String,
    error: ValidationError,
  },
});

const validatorHandlers = Validator.handlers({
  Validate: ({ operation }) =>
    operation.input === "bad"
      ? Effect.fail(new ValidationError({ message: "invalid input" }))
      : Effect.succeed(`validated: ${operation.input}`),
});

describe("Ref.call", () => {
  test("sends message and awaits handler completion — returns success value", () =>
    Effect.gen(function* () {
      const makeRef = yield* Validator.testClient(
        validatorHandlers as unknown as Layer.Layer<never>,
      );
      const ref = yield* makeRef("v-1");
      const result = yield* ref.call(Validator.Validate({ input: "good" }));
      expect(result).toBe("validated: good");
    }));

  test("surfaces handler errors in the error channel", () =>
    Effect.gen(function* () {
      const makeRef = yield* Validator.testClient(
        validatorHandlers as unknown as Layer.Layer<never>,
      );
      const ref = yield* makeRef("v-1");
      const exit = yield* ref.call(Validator.Validate({ input: "bad" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  test("surfaces handler defects as defects", () =>
    Effect.gen(function* () {
      const BoomActor = Actor("Boom", {
        Explode: {},
      });
      const boomHandlers = BoomActor.handlers({
        Explode: () => Effect.die("kaboom"),
      });

      const makeRef = yield* BoomActor.testClient(boomHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("b-1");
      const exit = yield* ref.call(BoomActor.Explode()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  test("works without MessageStorage (non-persisted path)", () =>
    Effect.gen(function* () {
      const VolatileActor = Actor("Volatile", {
        Ping: { output: Schema.String },
      });
      const volatileHandlers = VolatileActor.handlers({
        Ping: () => Effect.succeed("pong"),
      });

      const makeRef = yield* VolatileActor.testClient(
        volatileHandlers as unknown as Layer.Layer<never>,
      );
      const ref = yield* makeRef("vol-1");
      const result = yield* ref.call(VolatileActor.Ping());
      expect(result).toBe("pong");
    }));
});

const CastActor = Actor("CastActor", {
  Process: {
    input: { input: Schema.String },
    output: Schema.String,
    persisted: true,
    primaryKey: (p: { input: string }) => p.input,
  },
});

const castHandlers = CastActor.handlers({
  Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
});

describe("Ref.cast", () => {
  test("sends persisted message with discard: true — returns CastReceipt immediately", () =>
    Effect.gen(function* () {
      const makeRef = yield* CastActor.testClient(castHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("c-1");
      const receipt = yield* ref.cast(CastActor.Process({ input: "data" }));
      expect(receipt._tag).toBe("CastReceipt");
    }));

  test("receipt contains actorType, entityId, operation, primaryKey", () =>
    Effect.gen(function* () {
      const makeRef = yield* CastActor.testClient(castHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("c-2");
      const receipt = yield* ref.cast(CastActor.Process({ input: "mykey" }));
      expect(receipt.actorType).toBe("CastActor");
      expect(receipt.entityId).toBe("c-2");
      expect(receipt.operation).toBe("Process");
      expect(receipt.primaryKey).toBe("mykey");
    }));

  test("cast without primaryKey returns receipt with no primaryKey", () =>
    Effect.gen(function* () {
      const SimpleActor = Actor("Simple", {
        Do: {
          input: { x: Schema.Number },
          output: Schema.Number,
          persisted: true,
        },
      });
      const simpleHandlers = SimpleActor.handlers({
        Do: ({ operation }) => Effect.succeed(operation.x * 2),
      });

      const makeRef = yield* SimpleActor.testClient(
        simpleHandlers as unknown as Layer.Layer<never>,
      );
      const ref = yield* makeRef("s-1");
      const receipt = yield* ref.cast(SimpleActor.Do({ x: 5 }));
      expect(receipt.primaryKey).toBeUndefined();
    }));

  test("cast still returns CastReceipt even without cluster persistence", () =>
    Effect.gen(function* () {
      const makeRef = yield* CastActor.testClient(castHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("c-persist-1");
      const receipt = yield* ref.cast(CastActor.Process({ input: "test" }));
      expect(receipt._tag).toBe("CastReceipt");
      expect(receipt.primaryKey).toBe("test");
    }));
});

describe("Ref.watch", () => {
  it.scopedLive("emits Pending then Success when handler completes, then completes stream", () =>
    Effect.gen(function* () {
      const makeClient = yield* CastActor.entity.client;
      const client = makeClient("w-1");

      yield* client.Process({ input: "watch-test" }, { discard: true });

      const receipt = makeCastReceipt({
        actorType: "CastActor",
        entityId: "w-1",
        operation: "Process",
        primaryKey: "watch-test",
      });

      const result = yield* watch(CastActor, receipt, {
        interval: "50 millis",
      }).pipe(Stream.runCollect);

      const arr = Array.from(result);
      expect(arr.length).toBeGreaterThan(0);
      const last = arr[arr.length - 1]!;
      expect(last._tag).toBe("Success");
      if (last._tag === "Success") {
        expect(last.value).toBe("processed: watch-test");
      }
    }).pipe(
      Effect.provide(castHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestRunner.layer),
    ),
  );
});
