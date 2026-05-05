---
"effect-encore": minor
---

Fix producer-only `.send()` deadlock by introducing two narrow Tags that replace the previous `ActorClientService` dispatch surface.

**The bug.** `OperationHandle.send` previously dispatched through `Sharding.makeClient`, which routes via `sendOutgoing → notifyLocal → waitForEntityManager`. In producer-only hosts (no handler registered for the entity), `notifyLocal` blocks until `entityRegistrationTimeout` (15s default) and then dies with `Entity type 'X' not registered`. This made producer-only `.send()` impossible through the public encore surface.

**The fix.** Two new Tags decouple the dispatch surface from `Sharding.Sharding`:

- `ActorAddressResolver` — pure address resolution. `fromConfig` (only `ShardingConfig`) replicates upstream's djb2 + bit-mix shard math; `fromSharding` delegates to live `Sharding`. Both produce identical `EntityAddress` for the same `(entityId, shardGroup)` (parity test enforces this).
- `ActorMailbox` — outbound dispatch. `fromConfig` (only `MessageStorage`) treats `SaveResult.Success` and `SaveResult.Duplicate` as enqueued; rejects non-persisted requests loudly so the platform's persisted gate is mirrored. `fromSharding` delegates to `sharding.sendOutgoing(request, true)`.

`OperationHandle.send` now requires `ActorMailbox | ActorAddressResolver | Snowflake.Generator`. `peek/watch/waitFor/rerun/flush/redeliver/interrupt` swap `Sharding.Sharding` for `ActorAddressResolver`. `Actor.toLayer` and `Actor.toTestLayer` provide the consumer-side support layers automatically — existing consumer hosts see no behavior change.

**Producer-only / ops-only hosts** must wire the `fromConfig` variants explicitly:

```ts
Layer.mergeAll(
  ActorMailboxLayer.fromConfig,
  ActorAddressResolverLayer.fromConfig,
  Snowflake.layerGenerator,
);
```

The consumer's storage poll loop (`Sharding.unprocessedMessages`) routes the envelope on the next `entityMessagePollInterval` tick — `notifyLocal` is an acceleration path, not the only delivery mechanism. Tradeoff: latency bounded by `entityMessagePollInterval`, not correctness.

Mirrored across both v3 (`v3/src/`) and v4 (`src/`) lines.
