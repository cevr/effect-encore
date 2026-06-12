import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"
import type { Scope } from "effect"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Match, Option } from "effect"
import type { DurableTableError } from "../../durable-operators/index.ts"
import { stampRowOtel, withRowOtelParent } from "../../otel/row-otel.ts"
import { annotateActivityContractSpan } from "./contract-activity.ts"
import { encodeWorkflowResult, reviveEncodedResult, reviveExit } from "./codec.ts"
import type {
  WorkflowActivityClaimRow,
  WorkflowClockWakeupRow,
  WorkflowEngineTableService,
  WorkflowExecutionRow,
} from "./table.ts"

const orDieTable = <A>(
  effect: Effect.Effect<A, DurableTableError>,
): Effect.Effect<A> =>
  // workflow-engine-durable-state.ENGINE.5
  // workflow-engine-durable-state.RUNTIME_BOUNDARY.4
  // eslint-disable-next-line no-restricted-syntax -- workflow engine adapter exposes upstream WorkflowEngine APIs, which cannot carry table errors.
  Effect.orDie(effect)

const runtimeContextExecutionPrefix = "runtime-context:"

const contextIdFromWorkflowExecutionId = (executionId: string): string | undefined =>
  executionId.startsWith(runtimeContextExecutionPrefix)
    ? executionId.slice(runtimeContextExecutionPrefix.length)
    : undefined

const annotateWorkflowExecutionSpans =
  (executionId: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const contextId = contextIdFromWorkflowExecutionId(executionId)
    return contextId === undefined
      ? self
      : self.pipe(Effect.annotateSpans("firegrid.context.id", contextId))
  }

