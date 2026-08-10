---
"effect-encore": minor
---

Add `WorkflowActor.prune(executionId)` and route workflow storage cleanup through the Client seam.
Keep `MessageDeletion` focused on the single-invocation deletion that Effect does not provide.
