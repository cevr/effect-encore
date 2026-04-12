---
"effect-encore": minor
---

Unified call site for entities and workflows.

**Breaking changes:**

- `Actor.make` renamed to `Actor.fromEntity`
- `primaryKey` is now mandatory on all operations
- `cast` returns `ExecId<Success, Error>` (branded string) instead of `CastReceipt`
- `peek`, `watch` moved to actor object methods (`actor.peek(execId)`, `actor.watch(execId)`)
- Standalone `peek`, `watch`, `NoPrimaryKeyError`, `CastReceipt`, `makeCastReceipt` exports removed
- `Workflow` namespace export removed — import `Activity`, `DurableDeferred`, `DurableClock` from upstream directly

**New features:**

- `Actor.fromWorkflow(name, def)` — workflow actors with unified `ref.call`/`ref.cast` interface
- `ExecId<Success, Error>` — branded execution identifier with phantom types for typed `peek`
- `actor.peek(execId)` / `actor.watch(execId)` / `actor.interrupt(id)` on actor objects
- `PeekResult` now includes `Suspended` variant for workflow state
- Workflow actors support `resume`, `executionId`, `withCompensation`
- `Actor.toTestLayer` for workflows provides `WorkflowEngine.layerMemory` automatically
