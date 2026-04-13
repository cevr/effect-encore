---
"effect-encore": minor
---

Rename `.actor()` to `.ref()` on EntityActor and WorkflowActor. Fix `Actor.toLayer` to bubble handler requirements instead of `any`.

- `actor.ref(entityId)` — returns `ActorRef` (was `.actor()`)
- `Actor.toLayer` entity overload: return type `Layer<Service, never, RX | Scope | MiddlewareClient>` (was `any`)
- `Actor.toLayer` workflow overload: return type `Layer<Service, never, RX | WorkflowEngine>` (was `any`)
- `"ref"` replaces `"actor"` in reserved operation/signal names