export const makeWorkflowEngine = (
  table: WorkflowEngineTableService,
  workerId: string,
  // v4: service value-type accessor `Tag["Type"]` → `Tag["Service"]`.
): Effect.Effect<WorkflowEngine.WorkflowEngine["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const engineScope = yield* Effect.scope
    const workflows = new Map<string, {
      workflow: Workflow.Any
      execute: (
        payload: object,
        executionId: string,
      ) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>
      scope: Scope.Scope
    }>()
    const running = new Map<string, {
      // v4: `Fiber.RuntimeFiber<A, E>` → `Fiber.Fiber<A, E>`; service value-type
      // accessor `["Type"]` → `["Service"]`.
      fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>, never>
      instance: WorkflowEngine.WorkflowInstance["Service"]
    }>()

    const claimActivity = (row: WorkflowActivityClaimRow) =>
      table.activityClaims.insertOrGet(row).pipe(
        // workflow-engine-durable-state.VALIDATION.6
        // workflow-engine-durable-state.RUNTIME_BOUNDARY.5
        // firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.1
        // firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.2
        // firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.3
        Effect.map(result =>
          Match.value(result).pipe(
            Match.tag("Inserted", () => row),
            Match.tag("Found", ({ row: existing }) => existing),
            Match.exhaustive,
          ),
        ),
        Effect.tap((claim) =>
          Effect.annotateCurrentSpan({
            "firegrid.workflow.activity.claim_worker_id": claim.workerId,
            "firegrid.workflow.activity.claim_owned": claim.workerId === workerId,
          })),
        Effect.withSpan("firegrid.workflow_engine.activity.claim", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": row.executionId,
            "firegrid.workflow.activity.name": row.activityName,
            "firegrid.workflow.activity.attempt": row.attempt,
            "firegrid.workflow.worker_id": workerId,
            // Seam contract (runtime-shrink contract-coverage, tf-mmh2): worker
            // exclusivity — exactly one durable claim per execution/activity/attempt
            // so the body runs once for the claimed attempt
            // (workflow-engine-durable-state.VALIDATION.6, RUNTIME_BOUNDARY.5-6).
            "firegrid.seam.kind": "concurrency",
            "firegrid.contract.id": "features/firegrid/workflow-engine-durable-state.feature.yaml",
          },
        }),
        annotateWorkflowExecutionSpans(row.executionId),
      )

    const fireClockWakeup = (row: WorkflowClockWakeupRow) =>
      Effect.gen(function*() {
        const current = yield* orDieTable(table.clockWakeups.get(row.clockKey).pipe(
          Effect.map(Option.getOrUndefined),
        ))
        if (!current || current.status !== "pending") return
        yield* orDieTable(table.clockWakeups.upsert({
          ...current,
          status: "fired",
        }))
        yield* engine.deferredDone(DurableDeferred.make(current.deferredName), {
          workflowName: current.workflowName,
          executionId: current.executionId,
          deferredName: current.deferredName,
          exit: Exit.void,
        })
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.clock.fire", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": row.executionId,
            "firegrid.workflow.name": row.workflowName,
            "firegrid.workflow.clock.name": row.clockName,
          },
        }),
        annotateWorkflowExecutionSpans(row.executionId),
      )

    const scheduleClockWakeup = (row: WorkflowClockWakeupRow) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis
        yield* fireClockWakeup(row).pipe(
          Effect.delay(Duration.millis(Math.max(0, row.deadlineMs - nowMs))),
          Effect.forkIn(engineScope),
          Effect.asVoid,
        )
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.clock.schedule_wakeup", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": row.executionId,
            "firegrid.workflow.name": row.workflowName,
            "firegrid.workflow.clock.name": row.clockName,
            "firegrid.workflow.clock.deadline_ms": row.deadlineMs,
          },
        }),
        annotateWorkflowExecutionSpans(row.executionId),
      )

    const recoverPendingClockWakeups = Effect.gen(function* () {
      const pending = yield* orDieTable(table.clockWakeups.query((coll) =>
        coll.toArray.filter(row => row.status === "pending"),
      ))
      let index = 0
      while (index < pending.length) {
        const row = pending[index]!
        yield* scheduleClockWakeup(row)
        index += 1
      }
    })

    const isExecutionInterrupted = (executionId: string) =>
      orDieTable(table.executions.get(executionId).pipe(
        Effect.map(row => Option.getOrUndefined(row)?.interrupted === true),
      ))

    const getExecutionRow = (
      executionId: string,
    ): Effect.Effect<WorkflowExecutionRow | undefined> =>
      orDieTable(table.executions.get(executionId).pipe(
        Effect.map(Option.getOrUndefined),
      ))

    const currentWorkflowInstanceWithSpanAnnotations = Effect.gen(function*() {
      const instance = yield* WorkflowEngine.WorkflowInstance
      yield* Effect.annotateCurrentSpan({
        "firegrid.workflow.execution_id": instance.executionId,
        "firegrid.workflow.name": instance.workflow.name,
      })
      return instance
    })

    const resume = (executionId: string) =>
      Effect.gen(function*() {
        const row = yield* getExecutionRow(executionId)
        if (!row || row.finalResult !== undefined) return
        const entry = workflows.get(row.workflowName)
        if (!entry) return
        // v4: `Fiber.unsafePoll()` → `Fiber.pollUnsafe()`.
        const current = running.get(executionId)?.fiber.pollUnsafe()
        if (!current) {
          if (running.has(executionId)) return
        } else if (current._tag === "Success" && current.value._tag !== "Suspended") {
          return
        }

        const instance = WorkflowEngine.WorkflowInstance.initial(entry.workflow, executionId)
        Object.assign(instance, { interrupted: row.interrupted, cause: row.cause as typeof instance.cause })

        const executeEffect: Effect.Effect<
          unknown,
          unknown,
          WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
        > = row.interrupted
          ? Effect.interrupt
          : entry.execute(row.payload as object, executionId)

        const fiber = yield* executeEffect.pipe(
          Effect.onExit(() => {
            if (!instance.interrupted) return Effect.void
            instance.suspended = false
            // v4: `Effect.withFiberRuntime` → `Effect.withFiber`; the callback's
            // fiber is typed `Fiber.Fiber<unknown, unknown>`.
            return Effect.withFiber((fiber) =>
              Effect.interruptible(Fiber.interrupt(fiber)))
          }),
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          Effect.tap(result =>
            Effect.gen(function* () {
              const latest = (yield* getExecutionRow(executionId)) ?? row
              const finalResult = result._tag === "Complete"
                ? yield* encodeWorkflowResult(entry.workflow, result)
                : undefined
              yield* orDieTable(table.executions.upsert({
                ...latest,
                interrupted: instance.interrupted,
                suspended: result._tag === "Suspended", ...(result._tag === "Suspended" && result.cause !== undefined ? { cause: result.cause } : {}),
                ...(finalResult !== undefined ? { finalResult } : {}),
              }))
            }),
          ),
          Effect.forkIn(entry.scope),
          Effect.withSpan("firegrid.workflow_engine.execution.resume.body", {
            kind: "consumer",
            attributes: {
              "firegrid.workflow.execution_id": executionId,
              "firegrid.workflow.name": row.workflowName,
            },
          }),
          // Parent the resumed workflow body (and the deferred fork beneath it)
          // back to whoever first wrote the execution row via `engine.execute`.
          // Row-scoped — runs inside the gen so `row` is in scope.
          withRowOtelParent(row),
        )
        running.set(executionId, { fiber, instance })
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.execution.resume", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": executionId,
          },
        }),
        annotateWorkflowExecutionSpans(executionId),
      )

    // Shared interrupt implementation for both the `interrupt` and (v4-new)
    // `interruptUnsafe` engine methods. Marks the execution row interrupted,
    // signals the in-flight fiber, then re-drives `resume` so the body winds
    // down deterministically. Behavior is identical to the v3 `interrupt`.
    const interruptExecution = (_workflow: Workflow.Any, executionId: string) =>
      Effect.gen(function* () {
        const row = yield* getExecutionRow(executionId)
        if (!row) return
        yield* orDieTable(table.executions.upsert({ ...row, interrupted: true }))
        const current = running.get(executionId)
        if (current !== undefined) {
          current.instance.interrupted = true
          yield* Fiber.interrupt(current.fiber).pipe(Effect.ignore)
        }
        yield* resume(executionId)
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.execution.interrupt", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.execution_id": executionId,
            "firegrid.workflow.name": _workflow.name,
          },
        }),
        annotateWorkflowExecutionSpans(executionId),
      )

    // tf-8f6y — KIND-AWARE non-clock `DurableDeferred` restart-recovery. The
    // sibling of `recoverPendingClockWakeups`: where the clock sweep re-arms
    // pending clock waits, this sweeps the engine's own `deferreds` table (the
    // persisted `DurableDeferred` results, written by `deferredDone`) and
    // re-drives EXACTLY the executions whose deferred-wait lost its resume to a
    // restart — a body that parked on a `DurableDeferred`, whose result row was
    // written, but which was never resumed because the in-process `resume` was
    // lost.
    //
    // It deliberately re-arms ONLY executions that (a) still exist, (b) are
    // suspended, (c) have not completed, and (d) are NOT interrupted — it does
    // NOT touch interrupts or non-deferred suspensions. This is the typed,
    // precise discrimination the canon requires; the blanket "resume all
    // suspended" sweep was falsified unsafe (it cannot distinguish deferred
    // waits from interrupts and corrupts terminality/idempotency).
    //
    // Hooked at `register` (below) rather than at construction-time startup
    // recovery (`recoverPendingClockWakeups`) because `resume` requires the
    // owning workflow to be registered, and the construction recovery runs
    // before any workflow layer has registered. Re-arming at registration is
    // the engine-owned point where the workflow is first available.
    const recoverPendingDeferreds = (workflowName: string) =>
      Effect.gen(function* () {
        const deferredRows = yield* orDieTable(table.deferreds.query((coll) =>
          coll.toArray.filter(row => row.workflowName === workflowName),
        ))
        const seen = new Set<string>()
        let index = 0
        while (index < deferredRows.length) {
          const row = deferredRows[index]!
          index += 1
          if (seen.has(row.executionId)) continue
          seen.add(row.executionId)
          const exec = yield* getExecutionRow(row.executionId)
          if (
            exec === undefined ||
            exec.finalResult !== undefined ||
            exec.interrupted ||
            !exec.suspended
          ) continue
          // The body re-drives and `DurableDeferred.await` re-reads the
          // persisted result via `deferredResult`, then continues to completion.
          yield* resume(row.executionId)
        }
      }).pipe(
        Effect.withSpan("firegrid.workflow_engine.recover_pending_deferreds", {
          kind: "internal",
          attributes: {
            "firegrid.workflow.name": workflowName,
          },
        }),
      )

    const engine = WorkflowEngine.makeUnsafe({
      register: (workflow, execute) =>
        Effect.gen(function*() {
          workflows.set(workflow.name, {
            workflow,
            execute,
            scope: yield* Effect.scope,
          })
          // Re-arm this workflow's deferred-waits whose resume was lost to a
          // restart (see `recoverPendingDeferreds`). `resume` forks each body,
          // so this does not block registration on body completion.
          yield* recoverPendingDeferreds(workflow.name)
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.workflow.register", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.name": workflow.name,
            },
          }),
        ),
      execute: (workflow, options) =>
        Effect.gen(function*() {
          const existing = yield* getExecutionRow(options.executionId)
          if (existing?.finalResult !== undefined) {
            // v4: `Schema.encode` no longer strips the runtime `Exit` wrapper
            // (`_id:"Exit"`), so a Schema decode of the JSON-persisted result
            // fails at `["exit"]`. Use the tolerant manual reviver — the same
            // path the activity-result read already uses (reviveEncodedResult
            // below) — which reconstructs the Exit from the persisted shape.
            return reviveEncodedResult(existing.finalResult) as never
          }
          if (!existing) {
            // Stamp the caller's trace context onto the execution row so a
            // later `resume` (possibly on a different host generation) can
            // parent the workflow body span back to whoever invoked execute.
            const stamped = yield* stampRowOtel({
              executionId: options.executionId,
              workflowName: workflow.name,
              payload: options.payload,
              parentExecutionId: options.parent?.executionId,
              interrupted: false,
              suspended: false,
            })
            yield* orDieTable(table.executions.upsert(stamped))
          }
          yield* resume(options.executionId)
          const fiber = running.get(options.executionId)?.fiber
          if (options.discard) {
            if (fiber) yield* Fiber.join(fiber)
            return undefined as never
          }
          if (fiber) return (yield* Fiber.join(fiber)) as never
          const afterResume = yield* getExecutionRow(options.executionId)
          if (afterResume?.finalResult !== undefined) {
            return reviveEncodedResult(afterResume.finalResult) as never
          }
          return new Workflow.Suspended({}) as never
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.execution.execute", {
            kind: "producer",
            attributes: {
              "firegrid.workflow.execution_id": options.executionId,
              "firegrid.workflow.name": workflow.name,
              "firegrid.workflow.discard": options.discard === true,
            },
          }),
          annotateWorkflowExecutionSpans(options.executionId),
        ),
      poll: (_workflow, executionId) =>
        Effect.gen(function* () {
          // v4: the `Encoded.poll` contract returns `Option<Result>` (was
          // `Result | undefined` in v3). `None` ≡ the old `undefined` (no final
          // result yet); behavior is unchanged.
          const row = yield* getExecutionRow(executionId)
          return row?.finalResult === undefined
            ? Option.none<Workflow.Result<unknown, unknown>>()
            : Option.some(reviveEncodedResult(row.finalResult))
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.execution.poll", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.execution_id": executionId,
              "firegrid.workflow.name": _workflow.name,
            },
          }),
          annotateWorkflowExecutionSpans(executionId),
        ),
      interrupt: (_workflow, executionId) =>
        interruptExecution(_workflow, executionId),
      // v4: `Encoded` added `interruptUnsafe` (immediate stop that may skip
      // compensation/child cleanup). This engine has no separate compensation
      // path beyond the durable interrupt flag + fiber interrupt + resume that
      // `interrupt` already performs, so `interruptUnsafe` shares the same
      // implementation — preserving the single existing interrupt behavior.
      interruptUnsafe: (_workflow, executionId) =>
        interruptExecution(_workflow, executionId),
      resume: (_workflow, executionId) => resume(executionId),
      activityExecute: (activity, attempt) =>
        // Annotate the vendored `activity.name` span (created by makeExecute,
        // our caller) with its seam contract BEFORE opening the engine's own
        // span below. See contract-activity.ts for why this is the local hook.
        // v4: `Effect.zipRight(a, b)` → `Effect.andThen(a, b)` (when `b` is an
        // Effect, `andThen` discards `a`'s value and yields `b`'s — same as zipRight).
        Effect.andThen(
          annotateActivityContractSpan(activity),
          Effect.gen(function*() {
          const instance = yield* currentWorkflowInstanceWithSpanAnnotations
          const activityKey = `${instance.executionId}/${activity.name}/${attempt}`
          const row = yield* orDieTable(table.activities.get(activityKey).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          if (row?.result !== undefined) {
            const result = reviveEncodedResult(row.result)
            if (result._tag !== "Suspended") return result
          }

          const claimedAtMs = yield* Clock.currentTimeMillis
          const claim = yield* orDieTable(claimActivity({
            claimKey: activityKey,
            executionId: instance.executionId,
            activityName: activity.name,
            attempt,
            workerId,
            claimedAtMs,
          }))
          const completedAfterClaim = yield* orDieTable(table.activities.get(activityKey).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          if (completedAfterClaim?.result !== undefined) {
            const result = reviveEncodedResult(completedAfterClaim.result)
            if (result._tag !== "Suspended") return result
          }
          if (claim.workerId !== workerId) {
            return new Workflow.Suspended({})
          }

          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          )
          activityInstance.interrupted = instance.interrupted
          const result = yield* activity.executeEncoded.pipe(
            Workflow.intoResult,
            Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
            // v4: `Effect.catchAllCause` → `Effect.catchCause`. After
            // `Workflow.intoResult` the typed error channel is `never`, so the
            // recovered `cause` is `Cause.Cause<never>` (it can still carry
            // interrupt/defect reasons). Re-raising it keeps the activity
            // method's error channel at the `never` the `Encoded` contract
            // requires, preserving the original interrupt-vs-suspend behavior.
            Effect.catchCause((cause: Cause.Cause<never>) =>
              Effect.gen(function* () {
                const interrupted = yield* isExecutionInterrupted(
                  instance.executionId,
                )
                // v4: `Cause.isInterruptedOnly` → `Cause.hasInterruptsOnly`.
                return Cause.hasInterruptsOnly(cause) && !interrupted
                  ? new Workflow.Suspended({})
                  : yield* Effect.failCause(cause)
              })),
          )
          if (result._tag === "Suspended") return result
          const existingActivity = yield* orDieTable(table.activities.get(activityKey))
          if (Option.isNone(existingActivity)) {
            yield* orDieTable(table.activities.upsert({
              activityKey,
              executionId: instance.executionId,
              activityName: activity.name,
              attempt,
              result,
            }))
          }
          return result
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.activity.execute", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.activity.name": activity.name,
              "firegrid.workflow.activity.attempt": attempt,
              // Seam contract (runtime-shrink contract-coverage, tf-mmh2):
              // durable at-most-once execution — a completed activity is
              // short-circuited from durable state instead of re-running the body
              // (workflow-engine-durable-state.VALIDATION.1, ENGINE.1).
              "firegrid.seam.kind": "durability",
              "firegrid.contract.id": "features/firegrid/workflow-engine-durable-state.feature.yaml",
            },
          }),
        )),
      deferredResult: deferred =>
        Effect.gen(function*() {
          const instance = yield* currentWorkflowInstanceWithSpanAnnotations
          const key = `${instance.executionId}/${deferred.name}`
          const row = yield* orDieTable(table.deferreds.get(key).pipe(
            Effect.map(Option.getOrUndefined),
          ))
          // v4: the `Encoded.deferredResult` contract returns `Option<Exit>`
          // (was `Exit | undefined` in v3). `None` ≡ the old `undefined` (the
          // deferred has not been resolved yet); behavior is unchanged.
          return row?.exit === undefined
            ? Option.none<Exit.Exit<unknown, unknown>>()
            : Option.some(reviveExit(row.exit))
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.deferred.result", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.deferred.name": deferred.name,
              // Seam contract (runtime-shrink contract-coverage, tf-mmh2):
              // foundational DurableDeferred resolution read — returns the
              // committed encoded exit (or undefined) so a suspended workflow
              // resumes deterministically across replay
              // (workflow-engine-durable-state.ENGINE.1-2, VALIDATION.2).
              // NOT the tf-jpcg "external await into the workflow" bridge_debt;
              // this is the engine's own durable-deferred primitive.
              "firegrid.seam.kind": "durability",
              "firegrid.contract.id": "features/firegrid/workflow-engine-durable-state.feature.yaml",
            },
          }),
        ),
      deferredDone: options =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "firegrid.workflow.execution_id": options.executionId,
            "firegrid.workflow.name": options.workflowName,
            "firegrid.workflow.deferred.name": options.deferredName,
          })
          if (
            options.deferredName.startsWith("raceAll/") &&
            Exit.isFailure(options.exit) &&
            // v4: `Cause.isInterruptedOnly` → `Cause.hasInterruptsOnly`.
            Cause.hasInterruptsOnly(options.exit.cause) &&
            !(yield* isExecutionInterrupted(options.executionId))
          ) {
            return
          }
          const key = `${options.executionId}/${options.deferredName}`
          const existingDeferred = yield* orDieTable(table.deferreds.get(key))
          if (Option.isNone(existingDeferred)) {
            yield* orDieTable(table.deferreds.upsert({
              deferredKey: key,
              workflowName: options.workflowName,
              executionId: options.executionId,
              deferredName: options.deferredName,
              exit: options.exit,
            }))
          }
          yield* resume(options.executionId)
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.deferred.done", {
            kind: "internal",
          }),
          annotateWorkflowExecutionSpans(options.executionId),
        ),
      scheduleClock: (workflow, options) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "firegrid.workflow.execution_id": options.executionId,
            "firegrid.workflow.name": workflow.name,
            "firegrid.workflow.clock.name": options.clock.name,
          })
          // workflow-engine-durable-state.VALIDATION.3
          const key = `${options.executionId}/${options.clock.name}`
          const nowMs = yield* Clock.currentTimeMillis
          const row: WorkflowClockWakeupRow = {
            clockKey: key,
            workflowName: workflow.name,
            executionId: options.executionId,
            clockName: options.clock.name,
            deferredName: options.clock.deferred.name,
            deadlineMs: nowMs + Duration.toMillis(options.clock.duration),
            status: "pending",
          }
          const result = yield* orDieTable(table.clockWakeups.insertOrGet(row))
          yield* Match.value(result).pipe(
            Match.tag("Inserted", () => scheduleClockWakeup(row)),
            Match.tag("Found", ({ row: existing }) =>
              existing.status === "pending" && existing.deadlineMs <= nowMs
                ? scheduleClockWakeup(existing)
                : Effect.void),
            Match.exhaustive,
          )
        }).pipe(
          Effect.withSpan("firegrid.workflow_engine.clock.schedule", {
            kind: "internal",
          }),
          annotateWorkflowExecutionSpans(options.executionId),
        ),
    })

    yield* recoverPendingClockWakeups

    return engine
  })
