import type { Cause } from "effect";
import { Cause as CauseModule, Effect, Exit, Match, Option, Schema } from "effect";
import { Activity, DurableDeferred } from "effect/workflow";
import type { Workflow } from "effect/workflow";
import { WorkflowEngine, WorkflowInstance } from "effect/workflow/WorkflowEngine";

export type CompensationDecision = "Retry" | "Stop";

export const CompensationDecision = Schema.Literals(["Retry", "Stop"]);

export class PendingCompensation extends Schema.Class<PendingCompensation>(
  "effect-encore/PendingCompensation",
)({
  stepId: Schema.String,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

export class CompensationNotPendingError extends Schema.TaggedError<CompensationNotPendingError>()(
  "CompensationNotPendingError",
  {},
) {}

export class CompensationDecisionConflictError extends Schema.TaggedError<CompensationDecisionConflictError>()(
  "CompensationDecisionConflictError",
  {
    stepId: Schema.String,
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
    acceptedDecision: Schema.Option(CompensationDecision),
  },
) {}

export type CompensationDecisionError =
  | CompensationNotPendingError
  | CompensationDecisionConflictError;

const CompensationPlan = Schema.Array(Schema.String);
const compensationPlan = DurableDeferred.make("CompensationPlan", {
  success: CompensationPlan,
});

const encodeCompensationActivityName = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Literals(["Compensate"]), Schema.String])),
);

const encodeCompensationDecisionName = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Literals(["CompensationDecision"]), Schema.String, Schema.Finite]),
  ),
);

const encodeCompensationFailureName = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Literals(["CompensationFailure"]), Schema.String, Schema.Finite]),
  ),
);

const compensationActivityName = (stepId: string): string =>
  encodeCompensationActivityName(["Compensate", stepId]);

// Activity storage adds CurrentAttempt to its key. Durable Deferred storage
// does not. The decision name must carry the attempt.
const compensationDecision = (stepId: string, attempt: number) =>
  DurableDeferred.make(encodeCompensationDecisionName(["CompensationDecision", stepId, attempt]), {
    success: CompensationDecision,
  });

const compensationFailure = (stepId: string, attempt: number) =>
  DurableDeferred.make(encodeCompensationFailureName(["CompensationFailure", stepId, attempt]), {
    success: PendingCompensation,
  });

const readDeferredAt = <S extends Schema.Constraint>(
  workflow: Workflow.Any,
  executionId: string,
  deferred: DurableDeferred.DurableDeferred<S>,
): Effect.Effect<Option.Option<S["Type"]>, never, WorkflowEngine> =>
  WorkflowEngine.pipe(
    Effect.flatMap((engine) =>
      engine
        .deferredResult(deferred)
        .pipe(
          Effect.provideService(WorkflowInstance, WorkflowInstance.initial(workflow, executionId)),
        ),
    ),
    Effect.map(
      Option.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return Option.some(exit.value);
        return Option.none();
      }),
    ),
  );

const pendingForStep = (
  workflow: Workflow.Any,
  executionId: string,
  stepId: string,
  attempt: number,
): Effect.Effect<Option.Option<PendingCompensation>, never, WorkflowEngine> =>
  readDeferredAt(workflow, executionId, compensationFailure(stepId, attempt)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (pending) =>
          readDeferredAt(workflow, executionId, compensationDecision(stepId, attempt)).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedSome(pending),
                onSome: (decision) => {
                  if (decision === "Stop") return Effect.succeedNone;
                  return pendingForStep(workflow, executionId, stepId, attempt + 1);
                },
              }),
            ),
          ),
      }),
    ),
  );

/** Read the exact failed compensation attempt that awaits an operator decision. */
export const pendingCompensation = <
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  executionId: string,
): Effect.Effect<
  Option.Option<PendingCompensation>,
  never,
  WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  workflow.poll(executionId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (result) => {
          if (result._tag === "Complete") return Effect.succeedNone;
          return readDeferredAt(workflow, executionId, compensationPlan).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (plan) =>
                  Effect.reduce(
                    plan,
                    () => Option.none<PendingCompensation>(),
                    (pending, stepId) => {
                      if (Option.isSome(pending)) return Effect.succeed(pending);
                      return pendingForStep(workflow, executionId, stepId, 1);
                    },
                  ),
              }),
            ),
          );
        },
      }),
    ),
  );

const commitCompensationDecision = (
  workflow: Workflow.Any,
  executionId: string,
  stepId: string,
  attempt: number,
  decision: CompensationDecision,
): Effect.Effect<void, CompensationDecisionConflictError, WorkflowEngine> =>
  Effect.gen(function* () {
    const deferred = compensationDecision(stepId, attempt);
    const accepted = yield* readDeferredAt(workflow, executionId, deferred);
    if (Option.isSome(accepted)) {
      if (accepted.value === decision) return;
      return yield* CompensationDecisionConflictError.make({
        stepId,
        attempt,
        acceptedDecision: accepted,
      });
    }

    const token = DurableDeferred.tokenFromExecutionId(deferred, { workflow, executionId });
    yield* DurableDeferred.succeed(deferred, { token, value: decision });
    const awaitAccepted = (): Effect.Effect<CompensationDecision, never, WorkflowEngine> =>
      readDeferredAt(workflow, executionId, deferred).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(awaitAccepted))),
            onSome: Effect.succeed,
          }),
        ),
      );
    const winner = yield* awaitAccepted();
    if (winner === decision) return;
    return yield* CompensationDecisionConflictError.make({
      stepId,
      attempt,
      acceptedDecision: Option.some(winner),
    });
  });

