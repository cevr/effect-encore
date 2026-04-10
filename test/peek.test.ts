import { describe, expect, it } from "effect-bun-test";
import type { Layer } from "effect";
import { Effect, Schema } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import { Actor, makeCastReceipt, peek } from "../src/index.js";

class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

const PeekableActor = Actor.make("PeekableActor", {
  Process: {
    input: { input: Schema.String },
    output: Schema.String,
    persisted: true,
    primaryKey: (p: { input: string }) => p.input,
  },
  Fail: {
    input: { input: Schema.String },
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
      const receipt = makeCastReceipt({
        actorType: "PeekableActor",
        entityId: "e-1",
        operation: "Process",
        primaryKey: "nonexistent",
      });

      const result = yield* peek(PeekableActor, receipt);
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

      const receipt = makeCastReceipt({
        actorType: "PeekableActor",
        entityId: "e-2",
        operation: "Process",
        primaryKey: "hello",
      });

      const result = yield* peek(PeekableActor, receipt);
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

      const receipt = makeCastReceipt({
        actorType: "PeekableActor",
        entityId: "e-3",
        operation: "Fail",
        primaryKey: "bad",
      });

      const result = yield* peek(PeekableActor, receipt);
      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(peekableHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ),
  );

  it.scopedLive("dies with NoPrimaryKeyError for operations without primaryKey", () =>
    Effect.gen(function* () {
      const NoPkActor = Actor.make("NoPkActor", {
        Fire: {
          input: { x: Schema.Number },
          output: Schema.Number,
          persisted: true,
        },
      });

      const receipt = makeCastReceipt({
        actorType: "NoPkActor",
        entityId: "e-1",
        operation: "Fire",
        primaryKey: "fake-uuid",
      });

      const exit = yield* peek(NoPkActor, receipt).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(TestCluster)),
  );
});
