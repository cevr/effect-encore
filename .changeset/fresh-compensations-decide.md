---
"effect-encore": minor
---

Expose pending workflow compensation attempts. Return no pending attempt for a completed run. Reject stale and conflicting operator decisions with a typed error. Wait until the durable winning decision is visible before returning.
