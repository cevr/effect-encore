import { describe, expect, it } from "effect-bun-test";
import type { Layer } from "effect";
import { Effect, Exit, Schema } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

const test = it.scopedLive.layer(TestShardingConfig);

const Counter = Actor.make("Counter", {
  Increment: {
    input: { amount: Schema.Number },
    output: Schema.Number,
  },
  GetCount: {
    output: Schema.String,
  },
});

const handlerLayer = Actor.toLayer(Counter, {
  Increment: ({ operation }) => Effect.succeed(operation.amount + 1),
  GetCount: () => Effect.succeed("hello"),
});

describe("Actor.toLayer", () => {
  test("wires plain handler functions — call returns handler result", () =>
    Effect.gen(function* () {
      const makeRef = yield* Actor.Test(Counter, handlerLayer as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("counter-1");
      const result = yield* ref.call(Counter.Increment({ amount: 5 }));
      expect(result).toBe(6);
    }));

  test("handler return value becomes the RPC reply — no explicit .reply()", () =>
    Effect.gen(function* () {
      const makeRef = yield* Actor.Test(Counter, handlerLayer as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("counter-1");
      const result = yield* ref.call(Counter.GetCount());
      expect(result).toBe("hello");
    }));

  test("supports Effect.succeed for handlers that need deferred construction", () =>
    Effect.gen(function* () {
      const GenActor = Actor.make("GenActor", {
        Compute: {
          input: { x: Schema.Number },
          output: Schema.Number,
        },
      });

      const genHandlers = Actor.toLayer(
        GenActor,
        Effect.succeed({
          Compute: ({ operation }: { operation: { x: number } }) =>
            Effect.succeed(operation.x * 10),
        } as const),
      );

      const makeRef = yield* Actor.Test(GenActor, genHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("gen-1");
      const result = yield* ref.call(GenActor.Compute({ x: 7 }));
      expect(result).toBe(70);
    }));

  test("handler errors become RPC errors", () =>
    Effect.gen(function* () {
      class HandlerError extends Schema.TaggedErrorClass<HandlerError>()("HandlerError", {
        reason: Schema.String,
      }) {}

      const ErrActor = Actor.make("ErrActor", {
        Fail: {
          input: { input: Schema.String },
          error: HandlerError,
        },
      });

      const errHandlers = Actor.toLayer(ErrActor, {
        Fail: () => Effect.fail(new HandlerError({ reason: "bad" })),
      });

      const makeRef = yield* Actor.Test(ErrActor, errHandlers as unknown as Layer.Layer<never>);
      const ref = yield* makeRef("err-1");
      const exit = yield* ref.call(ErrActor.Fail({ input: "test" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  test("handler receives request with operation", () =>
    Effect.gen(function* () {
      let receivedOperation: unknown = null;

      const InspectActor = Actor.make("InspectActor", {
        Inspect: {
          input: { value: Schema.String },
          output: Schema.String,
        },
      });

      const inspectHandlers = Actor.toLayer(InspectActor, {
        Inspect: ({ operation }) => {
          receivedOperation = operation;
          return Effect.succeed(`got: ${operation.value}`);
        },
      });

      const makeRef = yield* Actor.Test(
        InspectActor,
        inspectHandlers as unknown as Layer.Layer<never>,
      );
      const ref = yield* makeRef("inspect-1");
      const result = yield* ref.call(InspectActor.Inspect({ value: "hello" }));
      expect(result).toBe("got: hello");
      expect(receivedOperation).toEqual({ _tag: "Inspect", value: "hello" });
    }));
});
