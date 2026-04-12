---
"effect-encore": minor
---

Rename `ActorObject` to `EntityActor`, `WorkflowActorObject` to `WorkflowActor`. Add first-class identity and type guards.

- `actor.name` — the actor's name (e.g. `"VectorUpdate"`)
- `actor.type` — the cluster entity type (e.g. `"VectorUpdate"` for entities, `"Workflow/GeocodeLocation"` for workflows)
- `Actor.isEntity(actor)` — type guard narrowing to `EntityActor`
- `Actor.isWorkflow(actor)` — type guard narrowing to `WorkflowActor`
- `AnyEntityActor`, `AnyWorkflowActor`, `AnyActor` convenience types
- `_tag` values: `"EntityActor"` / `"WorkflowActor"`
