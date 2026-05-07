---
"effect-encore": minor
---

Add an Encore-owned live actor state protocol for entity handlers.

Entity handlers can now call `Actor.registerState({ get, watch })` from the entity scope. The registration is keyed by the current entity address and is automatically deregistered when the entity scope closes.

Entity actors expose `getState(entityId, { materialize? })`, `watchState(entityId, { materialize? })`, and `listStateEntityIds()` so host apps no longer need to maintain side registries for actor-local state snapshots and streams.

Also modernizes the project tooling to the `@effect/tsgo` / tsgo setup, upgrades the v4 line to the latest Effect beta, enables type-aware oxlint, and mirrors the state protocol across the v3 entrypoint.
