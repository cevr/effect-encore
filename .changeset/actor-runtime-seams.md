---
"effect-encore": minor
---

Land the three actor-runtime seams (`Client`, `State<A>`, `ReplySource`) recorded in ADR-0001, reshaping the v4 runtime for the downstream GYC Order entity, and **drop the v3 compatibility leg** — `effect-encore` is now v4-only.

**New additive surface**

- **`State<A>` value type** (`export * as State`) — a Rivet-shaped per-entity mutable-state cell: `get / set / update / updateAndGet / modify / changes / publish`, with **per-State mutation serialization** (concurrent `update`s are linearized via a per-State semaphore) and a replay-1 `changes` stream that mirrors `SubscriptionRef` (late subscribers see the latest value). In-process (`SubscriptionRef`) today; durable per-entity backing (`cluster_states` + CAS) is a deferred follow-up.
- **`ReplySource` seam** — the await-engine lifted out of `actor.ts` into `receipt.ts` as a `Context.Service` Tag `(ExecId) => Effect<PeekResult>`, with the default adapter `ReplySourceLayer.fromMessageStorage` wrapping the existing storage-backed `peekImpl`. Exit→PeekResult classification is now unit-testable without a live cluster. Behavior-preserving: the live entity path runs through the same default adapter.
- **`ExecIdCodec`** — a single mint/parse boundary for the frozen `entityId\x00tag\x00primaryKey` ExecId wire format (previously triplicated). Byte-identical; single-segment workflow ids round-trip exactly. Pinned by a golden-string + round-trip test.
- **`Client` deep transport Tag** (`Client`, `Client.layer.{fromConfig, fromSharding, memory, test}`) — a `Context.Service` Tag owning `send / resolve / peek / flush / redeliver` with the wire-envelope builder (incl. the persisted-gate annotation-derivation) pulled inside the seam. `peek` composes the `ReplySource` seam. Address resolution stays an internal strategy. Supersedes the hand-assembled mailbox+resolver+Snowflake triad; adds the `test` adapter Bite dropped.

**Breaking changes** (at `0.x` a minor carrying documented breaks is the correct signal)

- **`registerState` now consumes `State<A>`** instead of `{ get, watch }`. Callers build a `State<A>` first (`Actor.State.make(...)`) and pass it to `Actor.registerState(state)`; the registry derives the internal read-only handle. A backward-compat overload (`registerState(State<A> | {get,watch})` guarded by `State.isState`) was **rejected** per migrate-callers-then-delete — encore is pre-1.0, so a minor carrying a documented break is correct rather than carrying a parallel API.
- **`ActorStateHandle` left the public barrel** — demoted to a registry-internal detail. The public state vocabulary is `State<A>`. (`ActorStateRegistryShape` stays exported.)
- **The public `.send` R-channel collapses** from `ActorMailbox | ActorAddressResolver | Snowflake.Generator` to a single `Client` Tag — the intended type-level effect of the deep-Client decision. `SenderContext` is re-pointed to `Client` accordingly. Producer-op composition now requires `Client` in `R`.
- **Only `ActorSenderLayer` is de-exported** (the four `Client.layer.*` adapters fully supersede that high-level bundle). `ActorMailboxLayer` / `ActorAddressResolverLayer` and the `ActorMailbox` / `ActorAddressResolver` Tags stay exported as the internal resolution strategy — they carry load-bearing shard-parity isolation coverage that `Client.layer.*` cannot replace.
- **The `effect-encore/v3` entry point is removed.** The package no longer ships an `effect@3` build — the `./v3` export, the `v3/` source/test tree, and the v3-only toolchain (`effect-v3`, the v3 `tsdown`/`tsconfig`/`typecheck`/`test` legs) are gone. Consumers still on `effect@3` should pin the last `0.12.x` release. With v3 gone, the now-unused optional peer dependencies `@effect/cluster` / `@effect/rpc` / `@effect/sql` / `@effect/workflow` are dropped — v4 `src/` imports cluster/rpc/workflow exclusively from `effect/unstable/*`, so `effect (>=4.0.0-beta.66)` is the only peer.
