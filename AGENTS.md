# effect-encore

Declarative actors and durable workflows for `@effect/cluster`.

## Commands

```bash
bun run gate          # all checks concurrent: typecheck, lint, fmt, build, test
bun run typecheck     # tsgo --noEmit, patched by @effect/tsgo
bun run lint          # oxlint type-aware; Effect diagnostics run through tsgo plugin
bun run build         # tsdown
bun test              # bun test
```

## Architecture

- `src/actor.ts` — v4 actor API: `Actor.fromEntity`, `Actor.fromWorkflow`, `toLayer`, `toTestLayer`, types, runtime
- `src/actor-state.ts` — live entity state registry and `Actor.registerState` helpers
- `src/storage.ts` — `MessageDeletion` Context.Service for single-invocation deletion
- `src/receipt.ts` — `ExecId<S,E>` branded type, `PeekResult` ADT
- `src/canonical-json.ts` — stable JSON encoding and SHA-256 for durable identities
- The package supports Effect v4 only.

## API surface

### Entity actors — per-op payload-only handles

`Actor.fromEntity(name, defs)` returns an `EntityActor` where each operation tag is an `OperationHandle` with payload-only methods:

```ts
const Counter = Actor.fromEntity("Counter", {
  Increment: {
    payload: { id: Schema.String, amount: Schema.Number },
    success: Schema.Number,
    id: (p) => p.id,
  },
});

// dispatch:
yield * Counter.Increment.execute({ id: "loc-A", amount: 5 });
yield * Counter.Increment.send({ id: "loc-A", amount: 5 }); // discard, returns ExecId
yield * Counter.Increment.sendAndAwait({ id: "loc-A", amount: 5 }, { timeout: "30 seconds" }); // send + poll reply → success value; no local Sharding required
yield * Counter.Increment.executionId({ id: "loc-A", amount: 5 }); // pure; returns ExecId
yield * Counter.Increment.peek({ id: "loc-A", amount: 5 }); // PeekResult
yield * Counter.Increment.watch({ id: "loc-A", amount: 5 }); // Stream<PeekResult>
yield * Counter.Increment.waitFor({ id: "loc-A", amount: 5 }); // Effect<PeekResult>
yield * Counter.Increment.rerun({ id: "loc-A", amount: 5 }); // surgical dedup-cache clear
const op = Counter.Increment.make({ id: "loc-A", amount: 5 }); // build OperationValue without dispatch (escape hatch)
```

Entity-scoped (not per-op):

- `Counter.flush(entityId)` — clears mailbox + lastRead. Coarse.
- `Counter.redeliver(entityId)` — clears lastRead only.
- `Counter.interrupt(entityId)` — `clearAddress(address)`. Distinct intent from flush ("stop accepting more" vs "clean slate"); programmatic in-flight fiber cancellation needs `Sharding.passivate` (not yet public upstream).
- `Counter.getState<State>(entityId, { materialize? })` — read the state handle registered by the live entity.
- `Counter.watchState<State>(entityId, { materialize? })` — stream registered state changes; stream fails with `ActorStateUnavailable` if the entity has no live state handle.
- `Counter.listStateEntityIds()` — list entity ids with currently registered state handles in this process.

Entity handlers register live state from the entity scope:

```ts
yield *
  Actor.registerState({
    get: SubscriptionRef.get(state),
    watch: SubscriptionRef.changes(state),
  });
```

`Actor.toLayer` / `Actor.toTestLayer` provide the state registry locally. This
is a live heap protocol, not durable storage; cross-process producers cannot
observe another runner's in-memory entity state.

### Workflow actors — payload-only methods at actor level

Workflows have one op (`Run`), so methods promote to actor level:

```ts
const Geocode = Actor.fromWorkflow("Geocode", {
  payload: { locationId: Schema.String },
  id: (p) => p.locationId, // workflow id is string-only
});

yield * Geocode.execute({ locationId: "loc-A" });
yield * Geocode.send({ locationId: "loc-A" });
yield * Geocode.executionId({ locationId: "loc-A" });
yield * Geocode.peek({ locationId: "loc-A" });
yield * Geocode.watch({ locationId: "loc-A" });
yield * Geocode.waitFor({ locationId: "loc-A" });
yield * Geocode.rerun({ locationId: "loc-A" }); // interrupt + clearAddress; clears run reply + activity replies
yield * Geocode.prune(executionId); // remove terminal run, activity, and clock state
yield * Geocode.interrupt(executionId); // takes execId, fiber-signal only
yield * Geocode.resume(executionId);
const op = Geocode.make({ locationId: "loc-A" }); // OperationValue escape hatch
```

## `id` fn semantics

A single `id` fn replaces the old `entityId` / `primaryKey` / `idempotencyKey` slots.

| Return shape                | Entity actor                           | Workflow actor  |
| --------------------------- | -------------------------------------- | --------------- |
| `string`                    | `entityId === primaryKey === string`   | idempotency key |
| `{ entityId, primaryKey? }` | mailbox = entityId, dedup = primaryKey | **type error**  |

Workflows reject the object form at the type level — one workflow = one queue, no entity dimension.

The divergent object form is for cases like PagerDuty where mailbox routing differs from dedup key:

