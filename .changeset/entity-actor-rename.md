---
"effect-encore": minor
---

Rename `ActorObject` to `EntityActorObject` and add first-class identity properties.

- `actor.name` — the actor's name (e.g. `"VectorUpdate"`)
- `actor.type` — the cluster entity type (e.g. `"VectorUpdate"` for entities, `"Workflow/GeocodeLocation"` for workflows)
- `Actor.isEntity(actor)` — type guard narrowing to `EntityActorObject`
- `Actor.isWorkflow(actor)` — type guard narrowing to `WorkflowActorObject`
- `_tag` changed from `"ActorObject"` to `"EntityActorObject"`
