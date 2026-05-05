---
"effect-encore": minor
---

Add `ActorSenderLayer` — a bundle of `ActorMailbox` + `ActorAddressResolver` + `Snowflake.Generator` (all on the `fromConfig` variants) for sender-only / ops-only hosts. Cuts the producer wiring from a three-layer `Layer.mergeAll` to a single `ActorSenderLayer.layer` (still requires `MessageStorage` + `ShardingConfig`).

`ActorSenderLayer.layerMemory` provides the same bundle with in-memory storage and default sharding config preset — drop-in for tests and single-process setups.

The underlying `ActorMailboxLayer` / `ActorAddressResolverLayer` factories remain exported unchanged for advanced wiring (e.g. ops-only hosts that need address math but not `.send`).