```ts
PagerDuty: {
  payload: { dedup_key: Schema.String, event_action: Schema.String },
  id: (p) => ({
    entityId: p.dedup_key,                              // FIFO mailbox per dedup_key
    primaryKey: `${p.dedup_key}:${p.event_action}`,     // distinct execIds per action
  }),
}
```

`id` must be deterministic.

## ExecId

- Format: `entityId\0tag\0primaryKey` (null byte separator — safe with colons in any segment)
- `OperationHandle.executionId(payload)` — pure-internally `Effect<ExecId<S,E>>`
- `WorkflowActor.executionId(payload)` — `Effect<ExecId<S,E>>`; upstream computes from workflow `id(payload)`
- Workflow compensation can suspend. Do not run it from a workflow scope finalizer. Build it in the workflow body so `DurableDeferred.await` can suspend and replay.
- A compensation can fail with the Workflow error. Use the Workflow error schema for its durable Activity.
- A compensation Activity name identifies the Step. `Activity.CurrentAttempt` identifies the retry. The decision Durable Deferred name must include both the Step ID and attempt.
- Persist the compensation plan and each failed attempt. Operator code must discover the pending Step ID and attempt. It must not guess them.
- Validate each compensation decision against the pending attempt. A different pending attempt or accepted decision must fail with `CompensationDecisionConflictError`. A run with no current or recorded attempt must fail with `CompensationNotPendingError`.
- Keep replay-side logs inside the Activity body. Code after a cached Activity result runs again on every replay.

## Workflow pruning and surgical rerun

Dedup records survive forever — that's the property the library sells. `.rerun(payload)` is the surgical escape hatch:

- **Entity**: derives `{entityId, primaryKey}` via `id`, looks up the requestId for the primaryKey, and calls `MessageDeletion.deleteInvocation`. A missing execution is a no-op.
- **Workflow prune**: `WorkflowActor.prune(executionId)` removes the run, activity, and durable clock addresses through `Client`.
- **Workflow rerun**: `WorkflowEngine.interrupt(executionId)` signals the fiber. It then calls the same Client prune operation.
- Workflow rerun-while-running is best-effort: cleanup is eventual; next `.execute(samePayload)` may queue behind the interrupted fiber's wind-down. No data corruption, just transient ordering.

## `MessageDeletion`

Encore adds one internal storage operation that Effect does not provide. Adapters provide it with upstream `MessageStorage`:

```ts
import { encoreMessageStorageLayer, fromMessageStorage, fromSqlClient } from "effect-encore";

// in your runtime composition:
const storageLayer = encoreMessageStorageLayer(upstreamStorageLayer, {
  deleteEnvelope: (requestId) => /* adapter-specific delete */
});

// SQL-backed runtimes can use the built-in Effect Cluster SQL adapter:
const sqlStorageLayer = fromSqlClient(); // requires SqlClient.SqlClient
```

`OperationHandle.rerun` requires it. Workflow pruning uses Client and upstream address cleanup. Adapters that have not implemented single-invocation deletion must fail as a defect.

`fromSqlClient()` provides both upstream `MessageStorage.MessageStorage` and
Encore's `MessageDeletion` over Effect Cluster's default
`cluster_messages` / `cluster_replies` tables. Use
`fromSqlClientWithShardingConfig()` when the runtime owns sharding config.

## Payload Classification

Three payload forms, two operation shapes:

| Definition                                          | `isOpaquePayload`      | Operation shape       | Handler access       |
| --------------------------------------------------- | ---------------------- | --------------------- | -------------------- |
| `payload: { field: Schema.String }` (struct fields) | N/A                    | `{ _tag, ...fields }` | `operation.field`    |
| `payload: MySchemaClass` (Schema.Class)             | `false` — has `fields` | `{ _tag, ...fields }` | `operation.field`    |
| `payload: Schema.String` (scalar)                   | `true` — no `fields`   | `{ _tag, _payload }`  | `operation._payload` |

Discriminator: `Schema.isSchema(payload) && !("fields" in payload)`. Schema.Class has `fields`, scalars don't.

## Effect Diagnostics

- Effect diagnostics live in the `@effect/language-service` tsconfig plugin.
- `@effect/tsgo` patches `tsgo`; run `bun install` or `bun run prepare` after dependency changes.
- `serviceNotAsClass` is enabled for v4 services. Use `class X extends Context.Service<X, Shape>()("key") {}`.

## Gotchas

- `Effect.die(new Error(...))` is idiomatic for defects — no LSP rule catches it (by design)
- Entity `interrupt` clears the mailbox via `clearAddress`; in-flight handlers run to completion (Sharding.passivate not public)
- Entity peek returns **encoded** values from storage; `decodeValue` uses `Schema.decodeUnknownEffect` with fallback
- Workflow peek uses real `Exit.Exit` (not encoded) — walk `Cause` tree via `Cause.findErrorOption`/`findDefect`/`findInterrupt`
- `withCompensation` is NOT on the actor — it's a workflow primitive. Import from `Workflow` directly.
- Use `canonicalJsonString` and `canonicalJsonSha256` for durable JSON identities. Do not add another serializer.
- Workflow `executionId` (the cluster slot the engine writes to) = upstream's hashed execution id for `id(payload)` — NOT the raw `id(payload)` string. `Workflow*.peek/rerun/executionId` use `wf.executionId(payload)` internally so they line up with the engine's writes.
- Adapters must implement `MessageDeletion.deleteInvocation` for entity `.rerun`.
