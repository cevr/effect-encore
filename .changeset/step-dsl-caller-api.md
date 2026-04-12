---
"effect-encore": minor
---

Workflow step DSL, caller API cleanup, and declarative signals.

**Breaking:** `ref.call` → `ref.execute`, `ref.cast` → `ref.send`. Workflow `actor(entityId)` → `actor()` (nullary). Workflow handler receives `(payload, step)` instead of `(payload, executionId)`. `step.signal()` and `WorkflowActorObject.signal()` removed — signals are now declared on `WorkflowDef.signals` and become typed properties on the actor.

**New:** `WorkflowStepContext` with `step.run`, `step.sleep`, `step.race`, `step.attempt`, `step.suspend`, `step.executionId`, `step.idempotencyKey`, `step.scope`, `step.provideScope`, `step.addFinalizer`, `step.raceSignals`. Declarative `signals` on `WorkflowDef` — `SignalDef`, `SignalDefs` types. `WorkflowSignal` properties on the actor for external resolution. `waitFor` on both entity and workflow actors. `WorkflowDef` absorbs `suspendedRetrySchedule`, `captureDefects`, `suspendOnFailure`.
