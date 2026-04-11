import { describe, expect, it } from "effect-bun-test";
import type { Layer } from "effect";
import { Effect, Schema } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import { Actor, makeExecId } from "../src/index.js";

class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

const PeekableActor = Actor.fromEntity("PeekableActor", {
  Process: {
    payload: { input: Schema.String },
    success: Schema.String,
    persisted: true,
    primaryKey: (p: { input: string }) => p.input,
  },
  Fail: {
    payload: { input: Schema.String },
    error: ProcessError,
    persisted: true,
    primaryKey: (p: { input: string }) => p.input,
  },
});

const peekableHandlers = Actor.toLayer(PeekableActor, {
  Process: ({ operation }) => Effect.succeed(`processed: ${operation.input}`),
  Fail: () => Effect.fail(new ProcessError({ message: "bad input" })),
});

const TestCluster = TestRunner.layer;

describe("Actor.peek", () => {
  it.scopedLive("returns Pending when handler has not completed", () =>
    Effect.gen(function* () {
      const execId = makeExecId("e-1:Process:nonexistent");
      const result = yield* PeekableActor.peek(execId);
      expect(result._tag).toBe("Pending");
    }).pipe(
      Effect.provide(peekableHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ),
  );

  it.scopedLive("returns Success with decoded value when handler succeeds", () =>
    Effect.gen(function* () {
      const makeClient = yield* PeekableActor._meta.entity.client;
      const client = makeClient("e-2");
      yield* client.Process({ input: "hello" });

      const execId = makeExecId("e-2:Process:hello");
      const result = yield* PeekableActor.peek(execId);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.value).toBe("processed: hello");
      }
    }).pipe(
      Effect.provide(peekableHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ),
  );

  it.scopedLive("returns Failure with decoded error when handler fails", () =>
    Effect.gen(function* () {
      const makeClient = yield* PeekableActor._meta.entity.client;
      const client = makeClient("e-3");
      yield* client.Fail({ input: "bad" }).pipe(Effect.option);

      const execId = makeExecId("e-3:Fail:bad");
      const result = yield* PeekableActor.peek(execId);
      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(peekableHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ),
  );
});
