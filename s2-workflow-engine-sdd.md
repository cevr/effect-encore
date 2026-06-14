# S2 Workflow Engine SDD

Status: design draft. This supersedes `s2-entity-execution-sdd.md`.

The deliverable is an S2-backed implementation of Effect's
`WorkflowEngine.Encoded` contract, wrapped with `WorkflowEngine.makeUnsafe`.
It is not a new public entity substrate, not a replacement for Effect Cluster,
and not an `Actor.toS2Layer` adapter.

## Goal

Provide a production-oriented S2 workflow engine for `effect-encore` workflows:

```text
Workflow.execute / poll / interrupt / resume
  -> WorkflowEngine service
    -> S2WorkflowEngine.Encoded
      -> one S2 stream per workflow execution
```

The S2 stream is the durable transaction log for one workflow execution. It
stores:

- workflow start payload
- workflow completion / suspension / interruption markers
- activity results
- durable deferred completions
- durable clock schedules / wakeups
- snapshots used to bound replay

This is the inbox/outbox/idempotency pattern specialized to the upstream
workflow seam. The important atomic commit is:

```text
execution-control fact(s) + result marker
```

as one S2 `AppendInput` batch.

Domain state is not persisted as workflow-stream records. It is reconstructed by
rerunning the workflow function over memoized activity/deferred/clock results.
The workflow stream stores execution-control facts only: enough information for
the engine to decide what to run next and which side-effect boundaries have
already completed. Do not add `StateChanged`-style domain records to this engine.

## Non-goals

- Do not implement a public `S2EntityLog`, `S2EntityRunner`, or "kernel".
- Do not implement `MessageStorage.Encoded` or `RunnerStorage.Encoded`.
- Do not patch `Actor.toLayer`, `Actor.fromEntity`, or actor send/peek paths in
  the first implementation.
- Do not wrap the S2 SDK as a broad CRUD service.
- Do not use S2 stream fencing as the default ownership mechanism for execution
  streams.
- Do not keep the current `src/s2-actor-runtime.ts` spike.

## Upstream Contract

Implement this exact interface from `effect/unstable/workflow/WorkflowEngine`:

```ts
export interface Encoded {
  readonly register: (
    workflow: Workflow.Any,
    execute: (
      payload: object,
      executionId: string,
    ) => Effect.Effect<unknown, unknown, WorkflowInstance | WorkflowEngine>,
  ) => Effect.Effect<void, never, Scope.Scope>;

  readonly execute: <const Discard extends boolean>(
    workflow: Workflow.Any,
    options: {
      readonly executionId: string;
      readonly payload: object;
      readonly discard: Discard;
      readonly parent?: WorkflowInstance["Service"];
    },
  ) => Effect.Effect<Discard extends true ? void : Workflow.Result<unknown, unknown>>;

  readonly poll: (
    workflow: Workflow.Any,
    executionId: string,
  ) => Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>>;

  readonly interrupt: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
  readonly interruptUnsafe: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
  readonly resume: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;

  readonly activityExecute: (
    activity: Activity.Any,
    attempt: number,
  ) => Effect.Effect<Workflow.Result<unknown, unknown>, never, WorkflowInstance>;

  readonly deferredResult: (
    deferred: DurableDeferred.Any,
  ) => Effect.Effect<Option.Option<Exit.Exit<unknown, unknown>>, never, WorkflowInstance>;

  readonly deferredDone: (options: {
    readonly workflowName: string;
    readonly executionId: string;
    readonly deferredName: string;
    readonly exit: Exit.Exit<unknown, unknown>;
  }) => Effect.Effect<void>;

  readonly scheduleClock: (
    workflow: Workflow.Any,
    options: {
      readonly executionId: string;
      readonly clock: DurableClock;
    },
  ) => Effect.Effect<void>;
}
```

The public layer is:

```ts
export const layerS2 = (config: S2WorkflowEngineConfig): Layer.Layer<WorkflowEngine>;
```

which internally does:

```ts
Layer.effect(WorkflowEngine, Effect.map(makeEncoded(config), WorkflowEngine.makeUnsafe));
```

## S2 Primitives

Use the official `@s2-dev/streamstore` SDK directly:

```ts
import {
  AppendInput,
  AppendRecord,
  RangeNotSatisfiableError,
  S2,
  SeqNumMismatchError,
} from "@s2-dev/streamstore";
```

Required S2 behavior:

- `AppendInput.create(records, { matchSeqNum })` is the CAS primitive for
  start records, ownership claims, ownership heartbeats, owner-guarded activity
  completions, and result markers.
