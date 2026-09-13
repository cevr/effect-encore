---
"effect-encore": minor
---

Read actor state by entity type and id without a `ShardId`

`ActorStateRegistry` keys handles on entity type plus entity id and ignores
the shard, but `stateOf`, `watchStateOf`, `waitForStateOf`, and
`ActorStateObservation` demanded a full `EntityAddress`. A consumer that
enumerated ids through `listStateEntityIds` had to invent a placeholder
`ShardId.make("default", 0)` to read the state it had just listed.

The read functions now take `ActorStateKey` (`{ entityType, entityId }`).
An `EntityAddress` satisfies it structurally, so existing callers keep
working. `register` and `deregister` still take the address the actor
runs under.
