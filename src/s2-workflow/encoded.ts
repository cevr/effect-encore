import { Clock, Duration, Effect, Exit, Layer, Option, Ref, type Scope } from "effect";
import type * as Activity from "effect/unstable/workflow/Activity";
import type * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import type { DurableClock } from "effect/unstable/workflow/DurableClock";
import * as Workflow from "effect/unstable/workflow/Workflow";
import {
  makeUnsafe,
  WorkflowEngine,
  WorkflowInstance,
  type Encoded,
} from "effect/unstable/workflow/WorkflowEngine";
import type { S2WorkflowEngineConfig } from "./config.js";
import { defaultOwnerTtlMillis } from "./config.js";
import { foldExecution, type FoldedExecution } from "./fold.js";
import { normalizePrefix, workflowExecutionStream } from "./names.js";
import {
  decodeActivityExit,
  decodeDeferredExit,
  decodeWorkflowPayload,
  decodeWorkflowResult,
  encodeActivityExit,
  encodeDeferredExit,
  encodeWorkflowPayload,
  encodeWorkflowResult,
  type ActivityCompleted,
  type ClockScheduled,
  type DeferredCompleted,
  type ExecutionRecord,
  type OwnerClaimed,
  type WorkflowStarted,
} from "./records.js";
import { isSeqNumMismatch, makeStreams, type S2WorkflowEngineError } from "./stream.js";

interface RegisteredWorkflow {
  readonly workflow: Workflow.Any;
  readonly execute: Parameters<Encoded["register"]>[1];
  readonly scope: Scope.Scope;
}

type Registry = ReadonlyMap<string, RegisteredWorkflow>;

const workflowResultFromRecord = (
  workflow: Workflow.Any,
  record: FoldedExecution["result"],
): Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>> => {
  if (Option.isNone(record)) return Effect.succeedNone;
  return decodeWorkflowResult(workflow, record.value.result).pipe(Effect.map(Option.some));
};

const exitToEffect = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);

const eraseEffect = <A>(effect: unknown): Effect.Effect<A> => effect as Effect.Effect<A>;

