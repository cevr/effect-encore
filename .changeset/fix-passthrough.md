---
"effect-encore": patch
---

Fix `Actor.toLayer` layer composition — use passthrough so Sharding/WorkflowEngine flow through to program code.

The handler layer consumes these services without re-providing them, so `ref.execute()` and `ref.send()` couldn't find them at runtime. v3 uses `Layer.passthrough`; v4 uses a local polyfill via `Layer.merge(Layer.effectContext(Effect.context<RIn>()), layer)`.
