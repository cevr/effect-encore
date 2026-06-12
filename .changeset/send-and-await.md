---
"effect-encore": minor
---

Add `Op.sendAndAwait(payload, { timeout, schedule? })` to entity operation handles: fire a durable send and poll the persisted reply until terminal, without requiring local Sharding. Sender-only hosts (ActorSenderLayer / storage-backed sender runtimes) can now await an entity's applied result instead of being limited to fire-and-forget send. Persisted Failure replies surface in the error channel; Defect/Interrupted die; exceeding the (required) timeout fails with the new `SendAndAwaitTimeout` tagged error. Also exported: `SendAndAwaitTimeout`.
