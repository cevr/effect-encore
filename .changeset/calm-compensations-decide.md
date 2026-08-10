---
"effect-encore": minor
---

Add one-call pending compensation decisions. Distinguish no pending compensation from a stale or conflicting exact-attempt decision. Remove `stepId` and `attempt` from `CompensationNotPendingError`. Conflict errors now carry those fields and the accepted decision when one exists.
