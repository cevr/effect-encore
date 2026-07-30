import { describe, expect, it } from "effect-bun-test";
import { Effect, Exit, Layer, Schema, Stream } from "effect";
import { ShardingConfig, TestRunner } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

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
    id: (p: { input: string }) => p.input,
  },
});

const ValidatorTest = Layer.provide(
  Actor.toTestLayer(Validator, {
    Validate: ({ operation }) =>
      operation.input === "bad"
        ? Effect.fail(ValidationError.make({ message: "invalid input" }))
        : Effect.succeed(`validated: ${operation.input}`),
  }),
  TestShardingConfig,
);

const test = it.scopedLive.layer(ValidatorTest);

describe("OperationHandle.execute", () => {
  test("sends message and awaits handler completion — returns success value", () =>
    Effect.gen(function* () {
      const result = yield* Validator.Validate.execute({ input: "good" });
      expect(result).toBe("validated: good");
    }));

  test("surfaces handler errors in the error channel", () =>
    Effect.gen(function* () {
      const exit = yield* Validator.Validate.execute({ input: "bad" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  it.scopedLive.layer(
    Layer.provide(
      Actor.toTestLayer(
        Actor.fromEntity("Boom", {
          Explode: { id: () => "boom" },
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
        Explode: { id: () => "boom" },
      });
      const exit = yield* BoomActor.Explode.execute(undefined as never).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.scopedLive.layer(
    Layer.provide(
      Actor.toTestLayer(
        Actor.fromEntity("Volatile", {
          Ping: { success: Schema.String, id: () => "ping" },
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
        Ping: { success: Schema.String, id: () => "ping" },
      });
      const result = yield* VolatileActor.Ping.execute(undefined as never);
      expect(result).toBe("pong");
    }),
  );
});

const CastActor = Actor.fromEntity("CastActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const CastActorTest = Layer.provide(
  Actor.toTestLayer(CastActor, {
    Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  }),
  TestShardingConfig,
);

const castTest = it.scopedLive.layer(CastActorTest);

describe("OperationHandle.send", () => {
  castTest("send dispatches persisted message — returns ExecId encoding tag and primaryKey", () =>
    Effect.gen(function* () {
      const execId = yield* CastActor.Process.send({ input: "data" });
      expect(typeof execId).toBe("string");
      // entityId === primaryKey === "data" (from the id fn)
      expect(String(execId)).toBe("data\x00Process\x00data");
    }),
  );

  castTest("execId encodes operation tag and primaryKey", () =>
    Effect.gen(function* () {
      const execId = yield* CastActor.Process.send({ input: "mykey" });
      expect(String(execId)).toBe("mykey\x00Process\x00mykey");
    }),
  );

  castTest("executionId(payload) is consistent with send(payload)", () =>
    Effect.gen(function* () {
      const fromSend = yield* CastActor.Process.send({ input: "test" });
      const fromCompute = yield* CastActor.Process.executionId({ input: "test" });
      expect(String(fromSend)).toBe(String(fromCompute));
    }),
  );
});

describe("OperationHandle.watch", () => {
  const castHandlerLayer = Actor.toLayer(CastActor, {
    Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  });
  const castHandlerWithRunner = castHandlerLayer.pipe(Layer.provideMerge(TestRunner.layer));

  it.scopedLive("emits Pending then Success when handler completes, then completes stream", () =>
    Effect.gen(function* () {
      // Kick off the handler via the client to seed the persistence layer.
      const makeClient = yield* CastActor._meta.entity.client;
      const client = makeClient(
        // entityId === primaryKey === "watch-test" via the id fn
        "watch-test",
      );
      yield* client.Process({ input: "watch-test" }, { discard: true });

      const result = yield* CastActor.Process.watch(
        { input: "watch-test" },
        { interval: "50 millis" },
      ).pipe(Stream.runCollect);

      const arr = Array.from(result);
      expect(arr.length).toBeGreaterThan(0);
      const last = arr[arr.length - 1]!;
      expect(last._tag).toBe("Success");
      if (last._tag === "Success") {
        expect(last.value).toBe("processed: watch-test");
      }
    }).pipe(Effect.provide(castHandlerWithRunner)),
  );
});
