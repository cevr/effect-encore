---
"effect-encore": minor
---

Workflow step DSL and caller API cleanup.

**Breaking:** `ref.call` → `ref.execute`, `ref.cast` → `ref.send`. Workflow `actor(entityId)` → `actor()` (nullary). Workflow handler receives `(payload, step)` instead of `(payload, executionId)`.

**New:** `WorkflowStepContext` with `step.run`, `step.sleep`, `step.signal`, `step.race`, `step.attempt`, `step.suspend`, `step.executionId`, `step.idempotencyKey`, `step.scope`, `step.provideScope`, `step.addFinalizer`, `step.raceSignals`. `WorkflowSignal` for external signal resolution. `waitFor` on both entity and workflow actors. `signal()` on `WorkflowActorObject`. `WorkflowDef` absorbs `suspendedRetrySchedule`, `captureDefects`, `suspendOnFailure`.