export const makeEncoded = (
  config: S2WorkflowEngineConfig,
): Effect.Effect<Encoded, never, Scope.Scope> =>
  Effect.gen(function* () {
    const engineScope = yield* Effect.scope;
    const streams = yield* makeStreams(config);
    const prefix = normalizePrefix(config.streamPrefix);
    const registry = yield* Ref.make<Registry>(new Map());
    const ownerCounter = yield* Ref.make(0);
    const activeOwners = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const ownerTtlMillis = config.ownerTtlMillis ?? defaultOwnerTtlMillis;
    let engine: WorkflowEngine["Service"];

    const streamName = (workflow: Workflow.Any, executionId: string): string =>
      workflowExecutionStream(prefix, workflow._tag, executionId);

    const readFolded = (
      workflow: Workflow.Any,
      executionId: string,
    ): Effect.Effect<FoldedExecution, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const read = yield* streams.read(streamName(workflow, executionId));
        return foldExecution(read.records, now, read.tailSeqNum);
      });

    const appendRecords = (
      workflow: Workflow.Any,
      executionId: string,
      records: ReadonlyArray<ExecutionRecord>,
      options?: { readonly matchSeqNum?: number },
    ): Effect.Effect<void, S2WorkflowEngineError> =>
      streams.append(streamName(workflow, executionId), records, options);

    const ensureStarted = (
      workflow: Workflow.Any,
      options: {
        readonly executionId: string;
        readonly payload: object;
        readonly parent?: WorkflowInstance["Service"] | undefined;
      },
    ): Effect.Effect<WorkflowStarted, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const folded = yield* readFolded(workflow, options.executionId);
        if (Option.isSome(folded.started)) return folded.started.value;
        const now = yield* Clock.currentTimeMillis;
        const payload = yield* encodeWorkflowPayload(workflow, options.payload);
        const record: WorkflowStarted = {
          _tag: "WorkflowStarted",
          schemaVersion: 1,
          workflowName: workflow._tag,
          executionId: options.executionId,
          parentWorkflowName: options.parent?.workflow._tag,
          parentExecutionId: options.parent?.executionId,
          payload,
          createdAtMillis: now,
        };
        return yield* appendRecords(workflow, options.executionId, [record], {
          matchSeqNum: folded.tailSeqNum,
        }).pipe(
          Effect.as(record),
          Effect.catch((error) =>
            isSeqNumMismatch(error) ? ensureStarted(workflow, options) : Effect.fail(error),
          ),
        );
      });

    const nextOwnerEpoch = Effect.gen(function* () {
      const count = yield* Ref.updateAndGet(ownerCounter, (n) => n + 1);
      const now = yield* Clock.currentTimeMillis;
      return `${config.runnerId}-${now}-${count}`;
    });

    const claimExecution = (
      workflow: Workflow.Any,
      executionId: string,
    ): Effect.Effect<Option.Option<string>, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const folded = yield* readFolded(workflow, executionId);
        if (Option.isSome(folded.owner) && folded.owner.value.runnerId !== config.runnerId) {
          return Option.none();
        }
        const now = yield* Clock.currentTimeMillis;
        const ownerEpoch = yield* nextOwnerEpoch;
        const record: OwnerClaimed = {
          _tag: "OwnerClaimed",
          schemaVersion: 1,
          ownerEpoch,
          runnerId: config.runnerId,
          claimedAtMillis: now,
          expiresAtMillis: now + ownerTtlMillis,
        };
        return yield* appendRecords(workflow, executionId, [record], {
          matchSeqNum: folded.tailSeqNum,
        }).pipe(
          Effect.as(Option.some(ownerEpoch)),
          Effect.catch((error) =>
            isSeqNumMismatch(error) ? claimExecution(workflow, executionId) : Effect.fail(error),
          ),
        );
      });

    const heartbeat = (
      workflow: Workflow.Any,
      executionId: string,
      ownerEpoch: string,
      alive: Ref.Ref<boolean>,
    ): Effect.Effect<void, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const folded = yield* readFolded(workflow, executionId);
        if (Option.isSome(folded.owner) && folded.owner.value.ownerEpoch !== ownerEpoch) {
          yield* Ref.set(alive, false);
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const record: OwnerClaimed = {
          _tag: "OwnerClaimed",
          schemaVersion: 1,
          ownerEpoch,
          runnerId: config.runnerId,
          claimedAtMillis: now,
          expiresAtMillis: now + ownerTtlMillis,
        };
        yield* appendRecords(workflow, executionId, [record], {
          matchSeqNum: folded.tailSeqNum,
        }).pipe(
          Effect.catch((error) =>
            isSeqNumMismatch(error)
              ? heartbeat(workflow, executionId, ownerEpoch, alive)
              : Effect.fail(error),
          ),
        );
      });

    const startHeartbeat = (
      workflow: Workflow.Any,
      executionId: string,
      ownerEpoch: string,
      alive: Ref.Ref<boolean>,
    ): Effect.Effect<void> => {
      const interval = Duration.millis(Math.max(50, Math.floor(ownerTtlMillis / 3)));
      const loop: Effect.Effect<void> = Effect.gen(function* () {
        yield* Effect.sleep(interval);
        const keepRunning = yield* Ref.get(alive);
        if (!keepRunning) return;
        yield* heartbeat(workflow, executionId, ownerEpoch, alive).pipe(Effect.orDie);
        return yield* loop;
      });
      return loop.pipe(Effect.forkIn(engineScope), Effect.asVoid);
    };

    const ownerStillActive = (
      workflow: Workflow.Any,
      executionId: string,
      ownerEpoch: string,
    ): Effect.Effect<boolean, S2WorkflowEngineError> =>
      readFolded(workflow, executionId).pipe(
        Effect.map(
          (folded) => Option.isSome(folded.owner) && folded.owner.value.ownerEpoch === ownerEpoch,
        ),
      );

    const appendResult = (
      workflow: Workflow.Any,
      executionId: string,
      ownerEpoch: string,
      result: Workflow.Result<unknown, unknown>,
    ): Effect.Effect<Workflow.Result<unknown, unknown>, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const folded = yield* readFolded(workflow, executionId);
        const existing = yield* workflowResultFromRecord(workflow, folded.result);
        if (Option.isSome(existing) && existing.value._tag === "Complete") {
          return existing.value;
        }
        if (Option.isNone(folded.owner) || folded.owner.value.ownerEpoch !== ownerEpoch) {
          return new Workflow.Suspended({});
        }
        const now = yield* Clock.currentTimeMillis;
        const encoded = yield* encodeWorkflowResult(workflow, result);
        const record: ExecutionRecord =
          result._tag === "Complete"
            ? {
                _tag: "WorkflowCompleted",
                schemaVersion: 1,
                ownerEpoch,
                result: encoded,
                createdAtMillis: now,
              }
            : {
                _tag: "WorkflowSuspended",
                schemaVersion: 1,
                ownerEpoch,
                result: encoded,
                createdAtMillis: now,
              };
        return yield* appendRecords(workflow, executionId, [record], {
          matchSeqNum: folded.tailSeqNum,
        }).pipe(
          Effect.as(result),
          Effect.catch((error) =>
            isSeqNumMismatch(error)
              ? appendResult(workflow, executionId, ownerEpoch, result)
              : Effect.fail(error),
          ),
        );
      });

    const completeDueClocks = (
      workflow: Workflow.Any,
      executionId: string,
    ): Effect.Effect<void, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const folded = yield* readFolded(workflow, executionId);
        const now = yield* Clock.currentTimeMillis;
        for (const clock of folded.clocks.values()) {
          if (clock.wakeAtMillis <= now && !folded.deferreds.has(clock.deferredName)) {
            yield* appendDeferred(workflow._tag, executionId, clock.deferredName, Exit.void);
          }
        }
      });

    const runTurn = (
      workflow: Workflow.Any,
      executionId: string,
      ownerEpoch: string,
    ): Effect.Effect<Workflow.Result<unknown, unknown>, S2WorkflowEngineError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const entry = yield* Ref.get(registry).pipe(
            Effect.flatMap((map) => {
              const registered = map.get(workflow._tag);
              return registered === undefined
                ? Effect.die(`Workflow ${workflow._tag} is not registered`)
                : Effect.succeed(registered);
            }),
          );
          yield* completeDueClocks(workflow, executionId);
          const folded = yield* readFolded(workflow, executionId);
          if (Option.isNone(folded.started)) {
            return yield* Effect.die(`Workflow ${workflow._tag}/${executionId} has not started`);
          }
          const payload = yield* decodeWorkflowPayload(workflow, folded.started.value.payload);
          const alive = yield* Ref.make(true);
          yield* startHeartbeat(workflow, executionId, ownerEpoch, alive);
          yield* Ref.update(activeOwners, (current) => {
            const next = new Map(current);
            next.set(executionId, ownerEpoch);
            return next;
          });
          yield* Effect.addFinalizer(() =>
            Ref.set(alive, false).pipe(
              Effect.andThen(
                Ref.update(activeOwners, (current) => {
                  const next = new Map(current);
                  next.delete(executionId);
                  return next;
                }),
              ),
            ),
          );
          const instance = WorkflowInstance.initial(workflow, executionId);
          instance.interrupted = folded.interrupted;
          const executeWorkflow = entry.execute as unknown as (
            payload: object,
            executionId: string,
          ) => Effect.Effect<unknown>;
          const result = yield* executeWorkflow(payload, executionId).pipe(
            Workflow.intoResult,
            Effect.provideService(WorkflowInstance, instance),
            Effect.provideService(WorkflowEngine, engine),
          );
          const stillAlive = yield* Ref.get(alive);
          if (!stillAlive) return new Workflow.Suspended({});
          const committed = yield* appendResult(workflow, executionId, ownerEpoch, result);
          if (
            folded.started.value.parentWorkflowName !== undefined &&
            folded.started.value.parentExecutionId !== undefined &&
            committed._tag === "Complete"
          ) {
            yield* resumeByName(
              folded.started.value.parentWorkflowName,
              folded.started.value.parentExecutionId,
            );
          }
          return committed;
        }),
      );

    const executeInternal = <const Discard extends boolean>(
      workflow: Workflow.Any,
      options: {
        readonly executionId: string;
        readonly payload: object;
        readonly discard: Discard;
        readonly parent?: WorkflowInstance["Service"] | undefined;
      },
    ): Effect.Effect<
      Discard extends true ? void : Workflow.Result<unknown, unknown>,
      S2WorkflowEngineError
    > =>
      Effect.gen(function* () {
        yield* ensureStarted(workflow, options);
        if (options.discard) {
          return undefined as Discard extends true ? void : Workflow.Result<unknown, unknown>;
        }
        yield* completeDueClocks(workflow, options.executionId);
        const folded = yield* readFolded(workflow, options.executionId);
        const cached = yield* workflowResultFromRecord(workflow, folded.result);
        if (Option.isSome(cached) && cached.value._tag === "Complete") {
          return cached.value as Discard extends true ? void : Workflow.Result<unknown, unknown>;
        }
        const claimed = yield* claimExecution(workflow, options.executionId);
        if (Option.isNone(claimed)) {
          return new Workflow.Suspended({}) as Discard extends true
            ? void
            : Workflow.Result<unknown, unknown>;
        }
        const result = yield* runTurn(workflow, options.executionId, claimed.value);
        return result as Discard extends true ? void : Workflow.Result<unknown, unknown>;
      });

    const pollInternal = (
      workflow: Workflow.Any,
      executionId: string,
    ): Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>, S2WorkflowEngineError> =>
      readFolded(workflow, executionId).pipe(
        Effect.flatMap((folded) => workflowResultFromRecord(workflow, folded.result)),
      );

    const resumeByName = (
      workflowName: string,
      executionId: string,
    ): Effect.Effect<void, S2WorkflowEngineError> =>
      Ref.get(registry).pipe(
        Effect.flatMap((map) => {
          const registered = map.get(workflowName);
          if (registered === undefined) return Effect.void;
          return executeInternal(registered.workflow, {
            executionId,
            payload: {},
            discard: false,
          }).pipe(Effect.asVoid);
        }),
      );

    const appendDeferred = (
      workflowName: string,
      executionId: string,
      deferredName: string,
      exit: Exit.Exit<unknown, unknown>,
    ): Effect.Effect<void, S2WorkflowEngineError> =>
      Effect.gen(function* () {
        const registered = yield* Ref.get(registry).pipe(
          Effect.map((map) => map.get(workflowName)),
        );
        if (registered === undefined) return;
        const folded = yield* readFolded(registered.workflow, executionId);
        if (folded.deferreds.has(deferredName)) return;
        const now = yield* Clock.currentTimeMillis;
        const encodedExit = yield* encodeDeferredExit(exit);
        const record: DeferredCompleted = {
          _tag: "DeferredCompleted",
          schemaVersion: 1,
          deferredName,
          exit: encodedExit,
          createdAtMillis: now,
        };
        yield* appendRecords(registered.workflow, executionId, [record]);
      });

    const encoded: Encoded = {
      register: (workflow, execute) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* Ref.update(registry, (current) => {
            const next = new Map(current);
            next.set(workflow._tag, { workflow, execute, scope });
            return next;
          });
          yield* Effect.addFinalizer(() =>
            Ref.update(registry, (current) => {
              const next = new Map(current);
              next.delete(workflow._tag);
              return next;
            }),
          );
        }),
      execute: (workflow, options) => executeInternal(workflow, options).pipe(Effect.orDie),
      poll: (workflow, executionId) => pollInternal(workflow, executionId).pipe(Effect.orDie),
      interrupt: (workflow, executionId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* appendRecords(workflow, executionId, [
            {
              _tag: "WorkflowInterrupted",
              schemaVersion: 1,
              unsafe: false,
              createdAtMillis: now,
            },
          ]);
          yield* resumeByName(workflow._tag, executionId);
        }).pipe(Effect.orDie),
      interruptUnsafe: (workflow, executionId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* appendRecords(workflow, executionId, [
            {
              _tag: "WorkflowInterrupted",
              schemaVersion: 1,
              unsafe: true,
              createdAtMillis: now,
            },
          ]);
          yield* resumeByName(workflow._tag, executionId);
        }).pipe(Effect.orDie),
      resume: (workflow, executionId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* appendRecords(workflow, executionId, [
            { _tag: "WorkflowResumed", schemaVersion: 1, createdAtMillis: now },
          ]);
          yield* resumeByName(workflow._tag, executionId);
        }).pipe(Effect.orDie),
      activityExecute: (activity: Activity.Any, attempt: number) =>
        Effect.gen(function* () {
          const instance = yield* WorkflowInstance;
          const activityId = `${instance.executionId}/${activity.name}/${attempt}`;
          const folded = yield* readFolded(instance.workflow, instance.executionId);
          const existing = folded.activities.get(activityId);
          if (existing !== undefined) {
            const decoded = yield* decodeActivityExit(existing.exit);
            if (Exit.isSuccess(decoded) && decoded.value._tag === "Suspended") {
              // rerun suspended activities just like the upstream in-memory engine
            } else {
              return yield* exitToEffect(decoded);
            }
          }
          const activityInstance = WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          );
          activityInstance.interrupted = instance.interrupted;
          const rawActivity = activity as unknown as { readonly executeEncoded: unknown };
          const executeActivity = eraseEffect<unknown>(rawActivity.executeEncoded);
          const resultExit = yield* Effect.exit(
            executeActivity.pipe(
              Workflow.intoResult,
              Effect.provideService(WorkflowInstance, activityInstance),
              Effect.provideService(WorkflowEngine, engine),
            ),
          );
          const ownerEpoch = yield* Ref.get(activeOwners).pipe(
            Effect.map((map) => map.get(instance.executionId)),
          );
          if (ownerEpoch === undefined) {
            return yield* exitToEffect(resultExit);
          }
          const stillOwner = yield* ownerStillActive(
            instance.workflow,
            instance.executionId,
            ownerEpoch,
          );
          if (!stillOwner) return new Workflow.Suspended({});
          const now = yield* Clock.currentTimeMillis;
          const encodedExit = yield* encodeActivityExit(resultExit);
          const record: ActivityCompleted = {
            _tag: "ActivityCompleted",
            schemaVersion: 1,
            ownerEpoch,
            activityId,
            exit: encodedExit,
            createdAtMillis: now,
          };
          const commitActivity: Effect.Effect<void, S2WorkflowEngineError> = Effect.gen(
            function* () {
              const latest = yield* readFolded(instance.workflow, instance.executionId);
              if (latest.activities.has(activityId)) return;
              if (Option.isNone(latest.owner) || latest.owner.value.ownerEpoch !== ownerEpoch) {
                return;
              }
              yield* appendRecords(instance.workflow, instance.executionId, [record], {
                matchSeqNum: latest.tailSeqNum,
              }).pipe(
                Effect.catch((error) =>
                  isSeqNumMismatch(error) ? commitActivity : Effect.fail(error),
                ),
              );
            },
          );
          yield* commitActivity;
          return yield* exitToEffect(resultExit);
        }).pipe(Effect.orDie),
      deferredResult: (deferred: DurableDeferred.Any) =>
        Effect.gen(function* () {
          const instance = yield* WorkflowInstance;
          const folded = yield* readFolded(instance.workflow, instance.executionId);
          const record = folded.deferreds.get(deferred.name);
          if (record === undefined) return Option.none<Exit.Exit<unknown, unknown>>();
          const exit = yield* decodeDeferredExit(record.exit);
          return Option.some(exit);
        }).pipe(Effect.orDie),
      deferredDone: (options) =>
        appendDeferred(
          options.workflowName,
          options.executionId,
          options.deferredName,
          options.exit,
        ).pipe(
          Effect.andThen(resumeByName(options.workflowName, options.executionId)),
          Effect.orDie,
        ),
      scheduleClock: (
        workflow,
        options: { readonly executionId: string; readonly clock: DurableClock },
      ) =>
        Effect.gen(function* () {
          const folded = yield* readFolded(workflow, options.executionId);
          if (folded.clocks.has(options.clock.name)) return;
          const now = yield* Clock.currentTimeMillis;
          const wakeAtMillis = now + Duration.toMillis(options.clock.duration);
          const record: ClockScheduled = {
            _tag: "ClockScheduled",
            schemaVersion: 1,
            clockName: options.clock.name,
            deferredName: options.clock.deferred.name,
            wakeAtMillis,
            createdAtMillis: now,
          };
          yield* appendRecords(workflow, options.executionId, [record]);
          if (wakeAtMillis <= now) {
            yield* appendDeferred(
              workflow._tag,
              options.executionId,
              options.clock.deferred.name,
              Exit.void,
            );
          }
        }).pipe(Effect.orDie),
    };

    engine = makeUnsafe(encoded);
    return encoded;
  });

export const layer = (config: S2WorkflowEngineConfig): Layer.Layer<WorkflowEngine> =>
  Layer.effect(WorkflowEngine, makeEncoded(config).pipe(Effect.map(makeUnsafe)));