- a batch append is atomic: either all records in the batch become durable or
  none do.
- `read` folds bounded pages.
- `readSession` tails execution streams for resume/wakeup notifications.
- `AppendRecord.trim(seqNum)` is used only after a snapshot preserves enough
  state to recover.
- S2 Lite tests use the installed CLI, not a custom process launcher:

```sh
s2 lite --port "$PORT" --local-root "$ROOT" --init-file "$ROOT/init.json"
```

Fencing note:

Do not use S2 fencing tokens for v1 workflow ownership. They are storage-level
write gates for a whole stream. Workflow executions still need appenders outside
the active runner, for example `deferredDone`, `interrupt`, `resume`, and clock
wakeups. A fenced execution stream would either block those appends or require
sharing the token across unrelated callers.

Use stream records plus `matchSeqNum` for ownership, owner-guarded activity
completions, and result markers. Additive external facts such as
`DeferredCompleted`, `WorkflowInterrupted`, `WorkflowResumed`, and clock wakeups
should append unconditionally. The fold resolves ordering and first-writer-wins
keys. CAS on those records creates spurious claim/notification contention on hot
executions.

## File Layout

```text
src/s2-workflow/
  config.ts          # S2WorkflowEngineConfig and SDK construction
  names.ts           # stream naming, segment encode/decode
  records.ts         # Schema record algebra + JSON codecs
  fold.ts            # pure foldExecution
  stream.ts          # S2 append/read/readSession helpers
  encoded.ts         # WorkflowEngine.Encoded implementation
  layer.ts           # layerS2
  test-fixture.ts    # S2 Lite fixture for tests only
  index.ts

test/s2-workflow/
  engine.e2e.test.ts
  activities.e2e.test.ts
  deferred-clock.e2e.test.ts
  snapshot-trim.e2e.test.ts
```

Avoid generic file names like `s2.ts`. Avoid one half-thousand-line server or
runtime file.

## Configuration

```ts
export interface S2WorkflowEngineConfig {
  readonly basin: string;
  readonly accessToken: string;
  readonly endpoints?: S2EndpointsInit;
  readonly streamPrefix?: string;
  readonly runnerId: string;
  readonly forceTransport?: "fetch" | "s2s";
  readonly requestTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly ownerTtlMillis?: number;
  readonly snapshotEveryRecords?: number;
}
```

Stream names:

```ts
workflowExecutionStream(prefix, workflowName, executionId);
// `${prefix}/workflows/${segment(workflowName)}/${segment(executionId)}`
```

Use one stream per workflow execution. Do not create separate streams for
activities, replies, deferreds, or clocks in v1. Keeping them in one stream gives
the atomicity we need from one S2 append batch.

## Record Algebra

All records are schema-first. Values already received by `Encoded` are encoded
values from `WorkflowEngine.makeUnsafe`, activities, and deferreds. The envelope
itself still uses `Schema.toCodecJson` and `Schema.fromJsonString`.

