import { describe, expect, it } from "effect-bun-test";
import { Effect, Layer, Schema } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

const PeekableActor = Actor.fromEntity("PeekableActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
  Fail: {
    payload: { input: Schema.String },
    error: ProcessError,
    persisted: true,
    id: (p: { input: string }) => p.input,
  },
});

const peekableHandlers = Actor.toLayer(PeekableActor, {
  Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  Fail: () => Effect.fail(ProcessError.make({ message: "bad input" })),
});

const TestCluster = TestRunner.layer;
const peekableHandlersLayer = peekableHandlers.pipe(Layer.provideMerge(TestCluster));

describe("OperationHandle.peek", () => {
  it.scopedLive("returns Pending when handler has not completed", () =>
    Effect.gen(function* () {
      const result = yield* PeekableActor.Process.peek({ input: "nonexistent" });
      expect(result._tag).toBe("Pending");
    }).pipe(Effect.provide(peekableHandlersLayer)),
  );

  it.scopedLive("returns Success with decoded value when handler succeeds", () =>
    Effect.gen(function* () {
      // Seed via the lower-level cluster client to drive handler completion.
      const makeClient = yield* PeekableActor._meta.entity.client;
      const client = makeClient("hello");
      yield* client.Process({ input: "hello" });

      const result = yield* PeekableActor.Process.peek({ input: "hello" });
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.value).toBe("processed: hello");
      }
    }).pipe(Effect.provide(peekableHandlersLayer)),
  );

  it.scopedLive("returns Failure with decoded error when handler fails", () =>
    Effect.gen(function* () {
      const makeClient = yield* PeekableActor._meta.entity.client;
      const client = makeClient("bad");
      yield* client.Fail({ input: "bad" }).pipe(Effect.option);

      const result = yield* PeekableActor.Fail.peek({ input: "bad" });
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(peekableHandlersLayer)),
  );
});