export const decideCompensation = <
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  executionId: string,
  stepId: string,
  attempt: number,
  decision: CompensationDecision,
): Effect.Effect<
  void,
  CompensationDecisionError,
  WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.gen(function* () {
    const pending = yield* pendingCompensation(workflow, executionId);
    if (Option.isNone(pending)) {
      const accepted = yield* readDeferredAt(
        workflow,
        executionId,
        compensationDecision(stepId, attempt),
      );
      if (Option.isNone(accepted)) return yield* CompensationNotPendingError.make();
      if (accepted.value === decision) return;
      return yield* CompensationDecisionConflictError.make({
        stepId,
        attempt,
        acceptedDecision: accepted,
      });
    }
    if (pending.value.stepId !== stepId || pending.value.attempt !== attempt) {
      return yield* CompensationDecisionConflictError.make({
        stepId: pending.value.stepId,
        attempt: pending.value.attempt,
        acceptedDecision: Option.none(),
      });
    }
    return yield* commitCompensationDecision(workflow, executionId, stepId, attempt, decision);
  });

export const decidePendingCompensation = <
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  executionId: string,
  decision: CompensationDecision,
): Effect.Effect<
  void,
  CompensationDecisionError,
  WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.gen(function* () {
    const pending = yield* pendingCompensation(workflow, executionId);
    if (Option.isNone(pending)) return yield* CompensationNotPendingError.make();
    return yield* commitCompensationDecision(
      workflow,
      executionId,
      pending.value.stepId,
      pending.value.attempt,
      decision,
    );
  });

export const makeDurableCompensation = <
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  WorkflowError extends Schema.Top,
>(
  workflow: Workflow.Workflow<Name, Payload, Schema.Top, WorkflowError>,
  executionId: string,
) => {
  const compensations: Array<{
    readonly stepId: string;
    readonly run: (
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<
      void,
      never,
      | WorkflowEngine
      | WorkflowInstance
      | WorkflowError["DecodingServices"]
      | WorkflowError["EncodingServices"]
    >;
  }> = [];

  const run = <A>(
    stepId: string,
    value: A,
    workflowCause: Cause.Cause<WorkflowError["Type"]>,
    undo: (
      value: A,
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<void, WorkflowError["Type"]>,
    attempt: number,
  ): Effect.Effect<
    void,
    never,
    | WorkflowEngine
    | WorkflowInstance
    | WorkflowError["DecodingServices"]
    | WorkflowError["EncodingServices"]
  > => {
    const execute = undo(value, workflowCause).pipe(
      Effect.tapCause((cause) => {
        if (CauseModule.hasInterrupts(cause)) return Effect.void;
        return Effect.logError("Workflow compensation failed.", cause).pipe(
          Effect.annotateLogs({ executionId, stepId, attempt }),
        );
      }),
    );
    const activity = Activity.make({
      name: compensationActivityName(stepId),
      execute,
      error: workflow.errorSchema,
    }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt));

    return activity.pipe(
      Effect.catchCause((cause) => {
        if (CauseModule.hasInterrupts(cause)) {
          const interrupts = cause.reasons.filter(CauseModule.isInterruptReason);
          return Effect.failCause(CauseModule.fromReasons(interrupts));
        }
        const deferred = compensationDecision(stepId, attempt);
        const pending = PendingCompensation.make({ stepId, attempt });
        return DurableDeferred.into(
          Effect.succeed(pending),
          compensationFailure(stepId, attempt),
        ).pipe(
          Effect.andThen(DurableDeferred.await(deferred)),
          Effect.flatMap((decision) =>
            Match.value(decision).pipe(
              Match.when("Retry", () => run(stepId, value, workflowCause, undo, attempt + 1)),
              Match.when("Stop", () => Effect.void),
              Match.exhaustive,
            ),
          ),
        );
      }),
    );
  };

  const add = <A, E, R, R2>(
    stepId: string,
    activity: Effect.Effect<A, E, R>,
    undo: (
      value: A,
      cause: Cause.Cause<WorkflowError["Type"]>,
    ) => Effect.Effect<void, WorkflowError["Type"], R2>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R2>();
        const value = yield* restore(activity);
        compensations.push({
          stepId,
          run: (cause) =>
            run(
              stepId,
              value,
              cause,
              (result, workflowCause) => undo(result, workflowCause).pipe(Effect.provide(context)),
              1,
            ),
        });
        return value;
      }),
    );

  const compensate = (cause: Cause.Cause<WorkflowError["Type"]>) => {
    const plan = compensations.toReversed();
    return DurableDeferred.into(
      Effect.succeed(plan.map(({ stepId }) => stepId)),
      compensationPlan,
    ).pipe(Effect.andThen(Effect.forEach(plan, ({ run }) => run(cause), { discard: true })));
  };

  return { add, compensate };
};
