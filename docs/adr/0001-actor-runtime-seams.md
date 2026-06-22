# ADR-0001 — Actor-runtime seams: Client, State&lt;A&gt;, ReplySource

- **Status:** accepted
- **Date:** 2026-06-22
- **Scope:** effect-encore `src/` (v4-only). The `v3/` compat leg was removed as part of this change — the package is now v4-only.

## Context

effect-encore is the **source of truth** for the actor runtime that Bite vendored as
`@biteinc/actor-runtime` (biteinc/maitred PR #18843). That downstream effort reshaped
three things on top of the encore lineage:

1. a Rivet-shaped `State<A>` mutable-state value type,
2. a `Client.layer` transport seam, and
3. (implicitly) an await/reply engine that wants its own seam.

We are porting that reshaping **back into encore**, v4-only, then publishing a new
minor so the downstream GYC Order PR can depend on it. Because encore is the source —
not a vendor — there is **no `DIVERGENCE.md`**; this ADR is the durable record of the
seam decisions and their provenance.

The repo already absorbed the mailbox/resolver/sender split (`actor-mailbox.ts`,
`actor-address-resolver.ts`, `actor-sender.ts`), `EncoreMessageStorage`
(`storage.ts`), `entity-id-codec.ts`, and `receipt.ts` (`makeExecId` + `PeekResult`).
So this work lands **three named seams** as architecturally-correct modules and
reconciles the test suite — it is not a re-vendoring.

## Decision

We adopt the three seams recorded in `CONTEXT.md` §Seams as the agreed vocabulary.
This ADR reproduces them verbatim and records the design choices around them.

### Seam 1 — `Client` (the unified transport seam)

> **Client** — the unified transport seam. One Tag owning `send / resolve / peek /
flush / redeliver` plus the wire-envelope builder, with adapters
> `Client.layer.{fromConfig, fromSharding, memory, test}`. Supersedes the
> hand-assembled mailbox+resolver+Snowflake triad. Address resolution
> (`fromConfig`/`fromSharding`, carrying the shard-parity invariant) survives as an
> **internal strategy** the Client holds, not a public Tag.

**Why Client diverges from Bite's thin namespace.** Bite shipped a thin `client.ts`
where `layer = {fromConfig, fromSharding, memory}` and `fromConfig =
ActorSenderLayer.layer` — owning none of `send/resolve/peek/flush/redeliver`, pulling
nothing inside, and dropping the `test` adapter. **Because encore is the source, it
ships the DEEP Tag instead:** a `Context.Service` Tag that OWNS
`send/resolve/peek/flush/redeliver` with the wire-envelope builder
(`buildOutgoingRequestForSend`, incl. the persisted-gate annotation-derivation) pulled
**inside the seam**, and **all four** adapters including `test`. `peek` composes the
`ReplySource` seam (below) rather than re-implementing Exit-walking. Address resolution
stays an **internal strategy** the Client holds — the resolution _Tag_ is internal (by
non-export); the resolver/mailbox _layer factories_ stay exported because they carry
load-bearing shard-parity isolation coverage that `Client.layer.*` cannot replace (a
bundled adapter cannot isolate the resolver to pin the `actor-address-resolver.ts:24-27`
shard-parity invariant).

This supersedes Bite's `cad5fc7` thin namespace; only `ActorSenderLayer` is de-exported
(the four `Client.layer.*` adapters fully supersede that high-level bundle).

### Seam 2 — `State<A>` (the per-entity mutable state handle)

> **State\<A\>** — the per-entity mutable state handle: `get / set / update / changes`,
> with **per-State mutation serialization** (concurrent `update`s linearized). Grown
> from the read-only `ActorStateHandle` (`get`+`watch`). In-process
> (`SubscriptionRef`) today; durable per-entity backing (`cluster_states` + CAS) is a
> deferred follow-up, not in the port.

`registerState` is the consume-point: it grows to accept `State<A, E, R>` and DERIVES
the registry-internal read-only handle (`get` / `watch`). The public state vocabulary
becomes `State<A>`; the `ActorStateHandle` interface is demoted to registry-internal
and leaves the public barrel. Per-State mutation serialization uses
`Semaphore.makeUnsafe(1)`; the replay-1 change stream mirrors `SubscriptionRef`
(`PubSub.unbounded({ replay: 1 })`). This is the additive port of Bite `82d0b4c`.

### Seam 3 — `ReplySource` (the await-engine's seam)

> **ReplySource** — the await-engine's seam: `(ExecId) => Effect<PeekResult>`. Lifts
> the mechanism (ExecId mint/parse, Exit→PeekResult mapping, the `waitFor` poll loop)
> out of `actor.ts` into `receipt.ts`, so the reply-source is swappable and the
> Exit-classification logic is unit-testable. **Default adapter = `MessageStorage`**
> (the existing storage-backed `peekImpl`). Downstreams that resolve a token from an
> external event (e.g. a Stripe webhook) drive it through the same default SQL
> `MessageStorage` — the reply lands in `cluster_replies` and `peek`/`waitFor` see it
> terminal. The seam also collapses the triplicated ExecId format into one
> **ExecIdCodec**.

`ReplySource` is a `Context.Service` Tag whose default adapter (`fromMessageStorage`)
wraps the existing `peekImpl` body, keeping its R-channel
`MessageStorage | ActorAddressResolver` and the `OperationDefs` schema-decode threaded.
This is **behavior-preserving**: the live entity path runs through the same default
adapter. It is a testability + swappability refactor, NOT a GYC blocker.

## Rivet-DX provenance

The names `State<A>` and `Client` are **DX targets borrowed from Rivet** (rivet's
`State.ts` / `Client`), not new runtime machinery. We adopt the ergonomic surface, not
a Rivet runtime. The one documented Rivet divergence is that `commit` self-feeds the
change stream (kept inline with the original comment). The `State` `TypeId` brand is
rebranded from Bite's `@biteinc/actor-runtime/state/State` to
`effect-encore/state/State` — an in-process brand only, NOT a persisted wire string,
so the rebrand is safe.

## The frozen ExecId wire contract

`ExecId` is a branded string of the form `entityId\x00tag\x00primaryKey`. It is
persisted into `cluster_messages` as the dedup identity (`CONTEXT.md:13-15`), so its
byte layout is a **frozen wire contract**. The `ExecIdCodec` seam centralizes
CONSTRUCTION and parsing into one boundary — it MUST NOT change bytes (no
normalization, no escaping). Single-segment workflow ids (`makeExecId(executionId)`)
must round-trip through `decode` exactly as the legacy `parseExecId` fallback did
(`entityId == tag == primaryKey == execId`). A golden-string test and a round-trip test
pin this.

## v4-only scope and import surface

This reshape is **v4-only**. The former `v3/` (`effect@3` / `@effect/cluster`) compat
leg was removed as part of this change — the package now ships a single v4 build. All
code lives in `src/` and imports cluster/storage from **`effect/unstable/cluster`** — the
v4-beta surface (`MessageStorage`, `ShardingConfig`, `Snowflake`, `Sharding`; verified
`src/actor-sender.ts:21`, `src/actor.ts:14`) — **NOT `@effect/cluster`**. Bite's vendored
source is also on `effect/unstable/cluster`, so there was **no import-surface translation**
needed when porting the reshape into `src/`.

Pinned facts: `package.json` version `0.12.8`; `peerDependencies.effect`
`>=4.0.0-beta.66`; dev/resolved `effect@4.0.0-beta.75`.

## Deferred (recorded, not implemented in this port)

- **Durable per-entity `State` backing** via `cluster_states` + CAS. `State<A>` is
  in-process (`SubscriptionRef`) only in this port.
- **`fromWorkflow` split** + folding `makeActorStateLayer` / `makeActorControlLayer`
  inward. Gated on a re-measured post-Client-seam `actor.ts` line count; defer-by-default.

## Consequences

- The public `.send` R-channel collapses from the
  `ActorMailbox | ActorAddressResolver | Snowflake.Generator` triad to a single
  `Client` Tag (intended type-level break, per the deep-Client decision).
- `registerState` accepts `State<A>` instead of `{get, watch}`; `ActorStateHandle`
  leaves the public barrel (breaking; a backward-compat overload was rejected per
  migrate-callers-then-delete and encore being pre-1.0).
- Only `ActorSenderLayer` is de-exported; `ActorMailboxLayer` /
  `ActorAddressResolverLayer` stay exported as the internal resolution strategy.
- `ExecIdCodec` and `ReplySource` become exported, unit-testable seams.

These breaks ship in one minor; at `0.x` a minor carrying documented breaks is the
correct signal. The accompanying changeset documents each break.
