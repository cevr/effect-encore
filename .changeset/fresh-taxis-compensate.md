---
"effect-encore": major
---

Make workflow compensation replay-safe. Add operator retry and stop controls for failed compensation Activities. Use Effect Activity retry slots for `step.run` retries. Remove the low-level `makeStepContext` export so workflow assembly stays inside `Actor`.

Replace `retry: schedule` with `retry: { times }`. Effect Activity retries assign a durable slot to each attempt. They do not accept schedules because schedule delays are not durable.
