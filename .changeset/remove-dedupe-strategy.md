---
"effect-encore": patch
---

Remove the `DedupeStrategy` operation option and helper exports.

Deduplication policy stays at the actor operation boundary through the `id` function: return a stable `primaryKey` for durable at-most-once work, or include the higher-level scheduling/rerun semantics in that key when fresh work should be allowed.
