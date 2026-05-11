---
"effect-encore": minor
---

Add `Actor.waitForState(entityId, predicate)` and `waitForStateOf(address, predicate)` for predicate-driven state observation. Resolves on the first state snapshot satisfying the predicate. Compose `Effect.timeout` for time-bounded waits.