```ts
import { Schema } from "effect";

export const WorkflowStarted = Schema.TaggedStruct("WorkflowStarted", {
  schemaVersion: Schema.Literal(1),
  workflowName: Schema.String,
  executionId: Schema.String,
  parentExecutionId: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  createdAtMillis: Schema.Number,
});

export const OwnerClaimed = Schema.TaggedStruct("OwnerClaimed", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  runnerId: Schema.String,
  claimedAtMillis: Schema.Number,
  expiresAtMillis: Schema.Number,
});

export const WorkflowCompleted = Schema.TaggedStruct("WorkflowCompleted", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  result: Schema.Unknown, // Workflow.Result<unknown, unknown>
  createdAtMillis: Schema.Number,
});

export const WorkflowSuspended = Schema.TaggedStruct("WorkflowSuspended", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  result: Schema.Unknown, // Workflow.Suspended
  createdAtMillis: Schema.Number,
});

export const WorkflowInterrupted = Schema.TaggedStruct("WorkflowInterrupted", {
  schemaVersion: Schema.Literal(1),
  unsafe: Schema.Boolean,
  createdAtMillis: Schema.Number,
});

export const WorkflowResumed = Schema.TaggedStruct("WorkflowResumed", {
  schemaVersion: Schema.Literal(1),
  createdAtMillis: Schema.Number,
});

export const ActivityCompleted = Schema.TaggedStruct("ActivityCompleted", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  activityId: Schema.String, // `${executionId}/${activity.name}/${attempt}`
  exit: Schema.Unknown, // Exit<Workflow.Result<unknown, unknown>, unknown>
  createdAtMillis: Schema.Number,
});

export const DeferredCompleted = Schema.TaggedStruct("DeferredCompleted", {
  schemaVersion: Schema.Literal(1),
  deferredName: Schema.String,
  exit: Schema.Unknown, // encoded Exit<unknown, unknown>
  createdAtMillis: Schema.Number,
});

export const ClockScheduled = Schema.TaggedStruct("ClockScheduled", {
  schemaVersion: Schema.Literal(1),
  clockName: Schema.String,
  deferredName: Schema.String,
  wakeAtMillis: Schema.Number,
  createdAtMillis: Schema.Number,
});

export const SnapshotTaken = Schema.TaggedStruct("SnapshotTaken", {
  schemaVersion: Schema.Literal(1),
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  result: Schema.Option(Schema.Unknown),
  activities: Schema.Record(Schema.String, Schema.Unknown),
  deferreds: Schema.Record(Schema.String, Schema.Unknown),
  clocks: Schema.Record(Schema.String, Schema.Unknown),
  interrupted: Schema.Boolean,
  suspended: Schema.Boolean,
  takenAtMillis: Schema.Number,
});

export const ExecutionRecord = Schema.Union(
  WorkflowStarted,
  OwnerClaimed,
  WorkflowCompleted,
  WorkflowSuspended,
  WorkflowInterrupted,
  WorkflowResumed,
  ActivityCompleted,
  DeferredCompleted,
  ClockScheduled,
  SnapshotTaken,
);

export const ExecutionRecordJson = Schema.fromJsonString(Schema.toCodecJson(ExecutionRecord));

export const encodeRecord = Schema.encodeUnknownEffect(ExecutionRecordJson);
export const decodeRecord = Schema.decodeUnknownEffect(ExecutionRecordJson);
```

`SnapshotTaken` carries cached activity/deferred/clock state so trim does not
erase replay and dedupe knowledge.

Forward compatibility: `activityId`, `deferredName`, and `clockName` are
generation-unqualified in v1 because rerun is out of scope. When rerun lands,
these keys must become generation-qualified before old completions can coexist
with a new execution generation.

## Folded Execution

`foldExecution` is private and pure. It is the core test target.

```ts
export interface FoldedExecution {
  readonly tailSeqNum: number;
  readonly started: Option.Option<WorkflowStarted>;
  readonly owner: Option.Option<OwnerClaimed>;
  readonly result: Option.Option<Workflow.Result<unknown, unknown>>;
  readonly activities: ReadonlyMap<string, ActivityCompleted>;
  readonly deferreds: ReadonlyMap<string, DeferredCompleted>;
  readonly clocks: ReadonlyMap<string, ClockScheduled>;
  readonly interrupted: boolean;
  readonly unsafeInterrupted: boolean;
  readonly suspended: boolean;
}
```

Rules:

- `WorkflowStarted` is first-writer-wins.
- `OwnerClaimed` with the latest non-expired timestamp is current owner.
- `WorkflowCompleted` is terminal and wins over later resume attempts.
- `WorkflowSuspended` is non-terminal and causes `execute` to return
  `Suspended`.
- `ActivityCompleted` indexes by `activityId`.
- `DeferredCompleted` indexes by `deferredName` and is first-writer-wins.
- `ClockScheduled` indexes by `clockName`; wakeup is implemented by completing
  the clock's deferred.
- `SnapshotTaken` resets the folded maps/result/interruption flags, then later
  records continue from the snapshot.

## Encoded Method Mapping

### register

Keep a scoped in-memory registry of workflow handlers by `workflow._tag`.

```ts
register(workflow, execute) = registry.set(workflow._tag, {
  workflow,
  execute,
  scope: currentScope,
});
```

Registration is not itself S2 state. If a process restarts without registering a
workflow, `execute` for that workflow must fail as a defect. This matches the
upstream in-memory engine's expectation that handlers are registered by layers.

## Replay Invariant

Resume always re-enters the workflow handler from the top. Progress is recovered
by memoized boundaries:

- `activityExecute` returns persisted `ActivityCompleted` results instead of
  rerunning completed activities.
- `deferredResult` returns persisted `DeferredCompleted` exits instead of
  suspending again.
- `scheduleClock` observes persisted `ClockScheduled` / deferred completion
  records instead of scheduling duplicate wakeups.

