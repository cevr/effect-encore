import { describe, expect, it } from "effect-bun-test";
import { Effect, Exit, Layer, Schema, Stream } from "effect";
import { ShardingConfig, TestRunner } from "effect/unstable/cluster";
import { Actor, makeExecId } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

const Validator = Actor.fromEntity("Validator", {
  Validate: {
    payload: { input: Schema.String },
    success: Schema.String,
    error: ValidationError,
    primaryKey: (p: { input: string }) => p.input,
  },
});

const ValidatorTest = Layer.provide(
  Actor.toTestLayer(Validator, {
    Validate: ({ operation }) =>
      operation.input === "bad"
        ? Effect.fail(new ValidationError({ message: "invalid input" }))
        : Effect.succeed(`validated: ${operation.input}`),
  }),
  TestShardingConfig,
);

const test = it.scopedLive.layer(ValidatorTest);

describe("Ref.execute", () => {
  test("sends message and awaits handler completion — returns success value", () =>
    Effect.gen(function* () {
      const ref = yield* Validator.ref("v-1");
      const result = yield* ref.execute(Validator.Validate({ input: "good" }));
      expect(result).toBe("validated: good");
    }));

  test("surfaces handler errors in the error channel", () =>
    Effect.gen(function* () {
      const ref = yield* Validator.ref("v-1");
      const exit = yield* ref.execute(Validator.Validate({ input: "bad" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  it.scopedLive.layer(
    Layer.provide(
      Actor.toTestLayer(
        Actor.fromEntity("Boom", {
          Explode: { primaryKey: () => "boom" },
        }),
        {
          Explode: () => Effect.die("kaboom"),
        },
      ),
      TestShardingConfig,
    ),
  )("surfaces handler defects as defects", () =>
    Effect.gen(function* () {
      const BoomActor = Actor.fromEntity("Boom", {
        Explode: { primaryKey: () => "boom" },
      });
      const ref = yield* BoomActor.ref("b-1");
      const exit = yield* ref.execute(BoomActor.Explode()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.scopedLive.layer(
    Layer.provide(
      Actor.toTestLayer(
        Actor.fromEntity("Volatile", {
          Ping: { success: Schema.String, primaryKey: () => "ping" },
        }),
        {
          Ping: () => Effect.succeed("pong"),
        },
      ),
      TestShardingConfig,
    ),
  )("works without MessageStorage (non-persisted path)", () =>
    Effect.gen(function* () {
      const VolatileActor = Actor.fromEntity("Volatile", {
        Ping: { success: Schema.String, primaryKey: () => "ping" },
      });
      const ref = yield* VolatileActor.ref("vol-1");
      const result = yield* ref.execute(VolatileActor.Ping());
      expect(result).toBe("pong");
    }),
  );
});

const CastActor = Actor.fromEntity("CastActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    primaryKey: (p: { input: string }) => p.input,
  },
});

const CastActorTest = Layer.provide(
  Actor.toTestLayer(CastActor, {
    Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  }),
  TestShardingConfig,
);

const castTest = it.scopedLive.layer(CastActorTest);

describe("Ref.send", () => {
  castTest("send dispatches persisted message with discard: true — returns ExecId", () =>
    Effect.gen(function* () {
      const ref = yield* CastActor.ref("c-1");
      const execId = yield* ref.send(CastActor.Process({ input: "data" }));
      expect(typeof execId).toBe("string");
      expect(String(execId)).toBe("c-1\x00Process\x00data");
    }),
  );

  castTest("execId encodes operation tag and primaryKey", () =>
    Effect.gen(function* () {
      const ref = yield* CastActor.ref("c-2");
      const execId = yield* ref.send(CastActor.Process({ input: "mykey" }));
      expect(String(execId)).toBe("c-2\x00Process\x00mykey");
    }),
  );

  castTest("send returns ExecId for persisted operations", () =>
    Effect.gen(function* () {
      const ref = yield* CastActor.ref("c-persist-1");
      const execId = yield* ref.send(CastActor.Process({ input: "test" }));
      expect(typeof execId).toBe("string");
      expect(String(execId)).toBe("c-persist-1\x00Process\x00test");
    }),
  );
});

describe("Ref.watch", () => {
  const castHandlerLayer = Actor.toLayer(CastActor, {
    Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  });

  it.scopedLive("emits Pending then Success when handler completes, then completes stream", () =>
    Effect.gen(function* () {
      const makeClient = yield* CastActor._meta.entity.client;
      const client = makeClient("w-1");

      yield* client.Process({ input: "watch-test" }, { discard: true });

      const execId = makeExecId("w-1\x00Process\x00watch-test");

      const result = yield* CastActor.watch(execId, {
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
      Effect.provide(castHandlerLayer as unknown as Layer.Layer<never>),
      Effect.provide(TestRunner.layer),
    ),
  );
});
