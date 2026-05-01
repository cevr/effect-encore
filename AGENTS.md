# effect-encore

Declarative actors and durable workflows for `@effect/cluster`.

## Commands

```bash
bun run gate          # all checks concurrent: typecheck, typecheck:v3, lint, fmt, build, test
bun run typecheck     # tsgo --noEmit (v4)
bun run typecheck:v3  # tsgo --noEmit -p v3/tsconfig.json
bun run lint          # oxlint + effect-language-service (src strict, test relaxed)
bun run build         # tsdown v4 + v3 concurrent
bun test              # bun test
```

## Architecture

- `src/actor.ts` — entire v4 API: `Actor.fromEntity`, `Actor.fromWorkflow`, `toLayer`, `toTestLayer`, types, runtime
- `src/storage.ts` — `EncoreMessageStorage` Context.Tag (extends upstream `MessageStorage` with `deleteEnvelope`)
- `v3/src/actor.ts` — v3 mirror using `@effect/cluster`, `@effect/rpc`, `@effect/workflow` imports
- `src/receipt.ts` — `ExecId<S,E>` branded type, `PeekResult` ADT
- Both v3 and v4 import from the same `effect@4.x` — v3 distinction is only the cluster/rpc/workflow packages

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

## Entity Dedupe Strategies

Entity operations default to `dedupe: DedupeStrategy.AtMostOnce`: a persisted primary-key completion is reusable until `.rerun(payload)` explicitly clears that execId.

Use `dedupe: DedupeStrategy.InProgress` for coalescing duplicate producers only while the original work is still active. The public `ExecId` stays stable (`entityId\0tag\0rawPrimaryKey`), while the storage primary key carries an effect-encore marker so adapters can release the dedupe index after terminal completion.

```ts
import { Actor, DedupeStrategy } from "effect-encore";

const VectorUpdate = Actor.fromEntity("VectorUpdate", {
  UpdateVectors: {
    payload: { locationId: Schema.String },
    persisted: true,
    dedupe: DedupeStrategy.InProgress,
    id: (p) => p.locationId,
  },
});
```

Storage adapters that support this policy should branch with `DedupeStrategy.fromPrimaryKey(clusterPrimaryKey)`. Treat `AtMostOnce` as the durable default and `InProgress` as active-only uniqueness; `DedupeStrategy.stripPrimaryKey(...)` removes the marker when presenting keys.

## ExecId

- Format: `entityId\0tag\0primaryKey` (null byte separator — safe with colons in any segment)
- `OperationHandle.executionId(payload)` — pure-internally `Effect<ExecId<S,E>>`
- `WorkflowActor.executionId(payload)` — `Effect<ExecId<S,E>>` (needs `WorkflowEngine`); upstream computes from workflow `id(payload)`

## Surgical rerun (`<Op>.rerun(payload)`)

For the default `AtMostOnce` strategy, dedup records survive forever — that's the property the library sells. `.rerun(payload)` is the surgical escape hatch:

- **Entity**: derives `{entityId, primaryKey}` via `id`, looks up the requestId for the primaryKey, calls `EncoreMessageStorage.deleteEnvelope(requestId)`. No-op on non-existent execId.
- **Workflow**: `WorkflowEngine.interrupt(executionId)` (signals fiber if running, no-op if completed) + `EncoreMessageStorage.clearAddress(workflowAddress)` (wipes run reply AND every cached activity reply at the same address).
- Workflow rerun-while-running is best-effort: cleanup is eventual; next `.execute(samePayload)` may queue behind the interrupted fiber's wind-down. No data corruption, just transient ordering.

## `EncoreMessageStorage`

Encore's storage tag extends upstream `MessageStorage` with `deleteEnvelope(requestId)`. Adapters provide both:

```ts
import { encoreMessageStorageLayer, fromMessageStorage } from "effect-encore";

// in your runtime composition:
const storageLayer = encoreMessageStorageLayer(upstreamStorageLayer, {
  deleteEnvelope: (requestId) => /* adapter-specific delete */
});
```

Required by `OperationHandle.rerun` and `WorkflowActor.rerun`. Adapters that haven't implemented yet should fail loud (`Effect.die`) rather than coarsen to `flush`.

Adapters that implement `DedupeStrategy.InProgress` must still implement `deleteEnvelope`; `.rerun(payload)` always uses the same storage primary-key encoding as normal dispatch.

## Payload Classification

Three payload forms, two operation shapes:

| Definition                                          | `isOpaquePayload`      | Operation shape       | Handler access       |
| --------------------------------------------------- | ---------------------- | --------------------- | -------------------- |
| `payload: { field: Schema.String }` (struct fields) | N/A                    | `{ _tag, ...fields }` | `operation.field`    |
| `payload: MySchemaClass` (Schema.Class)             | `false` — has `fields` | `{ _tag, ...fields }` | `operation.field`    |
| `payload: Schema.String` (scalar)                   | `true` — no `fields`   | `{ _tag, _payload }`  | `operation._payload` |

Discriminator: `Schema.isSchema(payload) && !("fields" in payload)`. Schema.Class has `fields`, scalars don't.

## Effect LSP Linting

- Config lives in `.effect-lsp.json` / `.effect-lsp.test.json` — NOT in tsconfig plugins
- CLI needs `--lspconfig "$(cat .effect-lsp.json)"` — without it, reports "Checked 0 files"
- `tsconfig.src.json` / `tsconfig.test.json` scope which files get checked
- `globalDate` is error in src, off in test (test setup uses `Date.now()`)

## Gotchas

- `Effect.die(new Error(...))` is idiomatic for defects — no LSP rule catches it (by design)
- Entity `interrupt` clears the mailbox via `clearAddress`; in-flight handlers run to completion (Sharding.passivate not public)
- Entity peek returns **encoded** values from storage; `decodeValue` uses `Schema.decodeUnknownEffect` with fallback
- Workflow peek uses real `Exit.Exit` (not encoded) — walk `Cause` tree via `Cause.findErrorOption`/`findDefect`/`findInterrupt`
- v3 `Cause` API differs: use `failureOption`/`dieOption`/`isInterruptedOnly` instead of v4's `findErrorOption`/`findDefect`/`findInterrupt`
- v3 `Effect.repeat({ schedule, while })` returns the schedule's `Out`, not the effect's value — for waitFor-style polls in v3, use `Stream.repeatEffectWithSchedule` + `takeUntil` + `runLast`
- `withCompensation` is NOT on the actor — it's a workflow primitive. Import from `Workflow` directly.
- Workflow `executionId` (the cluster slot the engine writes to) = upstream's hashed execution id for `id(payload)` — NOT the raw `id(payload)` string. `Workflow*.peek/rerun/executionId` use `wf.executionId(payload)` internally so they line up with the engine's writes.
- Adapters MUST implement `EncoreMessageStorage.deleteEnvelope` for entity `.rerun` to work; the unimplemented fallback dies loudly rather than silently coarsening to flush.