There is no serialized continuation and no domain-state record in the workflow
stream. Local variables and domain progress are reconstructed by replaying the
workflow code over those memoized boundary results.

### execute

`execute` is idempotent by `(workflow._tag, executionId)`.

Algorithm:

1. Fold the execution stream.
2. If terminal result exists:
   - `discard: true` returns `void`.
   - otherwise return the cached result.
3. If no `WorkflowStarted`, append it with `matchSeqNum: tail`.
4. If `discard: true`, return after start is durable.
5. Claim ownership with `OwnerClaimed` using `matchSeqNum`.
6. Run or resume the registered handler from the top under a fresh
   `WorkflowInstance`.
7. Convert the handler exit via `Workflow.intoResult`.
8. Append exactly one result marker:
   - `WorkflowCompleted` for `Complete`
   - `WorkflowSuspended` for `Suspended`
9. Return the result.

Pseudo-code:

```ts
const execute: Encoded["execute"] = (workflow, options) =>
  Effect.gen(function* () {
    yield* ensureStarted(workflow, options);
    if (options.discard) return undefined as never;

    const cached = yield* poll(workflow, options.executionId);
    if (Option.isSome(cached) && cached.value._tag === "Complete") {
      return cached.value as never;
    }

    const ownerEpoch = yield* claimExecution(workflow, options.executionId);
    return yield* runTurn(workflow, options.executionId, ownerEpoch);
  });
```

Do not fork hidden long-running fibers in `execute` unless the upstream call
requires it. `discard: true` may persist start and request later resumption, but
it must not pretend the workflow completed.

### poll

Fold the stream and return:

- `Option.none()` when no result marker exists.
- `Option.some(Complete)` for terminal completion.
- `Option.some(Suspended)` for suspension.

### interrupt / interruptUnsafe

Append `WorkflowInterrupted{unsafe:false|true}` unconditionally. Then call
`resume` so the registered handler can observe interruption state.

`interruptUnsafe` may also interrupt a local in-flight fiber if this process owns
one, but the durable record is still required.

### resume

Append `WorkflowResumed` unconditionally, then run one turn if a handler is
registered. Resume is idempotent: if the fold is already terminal, do nothing.

### activityExecute

Activity identity matches upstream memory:

```ts
const activityId = `${instance.executionId}/${activity.name}/${attempt}`;
```

Algorithm:

1. Fold the execution stream.
2. If `ActivityCompleted(activityId)` exists:
   - if it stored a suspended result, clear only for this in-memory turn and
     re-run, matching upstream memory behavior.
   - otherwise return the stored exit.
3. Run `activity.executeEncoded`.
4. Wrap with `Workflow.intoResult`.
5. Before appending, refold and verify the current `ownerEpoch` still matches
   the turn's owner.
6. Append `ActivityCompleted` with `ownerEpoch` and `matchSeqNum`.
7. Return the stored result.

If ownership no longer matches, abort the current turn without appending the
activity result. A displaced runner may already have executed an external side
effect; the activity id is the required idempotency key for that side effect.

External side effects inside activities must use `activityId` or a caller
provided idempotency key. S2 cannot make an external payment/email/API call
exactly once if the process crashes after the side effect and before the append.

### deferredResult / deferredDone

Deferred identity is `${executionId}/${deferred.name}` in upstream memory, but
because the execution stream is already scoped by execution id, the record key is
`deferred.name`.

`deferredResult` folds and returns the stored encoded exit.

`deferredDone` appends `DeferredCompleted` unconditionally. If the fold already
contains that deferred, it returns `void`. After appending, it calls `resume`.
First-writer-wins is enforced by the fold, not by a CAS loop, because deferred
completion is an additive external fact.

### scheduleClock

Compute `wakeAtMillis = now + clock.duration`.

Append `ClockScheduled` once by `clock.name`. Duplicate schedules are ignored by
the fold. The scheduler loop follows due-clock records, sleeps until due, then
calls `deferredDone` for the clock's deferred with `Exit.void`.

Scanning every workflow stream by prefix is acceptable only as a short-lived v1
test shortcut. It is O(all executions) per scan and does not survive scale. The
steady-state design needs a due-time index, for example one or more S2 streams
containing `{ wakeAtMillis, workflowName, executionId, clockName }` records that
the scheduler tails. The index is derived from `ClockScheduled` records and does
not replace the execution stream as source of truth.

## Ownership

Ownership is an internal execution-stream record:

```ts
OwnerClaimed {
  ownerEpoch,
  runnerId,
  expiresAtMillis
}
```

Claiming is CAS:

