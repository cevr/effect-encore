import { expect, it } from "effect-bun-test";
import { Effect, Layer, Result, Schema } from "effect";
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

class CompensationError extends Schema.TaggedError<CompensationError>()("CompensationError", {
  message: Schema.String,
}) {}

const ClusterCompensation = Actor.fromWorkflow("ClusterCompensation", {
  payload: { id: Schema.String },
  error: CompensationError,
  id: ({ id }: { id: string }) => id,
});

const TestCluster = Layer.provideMerge(ClusterWorkflowEngine.layer, TestRunner.layer);

it.scopedLive("arbitrates compensation decisions through the cluster engine", () =>
  Effect.gen(function* () {
    let compensationAttempts = 0;
    const handlers = Actor.toLayer(ClusterCompensation, (_payload, step) =>
      Effect.gen(function* () {
        yield* step.run("registered", {
          do: Effect.void,
          undo: () =>
            Effect.suspend(() => {
              compensationAttempts++;
              if (compensationAttempts === 1) {
                return CompensationError.make({ message: "compensation failed" });
              }
              return Effect.void;
            }),
        });
        return yield* CompensationError.make({ message: "workflow failed" });
      }),
    ).pipe(Layer.provideMerge(TestCluster));

    yield* Effect.gen(function* () {
      const payload = { id: "cluster-decision" };
      const executionId = yield* ClusterCompensation.send(payload);
      yield* ClusterCompensation.waitFor(payload, {
        filter: (result) => result._tag === "Suspended",
      });

      const results = yield* Effect.all(
        [
          ClusterCompensation.compensation.decidePending(executionId, "Retry"),
          ClusterCompensation.compensation.decidePending(executionId, "Stop"),
        ].map(Effect.result),
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("5 seconds"));

      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure)).toHaveLength(1);
      for (const result of results) {
        if (Result.isFailure(result)) {
          expect(["CompensationNotPendingError", "CompensationDecisionConflictError"]).toContain(
            result.failure._tag,
          );
        }
      }
      expect((yield* ClusterCompensation.waitFor(payload))._tag).toBe("Failure");
      expect([1, 2]).toContain(compensationAttempts);
    }).pipe(Effect.provide(handlers));
  }),
);
