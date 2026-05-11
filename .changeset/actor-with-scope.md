---
"effect-encore": minor
---

`Actor.toLayer` and `Actor.toTestLayer` now accept a `withScope` option that builds a per-call `Context` from the entity address. The returned context is merged into each handler invocation via `Effect.provide`, so handlers can `yield* Tag` to read services derived from the entity id without threading them as parameters.

```ts
class WorkspaceId extends Context.Service<WorkspaceId, string>()("…/WorkspaceId") {}

Actor.toLayer(MyActor, handlers, {
  withScope: (address) =>
    Effect.succeed(Context.make(WorkspaceId, parseWorkspace(address.entityId))),
});
```

`withScope` runs before every handler call (not once per activation), so it can read the live `CurrentAddress` and derive different scopes for different entities. Tags it provides become available to handlers via `yield* Tag` and are reflected as a typed `S` in the layer's requirements (excluded so they're satisfied by `withScope` itself, not external Layer plumbing).

Use this to lift per-actor-instance setup — workspace ids, request-scoped storage handles, anything derived from the entity key — out of the actor's outer Layer and into a single ergonomic option on `toLayer`.
