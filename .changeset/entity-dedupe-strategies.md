---
"effect-encore": patch
---

Add entity operation dedupe strategies for v3 and v4 actors.

`dedupe: DedupeStrategy.AtMostOnce` remains the default persisted-entity behavior: completions are reused until `.rerun(payload)` explicitly clears the execId. `dedupe: DedupeStrategy.InProgress` marks the storage primary key for adapters that want active-only dedupe, where duplicate producers coalesce while work is in flight but fresh work can enqueue after terminal completion.