1. Fold current stream.
2. If active owner is unexpired and belongs to another runner, return
   `NotOwner`.
3. Append `OwnerClaimed` with `matchSeqNum: tail`.
4. On `SeqNumMismatchError`, refold and retry.

Owners must heartbeat during long turns by appending a fresh `OwnerClaimed` for
the same `ownerEpoch` before `expiresAtMillis`. A turn starts a scoped heartbeat
fiber before entering the handler and stops it when the turn completes or aborts.
Heartbeats use `matchSeqNum: tail` and retry by refolding. If a heartbeat
observes another unexpired owner epoch, the current turn must stop before
appending any more activity or result records.

`ownerTtlMillis` must be longer than the expected heartbeat interval, not longer
than the maximum activity duration. Long activities are permitted only because
the owner heartbeats while they are in flight.

This prevents normal duplicate workflow turns. It is not a hard external
side-effect guard. Activities still need idempotency keys.

## Snapshot And Trim

Automatic trim is not required for the first merge. Snapshot format must exist
before trim exists.

When enabled:

1. Fold to a stable tail.
2. Append `SnapshotTaken` with payload, result, cached activities, deferreds,
   clocks, and interruption flags.
3. Append `AppendRecord.trim(snapshotSeqNum)`.
4. Verify recovery from the trim point in S2 Lite tests.

Never trim away activity/deferred completion knowledge that the replay window
still needs.

## Tests

All tests use real S2 Lite:

```ts
const proc = Bun.spawn([
  "s2",
  "lite",
  "--port",
  String(port),
  "--local-root",
  root,
  "--init-file",
  `${root}/init.json`,
]);
```

`init.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/s2-streamstore/s2/main/cli/schema.json",
  "basins": [
    {
      "name": "encoretest",
      "config": { "create_stream_on_append": true },
      "streams": []
    }
  ]
}
```

Required E2E cases:

1. `Workflow.execute` persists start and returns success.
2. `Workflow.execute({ discard: true })` persists start and a separate engine
   instance can resume/complete it.
3. repeated `execute` with the same execution id returns the cached result and
   does not rerun completed activities.
4. a suspended workflow resumes by re-entering the handler from the top and
   fast-forwarding through memoized activities.
5. `poll` returns `none`, then `Suspended`, then `Complete` as records appear.
6. activity result is memoized across process restart.
7. stale owner cannot append `ActivityCompleted` or workflow result records
   after another owner claims the execution.
8. owner heartbeat keeps a long-running turn from expiring mid-activity.
9. deferred completion appends unconditionally while an owner is claiming, and
   the owner refolds instead of livelocking.
10. deferred completion resumes a suspended workflow.
11. durable clock schedules a wakeup and resumes after process restart.
12. due-clock prefix scan is covered only as a v1 shortcut; a due-time index test
    must be added before claiming scale-readiness.
13. concurrent `execute` calls use `matchSeqNum`/claim records so only one turn
    commits.
14. interrupt records append unconditionally and are observed by a later resume.
15. snapshot + trim recovers completion/activity/deferred state.

Unit tests:

- `foldExecution` for every record ordering edge.
- record encode/decode with `Schema.toCodecJson` and `fromJsonString`.
- stream naming round-trips escaped workflow names and execution ids.
- key-generation tests documenting that activity/deferred/clock keys become
  generation-qualified when rerun is added.

## Migration From Current Spike

Remove these uncommitted spike artifacts:

- `src/s2-actor-runtime.ts`
- `test/s2-actor-runtime.test.ts`
- `Actor.toS2Layer` edits in `src/actor.ts`

Keep only the dependency on `@s2-dev/streamstore` and S2 Lite fixture approach if
needed. The implementation should start from `src/s2-workflow/records.ts` and
`src/s2-workflow/fold.ts`, then wire `encoded.ts`.

## Source References

- Effect `WorkflowEngine.Encoded` and `WorkflowEngine.makeUnsafe`
- Effect `Activity.make` encoded activity behavior
- Effect `DurableDeferred` encoded exits and durable wait behavior
- Effect `DurableClock` scheduling through `WorkflowEngine.scheduleClock`
- S2 append API: atomic batches and `match_seq_num`
- S2 read concepts: linearizable reads, read sessions
- S2 Lite docs: `s2 lite --init-file init.json`
- `@s2-dev/streamstore` TypeScript SDK: `S2`, `AppendInput`, `AppendRecord`,
  `S2Stream.read`, `S2Stream.readSession`, `S2Stream.append`, typed errors
