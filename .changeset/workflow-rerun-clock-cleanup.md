---
"effect-encore": patch
---

Workflow `.rerun(payload)` now clears the `Workflow/-/DurableClock` sub-entity in addition to the workflow's own address.

Previously, a workflow that used `step.sleep` (durable path, i.e. duration ≥ `inMemoryThreshold`) would leave the clock entry behind after `.rerun`. The orphan clock would later fire into a workflow that no longer expects it. Mirrors upstream's `clearClock` (`@effect/cluster/ClusterWorkflowEngine` ~L124-134), which only triggers when a running fiber observes the InterruptSignal — not when the workflow is suspended waiting on the clock.

Also fixes a workflow `toLayer` / `toTestLayer` type leak: `WorkflowInstance`, `Execution<Name>`, and `Scope.Scope` no longer leak into the layer's `RIn`. These are runtime-injected by the engine and shouldn't appear in the user's required environment. Type-level regression tests added in both v3 and v4.
