# effect-encore actor-runtime reshape — port plan

> Synthesized authoritative plan. Merges the PORT-FIDELITY-FIRST plan (A) and the
> DEEPENING-FIRST plan (B) and resolves both adversarial cross-reviews. Every claim
> below was re-verified against the real tree at `main` (encore `0.12.8`,
> `effect@4.0.0-beta.75`). This document is the load-bearing spec for a `--deep`
> review and a commit-by-commit implementation.

## Overview

The repo is the **source of truth** for the actor runtime that Bite vendored as
`@biteinc/actor-runtime` (PR biteinc/maitred#18843). That PR shaped three things on
top of the encore lineage: a Rivet-shaped `State<A>` value type, a `Client.layer`
transport seam, and (implicitly) an await-engine that wants its own seam. We are
porting that **reshaping back into encore**, v4-only, then publishing a new minor so
the downstream GYC Order PR can depend on it.

This is **not** a from-scratch port. The repo already absorbed the mailbox/resolver/
sender split (`actor-mailbox.ts`, `actor-address-resolver.ts`, `actor-sender.ts`),
`EncoreMessageStorage` (`storage.ts`), `entity-id-codec.ts`, and `receipt.ts`
(`makeExecId` + `PeekResult` already exported). So the work is landing **three named
seams** as architecturally-correct modules and reconciling the test suite — not
re-vendoring.

The three seams are the **ALREADY-MADE decisions** recorded in `CONTEXT.md` §Seams.
This plan honors them verbatim; it does **not** relitigate them:

1. **Client** (`CONTEXT.md:21-25`) — ONE Tag owning `send / resolve / peek / flush /
redeliver` **plus the wire-envelope builder**, pulled INSIDE the seam. Adapters
   `Client.layer.{fromConfig, fromSharding, memory, test}`. Address resolution stays
   an **internal strategy** (not a public Tag), carrying the shard-parity invariant
   (`actor-address-resolver.ts:24-27`). This is the Bite `Client.layer` work
   **sharpened** — NOT Bite's thin namespace.
2. **State\<A\>** (`CONTEXT.md:26-30`) — grow the read-only `ActorStateHandle`
   (`get`+`watch`, `actor-state.ts:13-16`) into a Rivet-shaped `State<A>`
   (`get/set/update/changes` + per-State mutation serialization). `registerState`
   (`actor-state.ts:87-96`) is the consume-point. Additive; registry seam + tests
   survive. Durable backing deferred.
3. **ReplySource** (`CONTEXT.md:31-38`) — lift the await ENGINE out of `actor.ts`
   into `receipt.ts`: an `ExecIdCodec` (collapse the triplicated
   `entityId\x00tag\x00primaryKey` format), a `ReplySource = (ExecId) =>
Effect<PeekResult>` Tag, and the Exit→PeekResult mapping. Default adapter =
   `MessageStorage` (existing `peekImpl`). Makes Exit-classification unit-testable.

### The central synthesis decision

The two source plans disagree on exactly ONE thing of substance: the **Client seam
shape**.

- Plan A (port-fidelity) ships Bite's **thin** `client.ts` verbatim:
  `layer = {fromConfig, fromSharding, memory}` where `fromConfig = ActorSenderLayer.layer`.
  It owns none of `send/resolve/peek/flush/redeliver`, pulls nothing inside, and
  drops the `test` adapter.
- Plan B (deepening) ships the **deep** Client Tag that owns the operations and pulls
  the wire-builder + ops-path inside, with all four adapters.

**Decision #1 (CONTEXT.md:21-25) settles this: the deep Tag wins.** A's own
cross-review concedes its E4 "is a direct contradiction of a settled decision." So
this plan takes **B's deep Client design**, **B's ReplySource-as-Context.Service-Tag
framing**, and **A's superior receipts, sequencing discipline, frozen-wire-format
golden test, per-commit-green honesty, and changeset-release flow.**

### Commit order rationale (resolving A's open question on GYC's critical path)

The GYC Order entity consumes, in order of need:

1. **State\<A\>** — the Order's `pending|paid|cancelled|refunded|expired` lifecycle is
   a `State<A>` cell. **Critical path.**
2. **SQL `MessageStorage`** — already shipped (`storage.ts` `fromSqlClient`). **Not in
   this PR.**
3. **The await/reply mechanism** — the Stripe webhook resolves the `process` op's
   ExecId. Today this works through the **existing storage-backed `peekImpl`**: the
   webhook drives a reply into `cluster_replies` and `peek`/`waitFor` see it terminal
   (`CONTEXT.md:34-37`). **`ReplySource` is a testability + swappability refactor of
   that exact path, behavior-preserving — it is NOT a GYC blocker.** GYC could consume
   the published encore even if ReplySource shipped later.

So the **critical-path ordering for GYC is State\<A\> and Client**, with ReplySource
and ExecIdCodec being correctness/testability wins that ship in the _same_ minor but
off GYC's blocking path. We therefore sequence the **ExecIdCodec first** (it is the
smallest, lowest-risk, zero-behavior-change seam and unblocks the ReplySource lift),
then **State\<A\>** (GYC-critical, self-contained, low coupling to actor.ts), then
**ReplySource** (lifts the await engine), then the **deep Client** (the heaviest
actor.ts churn, depends on the lifted ops-path), then the conditional **fromWorkflow
split**, then the **ADR + changeset + publish**.

This front-loads GYC's critical path (State\<A\> lands at E3) while keeping each
commit gate-green and minimizing rework: the ExecIdCodec and ReplySource lifts shrink
`actor.ts` _before_ the Client seam moves the ops-path, so the Client commit consumes
already-lifted, already-tested helpers instead of moving raw inline code twice.

## Architecture decisions this plan honors

| #   | Decision                                                                                                                         | Source           | This plan                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| 1   | Deep `Client` Tag (send/resolve/peek/flush/redeliver + wire-builder inside; 4 adapters incl. `test`; resolver internal strategy) | CONTEXT.md:21-25 | **E5** (B's design)                                          |
| 2   | `State<A>` grown from `ActorStateHandle`, `registerState` consume-point, additive                                                | CONTEXT.md:26-30 | **E3 + E4**                                                  |
| 3   | `ReplySource` seam + `ExecIdCodec`, default adapter = MessageStorage, Exit-classification unit-testable                          | CONTEXT.md:31-38 | **E1 (codec) + E2 (ReplySource)**                            |
| 4   | `fromWorkflow` split + fold `makeActorStateLayer`/`makeActorControlLayer` inward — DEFER unless port churns actor.ts heavily     | prompt           | **E6, gated on a re-measured line-count threshold after E5** |
| —   | Port scope = full reshape + tests + an **ADR** (NO DIVERGENCE.md — encore is the source, not a vendor)                           | prompt           | **E0 (ADR shell) + E7 (finalize)**                           |
| —   | Durable per-entity `State` backing (`cluster_states`+CAS) is DEFERRED                                                            | CONTEXT.md:29-30 | recorded in ADR, **not implemented**                         |

## Verified facts (receipts)

- **Test files:** `ls test/*.test.ts` = **23**, `find test -name '*.test.ts'` = **24**
  (the +1 is `test/integration/cluster.test.ts`). Plan A's "24/25" is correct; Plan
  B's repeated "47" is **wrong** — corrected throughout this plan. After adding
  `state.test.ts` + `client-layer.test.ts` the count becomes **26**.
- **Version / peer:** `package.json` version `0.12.8`; `peerDependencies.effect` =
  `>=4.0.0-beta.66`; dev/resolved `effect@4.0.0-beta.75`.
- **`package.json` exports** = `.` and `./v3` only — **no `./*` wildcard**, so subpath
  imports of internal factories are already impossible; the barrel is the only lever.
- **gate** = `concurrently typecheck(v4+v3) lint:fix fmt test:all build`, where
  `test:all = test (v4) && test:v3`, and `build` emits both v4 and v3 via `tsdown`.
  Every commit below must keep the **v3 leg green untouched** (v3/ is the isolated
  legacy build; the reshape is v4-only).
- **effect v4 beta.75 API presence (verified in `node_modules/effect/dist`):**
  `PubSub.unbounded({ replay: 1 })` (PubSub.d.ts replay option lines 322/368/413),
  `Semaphore.makeUnsafe(1)` + `Semaphore.withPermit` (Semaphore.d.ts:197),
  `Effect.fnUntraced`, `dual` from `effect/Function` (Function.d.ts:137),
  `Inspectable`, `Pipeable`, `Predicate`, `SubscriptionRef` — all present.
- **ExecId sites (verified `src/actor.ts`):** `parseExecId` @**817-830**; entity mint
  @**1385** (`${entityId}\x00${tag}\x00${primaryKey}` via address-resolved `entityId`);
  entity mint @**1956** in `buildActorRef.send` (`${_entityId}\x00${tag}\x00${primaryKey}`
  — note: uses the **local `_entityId`**, not a resolver call; both forms are
  byte-identical 3-tuples and must round-trip). Workflow execIds are **single-segment**
  `makeExecId(executionId)` @**2322 / 2332 / 2486** and use `WorkflowEngine.poll`
  (`peekById` @**2274**), NOT the entity `peekImpl` — so they are unaffected by the
  ExecIdCodec/ReplySource entity path.
- **Await-engine sites (verified):** `peekImpl` @**984-1021** (R =
  `MessageStorage | ActorAddressResolver`), `decodeValue` @**1023**, `mapExitToPeekResult`
  @**1029-1050** (encoded `ExitEncoded`), `mapExitToWorkflowPeekResult` @**1053-1068**
  (real `Exit.Exit`, Cause-walk), `makeWaitFor` @**1104-1120** (ALREADY parameterized
  on `peekFn` — half-built), repointed at `sendAndAwait` @**1435** and `waitFor`
  @**1481**.
- **Wire-builder + ops-path (verified):** `buildOutgoingRequestForSend` @**841-904**
  (the subtle persisted-gate annotation-derivation is @**882-893** — a comment
  literally warns `Context.empty()` would "silently route persisted requests as
  non-persisted"); `makeTestMailboxImpl` @**916-937**; `flushImpl` @**939-948**;
  `redeliverImpl` @**950-959**; `rerunImpl` @**963-982**. Dispatch call sites:
  `makeOperationHandle.sendFn` @**1393-1410**, `buildActorRef.send` @**1943-1958**.
- **State adapter layers (verified):** `makeActorControlLayer` @**1774-1801**,
  `makeActorStateLayer` @**1803-1859**.
- **`fromWorkflow` boundary (verified):** starts @**2202**; file is **2587** lines
  total, so the workflow lineage is ~**385** lines (the source plans' "2202-2491 / 290
  lines" undercounts — the real residual is larger, which _strengthens_ the E6 gating
  rationale).
- **`actor-sender.ts` already bundles `Snowflake.layerGenerator`** in both `layer` and
  `layerMemory` (verified) — so the deep Client's `fromConfig`/`memory` over the sender
  bundle inherit the Snowflake fix; only `fromSharding` must bundle
  `Snowflake.layerGenerator` explicitly (Bite BLOCKER: `Sharding.layer` installs its
  own generator without re-exposing the Tag, and `OperationHandle.send` needs it —
  `actor.ts:1397`).
- **index.ts exports today:** `ActorAddressResolver`/`ActorAddressResolverLayer`
  (78-79), `ActorMailbox`/`ActorMailboxLayer`/`MailboxError` (80), `ActorSenderLayer`
  (82), `ActorStateHandle` type (41). `registerState`/`Actor` accessed via the `Actor`
  namespace (`actor.ts:2572`); tests call `Actor.registerState(...)`.
- **Downstream GYC (verified, `feat/registrar` @ PR #35, current checkout):**
  `effect@4.0.0-beta.60` (GYC `package.json:29` dep / `:60` resolution) — **below encore's `>=beta.66` peer
  floor.** Order status today is `Schema.Literals(['pending','paid','failed','expired'])`
  (`app/lib/forms/order.ts:56`) — **no `cancelled`/`refunded`**. `createCheckoutSession`
  in `app/lib/payment.server.ts:142/211`; webhook at `app/routes/api.stripe-webhook.ts`.

## Bite commit provenance (what we port, transform, or drop)

| Bite commit                                                           | Role        | This plan                                                           |
| --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `3b19819` ADR-0001 + Phase 0d                                         | docs        | **transform → E0/E7 ADR** (encore is source: ADR, no DIVERGENCE.md) |
| `24add74` vendor verbatim copy (0d.1)                                 | vendor-only | **DROP** (encore IS the source)                                     |
| `f3a3149` oxlint-conformance on vendored sources (0d.2b)              | vendor-only | **DROP**                                                            |
| `82d0b4c` Rivet-shaped `State<A>` + registerState consume-point (PR1) | reshape     | **port → E3 + E4** (rebrand TypeId)                                 |
| `cad5fc7` `Client.layer` thin namespace (PR2)                         | reshape     | **SUPERSEDE → E5 deep Tag** (decision #1)                           |
| `39d8459` caller-migration in Bite's app (PR3)                        | vendor-only | **DROP** (no Bite app here)                                         |
| `2b038c4` DIVERGENCE.md maintenance manual (PR4)                      | vendor-only | **transform → ADR content in E0/E7**                                |

The load-bearing reusable text is Bite's `state.ts` (ported near-verbatim in E3, only
the `TypeId` string `@biteinc/actor-runtime/state/State` → `effect-encore/state/State`
and the design-doc path change) and the `actor-state.ts` `registerState` reshape (E4).
Bite's `client.ts` is **reference only** — E5 is a deeper design than Bite shipped.

---

## Commit-broken implementation

> Convention: every commit must leave `bun run gate` green (v4 **and** v3 legs) unless
> an explicit coupled-pair note says the gate is asserted on the pair's final commit.
> "Files" lists primary edits; "Scope" is the load-bearing detail; "Gate" is the
> green checkpoint; "Deps" is the predecessor commit.

### E0 — docs(arch): ADR-0001 shell + track CONTEXT.md

- **Files:** NEW `docs/adr/0001-actor-runtime-seams.md`; `git add CONTEXT.md`
  (currently UNTRACKED — verified `git status`).
- **Scope:** Create the `docs/adr/` dir (none exists today — verified). Write
  ADR-0001 recording: (a) the three seams as the agreed vocabulary verbatim from
  CONTEXT.md §Seams; (b) the Rivet-DX provenance (`State<A>` and `Client` names are DX
  targets, not runtime — borrowed from rivet `State.ts`/`Client`); (c) **why Client
  diverges from Bite's thin namespace** — encore is the source, so it ships the DEEP
  Tag owning send/resolve/peek/flush/redeliver with the wire-builder inside, per
  decision #1; (d) the v4-only scope (v3/ frozen, isolated, no `../src` imports) — all
  ported code in `src/` imports cluster/storage from **`effect/unstable/cluster`**
  (the v4-beta surface: `MessageStorage`, `ShardingConfig`, `Snowflake`, `Sharding`,
  verified in `src/actor-sender.ts:21` / `src/actor.ts:14`), **NOT `@effect/cluster`**
  (that import is the isolated `v3/` leg only — `v3/src/actor-sender.ts:21`); Bite's
  vendored source is also on `effect/unstable/cluster`, so there is **no import-surface
  translation** needed when porting the reshape into `src/`; (e)
  the deferred items (durable `State` backing via `cluster_states`+CAS; the gated
  `fromWorkflow` split); (f) the **frozen ExecId wire contract** (`entityId\x00tag\x00
primaryKey` is persisted into `cluster_messages` dedup identity — centralizing
  construction must not change bytes). NO DIVERGENCE.md (encore is not a vendor). Leave
  a "Status: proposed → accepted on publish" marker that E7 ticks. Docs-only.
- **Gate:** `bun run gate` unchanged (docs + tracking only; no TS). Typecheck baseline
  already green.
- **Deps:** none.

### E1 — refactor(receipt): ExecIdCodec — single mint/parse boundary

- **Files:** `src/receipt.ts` (+~50), `src/actor.ts` (3 call sites), `src/index.ts`
  (export), NEW `test/exec-id-codec.test.ts`, edits to `test/receipt.test.ts`.
- **Scope:** Add `ExecIdCodec` to `receipt.ts` with two functions:
  `ExecIdCodec.encode({ entityId, tag, primaryKey }): ExecId` and
  `ExecIdCodec.decode(execId): { entityId, tag, primaryKey }`. The encode produces
  exactly `makeExecId(\`${entityId}\x00${tag}\x00${primaryKey}\`)`; the decode is the
current `parseExecId`body (verbatim from`actor.ts:817-830`, including the
single-separator and no-separator fallbacks). **Byte-identical** — this is
centralizing CONSTRUCTION, not changing the format. Rewire the three entity sites:
mint @1385 (`makeOperationHandle.execId`), mint @1956 (`buildActorRef.send`), and
delete the local `parseExecId`@817 (its only callers are`peekImpl`@994; repoint
to`ExecIdCodec.decode`). Export `ExecIdCodec`from`index.ts`.
  - **Single-segment workflow ids must round-trip:** `ExecIdCodec.decode` on a
    no-separator id (workflow `makeExecId(executionId)`) must reproduce the current
    `parseExecId` fallback exactly (`entityId == tag == primaryKey == execId`). The
    workflow path uses `WorkflowEngine.poll` and does NOT call `decode`, so it is
    unaffected — but the round-trip is pinned by a test so future refactors can't
    "fix" the ambiguity and break the entity path.
- **Gate:** `bun run gate`. NEW `test/exec-id-codec.test.ts`: `encode∘decode`
  round-trip incl. components with embedded/adjacent chars + single-segment workflow
  ids + a **golden-string** test asserting the exact `\x00`-joined byte output.
  `test/receipt.test.ts` gains `ExecIdCodec` cases under its existing `ExecId` describe
  block (@19). Existing `peek.test.ts` / `rerun.test.ts` unchanged-green (they pin the
  wire identity). v3 leg untouched-green.
- **Deps:** E0.

### E2 — refactor(receipt): ReplySource seam — lift the entity await-engine

- **Files:** `src/receipt.ts` (+~120), `src/actor.ts` (peekImpl/dispatch/waitFor
  rewire + the workflow `peekById` @2285 repoint to import the moved mappers from
  `receipt.ts`), `src/index.ts` (exports), edits to `test/receipt.test.ts`.
- **Scope:** Move the **entity** Exit-classification + await loop out of `actor.ts`
  into `receipt.ts` as pure, unit-testable functions:
  - `mapExitToPeekResult(exit: RpcMessage.ExitEncoded, def?)` (from `actor.ts:1029`),
    `mapExitToWorkflowPeekResult(exit: Exit.Exit)` (from `actor.ts:1053`), and
    `decodeValue(schema, value)` (from `actor.ts:1023`) become `receipt.ts` exports.
    Keep the encoded-vs-real Exit asymmetry exactly (entity uses `ExitEncoded`,
    workflow uses real `Exit.Exit` Cause-walk).
    - **Workflow caller repoint (verified):** `mapExitToWorkflowPeekResult` is consumed
      by the workflow `peekById` at **`actor.ts:2285`** (and `decodeValue` is used by
      both peek mappers). Moving these to `receipt.ts` requires repointing
      `actor.ts:2285` (the `fromWorkflow` `peekById` @2274, fed into the workflow
      `makeWaitFor` @2320) to **import them from `receipt.ts`**. The workflow path stays
      on `WorkflowEngine.poll` / `peekById` (verified — it is NOT the entity ReplySource
      path) and is otherwise untouched: only the import source for the two pure mapper
      functions moves. The entity vs workflow await paths remain distinct.
  - Define `ReplySource` as a **`Context.Service` Tag** with shape
    `{ peek: (execId: ExecId) => Effect<PeekResult, ..., R> }` (or a callable
    `(ExecId) => Effect<PeekResult>` per CONTEXT.md:31 — pick the Service shape so the
    R-channel is explicit and swappable). Provide the default adapter
    `ReplySourceLayer.fromMessageStorage` wrapping the existing `peekImpl` body
    (`actor.ts:984-1021`): `requestIdForPrimaryKey` → `repliesForUnfiltered` →
    `mapExitToPeekResult`. **The adapter's R-channel MUST stay
    `MessageStorage | ActorAddressResolver`** and keep the `OperationDefs` param
    threaded so `decodeValue`'s schema-decode requirements (`def.success`/`def.error`)
    are preserved (verified hazard — both reviews flag it). Use the
    `makeActorStateLayer`/`makeActorControlLayer` provide-pattern (`actor.ts:1774-1859`)
    as the reference for threading deps through the seam.
  - Repoint `peekImpl`'s callers: `makeOperationHandle.peek` @1469, `.waitFor` @1481,
    `sendAndAwait` @1435 resolve the peek fn from the `ReplySource` seam instead of
    closing over `peekImpl` directly. `makeWaitFor` @1104 is already `peekFn`-
    parameterized — feed it the ReplySource-resolved fn. `watchImpl` @1072 likewise.
  - **Behavior-preserving.** The live entity path runs through the same default
    adapter. This is the path the GYC Stripe webhook drives (webhook writes a reply
    into `cluster_replies`; the default `fromMessageStorage` ReplySource sees it
    terminal) — so no bespoke webhook adapter is needed downstream.
- **Gate:** `bun run gate`. NEW `test/receipt.test.ts` cases: every `PeekResult` arm
  (Success / Failure / Defect / Interrupt / Pending) from a **synthetic `ExitEncoded`**
  AND a real `Exit.Exit` (entity vs workflow Cause-walk parity) — Exit-classification
  is now testable without a live cluster. Add a **typecheck/test asserting the default
  adapter's R-channel** is still `MessageStorage | ActorAddressResolver` (so actor
  layers still satisfy). Existing `peek.test.ts` / `send-and-await.test.ts` /
  `workflow*.test.ts` unchanged-green (proves no behavior drift in the live path). v3
  untouched-green.
- **Deps:** E1.

### E3 — feat(state): Rivet-shaped `State<A>` value type (standalone)

- **Files:** NEW `src/state.ts` (~260), `src/index.ts` (`export * as State`), NEW
  `test/state.test.ts`.
- **Scope:** Port Bite `82d0b4c` `packages/actor-runtime/src/state.ts` **near-verbatim**
  (the full file body is reproduced in this plan's research; it is load-bearing). The
  ONLY changes from Bite's text:
  1. `TypeId` brand `@biteinc/actor-runtime/state/State` → `effect-encore/state/State`
     (in-process only — safe, NOT a persisted wire string).
  2. **ALL design-doc references repointed** — Bite's `state.ts` cites
     `docs/0d3-state-reshape-design.md §RESOLUTION` in **≥3 places** (the header
     comment ~line 35, the `commit()` self-feed comment, and the Phase-3 double-emit
     note), not just the header. Repoint **every** occurrence to `docs/adr/0001`. (This
     corrects the earlier "ONLY ... the header comment" undercount: it is the TypeId
     plus a sweep of _all_ design-doc path references, nothing else.)
  - Surface: `State<A, E, R>` interface (`read`/`write`/`pubsub`/`semaphore` +
    `Variance` + `Pipeable` + `Inspectable`), `isState`, `Proto`, and `make` (via
    `Effect.fnUntraced`), `get`, `set`, `update`, `updateAndGet`, `modify`, `changes`,
    `publish`, `publishUnsafe`, internal `publishDirect`/`commit` (all `dual`-curried
    where Bite is). Invariants: per-State `Semaphore.makeUnsafe(1)` linearizes the
    read/apply/write/publish quad; `PubSub.unbounded({ replay: 1 })` mirrors
    `SubscriptionRef` (late subscriber sees latest); `make` publishes the initial value
    on construction; `commit` self-feeds the change stream (the one documented Rivet
    divergence — kept inline with Bite's comment, plus the Phase-3 double-emit
    reconciliation note).
  - **Standalone — no `actor.ts` edits.** Not yet consumed by `registerState` (E4
    wires it). Pure additive module.
  - Verify the exact beta.75 signatures at impl time: `PubSub.unbounded` options
    shape, `Effect.fnUntraced` return type (`Effect.fn.Return`), `Semaphore.withPermit`
    arity. (All confirmed present above; confirm signatures against
    `node_modules/effect@beta.75`, not just the smol cache.)
- **Gate:** `bun run gate`. NEW `test/state.test.ts` (effect-bun-test idiom:
  `import { describe, expect, it } from "effect-bun-test"`, `it.scopedLive` /
  `it.effect`): get/set/update/updateAndGet/modify over a `SubscriptionRef`-closure
  cell; **100 concurrent updates → 100** (atomicity via the semaphore); replay-1 (late
  subscriber sees latest); `modify` returns-old/sets-new; ordered `changes` stream;
  `publish` serialized vs in-flight `set`. All 24 existing test files untouched-green.
  v3 untouched-green.
- **Deps:** E1 (so `state.test.ts`/`exec-id-codec.test.ts` don't collide; E3 has no
  hard code dep on E2, but the linear chain keeps each commit's gate window clean).

### E4 — feat(state): `registerState` consumes `State<A>`; demote `ActorStateHandle` to internal

- **Files:** `src/actor-state.ts`, `src/index.ts`, `src/actor.ts` (the
  `import type { ActorStateHandle }` @79, the `Actor.registerState` re-export
  annotation @2575, AND the `Actor` const object @2572 to add `State`),
  `test/actor-state.test.ts`, `test/types.test.ts` (export-surface), `README.md` (if
  it documents the handle shape).
- **Scope:**
  - Change `registerState` (`actor-state.ts:87-96`) to accept `State<A, E, R>` and
    DERIVE the registry-internal read-only handle: `get: State.get(state)`,
    `watch: State.changes(state)`. The registry's `AnyActorStateHandle` (`{get, watch}`)
    stays as an **internal** detail; the public state vocabulary is `State<A>`.
  - DEMOTE the public `ActorStateHandle` interface (`actor-state.ts:13-16`) to
    registry-internal: drop its `export`. **SPLIT `index.ts:41`** (verified: today it
    is `export type { ActorStateHandle, ActorStateRegistryShape } from
"./actor-state.js"` on ONE line) — remove only `ActorStateHandle`, **KEEP**
    `export type { ActorStateRegistryShape } from "./actor-state.js"`. (`package.json`
    has no `./*` wildcard, so the barrel removal is the complete de-export.)
    `actor.ts:79` still `import type { ActorStateHandle }` internally — that import
    stays (the type survives package-internally; only its barrel re-export is dropped),
    but verify it still resolves the now-unexported interface within the package.
  - `stateOf` / `watchStateOf` / `waitForStateOf` / `listStateEntityIds` and the
    `ActorStateRegistry` seam **survive unchanged** — they consume the derived handle.
    `makeActorStateLayer` (`actor.ts:1803`) is untouched.
  - **Access pattern — DECIDED: `Actor.State.*`** (matches the existing
    `Actor.registerState(...)` test idiom; the tests reach state through the `Actor`
    namespace). This requires TWO edits, not one: 1. `export * as State from "./state.js"` in `index.ts` (top-level `State` namespace
    for direct importers). 2. **ADD `State` to the `Actor` const object at `actor.ts:2572`** (verified: it
    currently has `CurrentAddress, registerState, entityIdCodec, fromEntity,
fromWorkflow, fromRpcs, ...` but **no `State`**). Import the `state.js` module
    namespace at the top of `actor.ts` (`import * as State from "./state.js"`) and
    add `State,` to the const so `Actor.State.make(...)` / `Actor.State.updateAndGet(...)`
    resolve. Without this edit, E4's own test migration (which writes
    `Actor.State.make(...)`, see Gate below) would NOT compile.
  - **Update the `Actor.registerState` annotation @2575** (verified: the cast is
    `registerState as <State, Error, Requirements>(handle: ActorStateHandle<...>) =>
...`). Change its parameter type from `ActorStateHandle<...>` to
    `State.State<...>` to match the new `registerState(State)` signature.
  - **BREAKING:** `registerState({get,watch})` → `registerState(State)` and
    `ActorStateHandle` leaves the public barrel. This is the agreed reshape (decision
    #2 names `State<A>` as the consume-point). **Rejected alternative:** a
    backward-compat overload `registerState(State<A> | {get,watch})` guarded by
    `State.isState` — rejected because it violates migrate-callers-then-delete
    (CLAUDE.md) and encore is pre-1.0 (`0.12.x`), where a minor carrying a documented
    break is correct. The E7 changeset documents the break AND this rejected
    alternative with its reasoning.
- **Gate:** `bun run gate`. `test/actor-state.test.ts` migrated: the two
  `Actor.registerState({get: SubscriptionRef.get(...), watch: Stream...})` sites
  (@29-37, @62-65) build a `State<A>` first via
  `Actor.State.make(() => SubscriptionRef.get(ref), (v) => SubscriptionRef.set(ref, v))`
  then `Actor.registerState(state)`; the Increment handler @37/@38 mutates **through
  the State** (`Actor.State.updateAndGet(state, ...)`) so the change stream observes
  writes. `test/types.test.ts` export-surface assertion updated to confirm
  `ActorStateHandle` is no longer in the public barrel. README migrated if applicable.
  All other tests green. v3 untouched-green.
- **Deps:** E3.

> **E3+E4 coupling note:** E3 is purely additive (gate-green alone). E4 is the
> consume-point flip and is independently gate-green because it migrates its own tests
> in the same commit. They are NOT a red-gate pair — unlike the naive
> impl-then-test split. Keep them as two commits (additive module, then consume-point)
> for reviewability.

### E5 — refactor(client): deep `Client` Tag owning send/resolve/peek/flush/redeliver

- **Files:** NEW `src/client.ts` (~200), `src/actor.ts` (dispatch + ops call sites),
  `src/index.ts` (export `Client`; de-export decision below), NEW
  `test/client-layer.test.ts`, edits to tests importing the raw factories.
- **Scope:** Build a real `Client` **`Context.Service` Tag** (per decision #1 /
  CONTEXT.md:21-25), NOT Bite's thin namespace. The Tag owns:
  - `send(request)` — pulling the wire-envelope builder
    `buildOutgoingRequestForSend` (`actor.ts:841-904`) **INSIDE the seam**. The
    persisted-gate annotation-derivation (`actor.ts:882-893`) MUST be moved
    **byte-identical** — it mirrors upstream `Sharding.makeClient` and a dropped
    context silently mis-routes persisted requests.
  - `peek` — delegates to the **E2 `ReplySource`** (the default adapter is the
    storage-backed peek). The Client does not re-implement Exit-walking; it composes
    the ReplySource seam.
  - `flush` / `redeliver` — `flushImpl` (`actor.ts:939`) / `redeliverImpl`
    (`actor.ts:950`) moved inside.
  - `resolve` — address resolution via the **internal** `ActorAddressResolver`
    strategy (`fromConfig`/`fromSharding`, carrying the shard-parity invariant
    `actor-address-resolver.ts:24-27`). Resolution stays an internal strategy the
    Client holds, **NOT a public Tag** (decision #1).
  - (`rerunImpl` @963 may stay on the `OperationHandle.rerun` surface or move inside
    the Client — keep it where the call site is simplest; not load-bearing for the
    seam. Document the choice.)
  - **Public `.send` R-channel change (USER-FACING TYPE BREAK — verified hazard):**
    Repointing `sendFn` (path (a)) from the triad to a single `Client` Tag changes
    the inferred `R` of every producer `.send`. Today `test/types.test.ts:91` pins
    `type SendR = ActorMailbox | ActorAddressResolver | Snowflake.Generator` and
    line 93 asserts `Order.Place.send({ item: "widget" })` has **exactly** that `R`.
    Per decision #1 (the triad is superseded by ONE Client Tag), `Place.send`'s `R`
    **collapses to `Client`**. This plan adopts that collapse and accounts for it: 1. **Rewrite `test/types.test.ts:91`** `SendR` from the triad union to `Client`
    (the line-93 `_check` assertion then pins the new public contract). 2. **Re-point the public `SenderContext` type (`actor.ts:155`, doc-comment
    @146-150).** It is a public union users put in their `R` for producer-op
    composition; it currently lists `MessageStorage | ActorAddressResolver |
Sharding`. Re-point it to `Client` (the producer-op union is now the single
    Client Tag) and update its doc-comment @146-150 to say so. Re-export stays at
    `index.ts:39` (`SenderContext`, part of the `export type { ... } from
"./actor.js"` block), so the symbol survives — only its definition changes. (Do NOT silently keep the three-Tag union: that would leave
    `SenderContext` describing a transport that no longer exists post-seam.) 3. This is a **type-level public break** — recorded in the Risks table (new risk)
    and the E7 changeset (new BREAKING bullet).
  - **Adapters — all four (decision #1):**
    `Client.layer.fromConfig` (storage-only producer/ops, over
    `ActorSenderLayer.layer` = mailbox.fromConfig + resolver.fromConfig + Snowflake),
    `Client.layer.fromSharding` (consumer, over `sharding.sendOutgoing`; MUST bundle
    `Snowflake.layerGenerator` — the Bite BLOCKER, since `Sharding.layer` hides its own
    generator Tag and `OperationHandle.send` needs it),
    `Client.layer.memory` (over `ActorSenderLayer.layerMemory`, self-contained),
    `Client.layer.test` (over `makeTestMailboxImpl` @916 — the 4th adapter Bite
    dropped; routes a prebuilt `OutgoingRequest` back through the entity's per-entity
    test `rpcClient` with `{ discard: true }`).
  - **The two send paths are architecturally DISTINCT — repoint ONLY the triad
    one (verified `actor.ts`):** - **(a) `makeOperationHandle.sendFn` (`actor.ts:1393-1410`) IS the Client-seam
    dispatch.** It hand-assembles the triad verbatim: `const mailbox = yield*
ActorMailbox; const resolver = yield* ActorAddressResolver; const snowflakeGen
= yield* Snowflake.Generator;` then resolves the address and calls
    `buildOutgoingRequestForSend(...)` then `mailbox.send(request)`. **Repoint this
    to `const client = yield* Client; ... yield* client.send(request)`** and pull
    `buildOutgoingRequestForSend` (`actor.ts:841-904`, byte-identical incl. the
    @882-893 persisted-gate) INSIDE the `Client` Service. This — and only this — is
    what "supersedes the hand-assembled triad" (CONTEXT.md:24) means concretely. - **(b) `buildActorRef.send` (`actor.ts:1943-1958`) does NOT assemble the triad
    and is NOT repointed through the Client's `send`.** Verified: it dispatches via
    the closed-over per-entity `rpcClient` — `const fn = client[tag]; ... fn(arg,
{ discard: true })` (`actor.ts:1945/1953`) — and touches neither mailbox,
    resolver, nor `buildOutgoingRequestForSend`. Its only Client-relevant work is
    MINTING the execId locally @1956 (`\`${_entityId}\x00${tag}\x00${primaryKey}\``),
which **E1's `ExecIdCodec`already centralizes** (E1 rewires @1956 to`ExecIdCodec.encode`). **Leave `buildActorRef.send`'s dispatch on the per-entity
`rpcClient`; do NOT route it through `Client.send`.** (The `client`local @1945
is the entity's RPC client, a different thing from the`Client` transport Tag —
    do not conflate them.)
- **Barrel de-export decision (resolving A-vs-B tension AND the shard-parity-test
  contradiction):** De-export **only `ActorSenderLayer`** (`index.ts:82`) — it is the
  high-level transport bundle the four `Client.layer.*` adapters fully supersede, and
  no test imports it in isolation. **KEEP `ActorMailboxLayer` (`index.ts:80`) and
  `ActorAddressResolverLayer` (`index.ts:78`) exported**. Reasoning (verified
  contradiction): exports are `.`-only with **no `./*` wildcard**, so de-exporting a
  factory makes it UNREACHABLE from `test/` via any import path. Three existing tests
  exercise these factories **in isolation** in a way `Client.layer.*` cannot replace:
  - `address-resolver.test.ts:29/33` runs `ActorAddressResolverLayer.fromConfig` vs
    `.fromSharding` against the SAME config to assert **resolver-granularity** shard
    parity (the `actor-address-resolver.ts:24-27` invariant). `Client.layer.fromConfig`
    bundles mailbox+resolver+snowflake, so it **cannot isolate the resolver** to pin
    that invariant.
  - `mailbox.test.ts:106` uses `ActorMailboxLayer.fromConfig` directly over a memory
    storage stack.
  - `rerun.test.ts:50` uses `ActorAddressResolverLayer.fromSharding` directly.

  So `Client.layer.*` becomes the **recommended public transport**, but the
  resolver/mailbox layer factories remain exported as the **internal strategy** the
  Client holds (decision #1 names address resolution "an internal strategy ... not a
  public Tag" — the _Tag_ is internal-by-non-export; the _layer factory_ stays
  exported because it carries the load-bearing shard-parity coverage). Keep the
  **Tags** `ActorMailbox` / `ActorAddressResolver` and `MailboxError` exported too
  (user-facing R-channels + errors). Net barrel change at E5: **only
  `ActorSenderLayer` leaves** `index.ts`. (Rejected the cleaner-surface "de-export all
  three" because it makes the shard-parity isolation test unreachable with no
  equivalent coverage at the `Client.layer` granularity — correctness over surface
  tidiness.)

- **Gate:** `bun run gate`. NEW `test/client-layer.test.ts`: each adapter drives the
  transport surface it actually OWNS end-to-end. `fromConfig` / `fromSharding` /
  `memory` drive `send + peek + flush + redeliver`, and `fromSharding` proves the full
  `send → peek → Success/Failure` reply round-trip over a real cluster runtime. The
  `test` adapter is **send-routing + control/peek-over-its-own-storage ONLY**: its
  injected per-entity test client is `Entity.makeTestClient` (a raw
  `RpcServer.makeNoSerialization` that bypasses the `entityManager`, the only component
  that persists handler replies to `MessageStorage`), so the `{ discard: true }` reply
  reaches no storage and `send → peek` is `Pending` BY CONSTRUCTION — a reply
  round-trip is structurally impossible on this transport (and storage-sharing is moot:
  nothing writes a reply). The `test` block asserts `send` routes through the injected
  mailbox, `send → peek` is `Pending`, and `flush`/`redeliver`/`peek` run on its
  storage; the reply round-trip is covered by `fromSharding` and the `fromWorkflow`
  test path instead. Plus a **Snowflake-resolves-under-fromSharding** assertion
  (`.send` doesn't hit "Service not found: Snowflake.Generator"); and a **persisted-
  routing assertion** — dispatch a persisted op and assert it actually persisted after
  the wire-builder moved inside the seam (NOT just a smoke test — this guards the
  @882-893 annotation-derivation). **`test/types.test.ts:91` rewritten**: `SendR`
  → `Client` (and the line-93 `Place.send` assertion re-pins to the collapsed `R`);
  the export-surface assertion confirms `ActorSenderLayer` is gone from the barrel
  while `ActorMailboxLayer`/`ActorAddressResolverLayer` remain. Existing
  `client.test.ts` / `mailbox.test.ts` / `flush-redeliver.test.ts` /
  `address-resolver.test.ts` (shard-parity) / `rerun.test.ts` /
  `integration/cluster.test.ts` green. **Do NOT repoint `address-resolver.test.ts` /
  `mailbox.test.ts:106` / `rerun.test.ts:50` away from the layer factories** — they
  stay exported precisely so these isolation tests keep working. Only repoint a direct
  `ActorSenderLayer` import (if any) to `Actor.Client.layer.{memory,fromConfig,
fromSharding,test}`. v3 untouched-green.
- **Deps:** E2 (Client.peek composes the ReplySource), E4 (clean barrel before the
  Client de-export). Practically E5 is the heaviest actor.ts churn and lands after the
  await-engine and state seams are stable.

### E6 — refactor(actor): `fromWorkflow` split + fold the two adapter layers inward (GATED)

- **Gate condition (decision #4):** DEFER unless the port has already churned
  `actor.ts` heavily. **Re-measure `wc -l src/actor.ts` after E5.** E2 (await-engine
  lift, ~120 lines out) + E5 (wire-builder + ops-path out, ~150+ lines out) DO churn
  it heavily, and the workflow lineage is ~385 lines (2202→end). If post-E5 `actor.ts`
  is still > ~2000 lines AND the workflow lineage is cleanly separable, **execute**;
  otherwise **stack as a follow-up** and skip to E7. Decide at implementation time
  with the measured number, NOT pre-committed.
- **Files (if executed):** NEW `src/actor-workflow.ts`, `src/actor.ts`, `src/index.ts`,
  `test/types.test.ts` (export-surface).
- **Scope:** Pure mechanical relocation, no signature changes:
  - Extract `fromWorkflow` (`actor.ts:2202`→end, ~385 lines incl. `peekById`,
    `peekFn`, `watchFn`, `waitForFn`, signals, rerun) into `src/actor-workflow.ts`;
    re-export through `index.ts` / the `Actor` namespace. NOTE: the workflow path keeps
    its `WorkflowEngine.poll`-based `peekById` (it is NOT the entity ReplySource path)
    — preserve that boundary.
  - Fold `makeActorControlLayer` (`actor.ts:1774-1801`) and `makeActorStateLayer`
    (`actor.ts:1803-1859`) inward to their consume points (the `actor.State` /
    `actor.Control` builders) — the "two shallow adapter layers" decision #4 names.
  - No test logic changes — relocation only.
- **Gate:** `bun run gate`. `workflow.test.ts` / `workflow-step.test.ts` /
  `workflow-rerun.test.ts` green against the extracted module; `types.test.ts`
  export-surface updated for the new module boundary. v3 untouched-green.
- **Deps:** E5.

### E7 — chore(release): finalize ADR, changeset (minor), publish

- **Files:** `docs/adr/0001-actor-runtime-seams.md` (tick Status → accepted),
  `CONTEXT.md` (mark the three port-target markers "landed"), NEW
  `.changeset/<name>.md`.
- **Scope:** Write a **minor-bump** changeset (existing flow — `.changeset/config.json`
  present; `.changeset/send-and-await.md` is the template). Summarize the additive
  surface: `State<A>` value type (get/set/update/modify/changes + serialized mutation),
  `registerState` now consumes `State<A>` **[BREAKING for `{get,watch}` callers — note
  it + the rejected `State.isState` overload and why]**, `ActorStateHandle` left the
  public barrel **[BREAKING — note it]**, `Client.layer.{fromConfig,fromSharding,
memory,test}` deep transport Tag (only `ActorSenderLayer` de-exported
  **[BREAKING — note it]**; `ActorMailboxLayer`/`ActorAddressResolverLayer` stay
  exported as the internal resolution strategy), the public **`.send` R-channel
  collapses from `ActorMailbox|ActorAddressResolver|Snowflake.Generator` to `Client`,
  and `SenderContext` is re-pointed to `Client` [BREAKING — type-level; note it]**,
  `ExecIdCodec` + `ReplySource` seam exports. At 0.x a minor carrying documented breaks
  is the correct signal.
  - Tick the ADR to accepted and CONTEXT.md markers to landed.
- **Gate:** `bun run gate` fully green (typecheck v4+v3, lint, fmt, test:all = 26 v4
  files + v3 leg, build v4+v3). `changeset status` shows the pending minor. **Publish
  runs in CI post-merge** (`release: bun run build && changeset publish`; the
  changeset-release/main flow — git log `bed35c1`/`7159d54`/`5006182` — bumps the
  version and publishes to npm). GYC PR2 then deps the published version.
- **Deps:** E6 (or E5 if E6 deferred).

---

## Divergences from both source plans

| Topic                                   | Plan A                                    | Plan B                                    | This plan                                                                                                                                 | Why                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client seam                             | thin Bite namespace verbatim (3 adapters) | deep Tag (4 adapters)                     | **B's deep Tag, 4 adapters incl. `test`**                                                                                                 | Decision #1 mandates it; A contradicts a settled decision                                                                                                                                                                                             |
| Dispatch call sites                     | left hand-assembling the triad            | repointed through Client                  | **only `sendFn`@1393 repointed through Client; `buildActorRef.send`@1943 stays on the per-entity rpcClient (mints execId only)**          | `sendFn` IS the triad assembly; `buildActorRef.send` dispatches via the closed-over rpcClient and is not triad-assembly (verified @1945/1956)                                                                                                         |
| ReplySource shape                       | bare `Tag = (ExecId)=>Effect`             | `Context.Service` + named default adapter | **`Context.Service` + `fromMessageStorage`, R-channel pinned**                                                                            | B's framing + A's R-channel hazard receipt                                                                                                                                                                                                            |
| Commit order                            | port-faithful (State→Client→Receipt)      | codec→ReplySource→State→Client            | **codec → ReplySource → State → Client** (State front-loaded for GYC; codec/ReplySource shrink actor.ts before Client moves the ops-path) | resolves A's open question: ReplySource is NOT a GYC blocker                                                                                                                                                                                          |
| Test count                              | 24 (correct)                              | 47 (wrong)                                | **24 → 26**                                                                                                                               | verified `ls`/`find`                                                                                                                                                                                                                                  |
| `fromWorkflow` split (#4)               | omitted                                   | included unconditionally                  | **gated on a re-measured post-E5 line count**                                                                                             | decision #4 says DEFER-by-default                                                                                                                                                                                                                     |
| ADR vs DIVERGENCE.md                    | ADR (correct)                             | ADR (correct)                             | **ADR, no DIVERGENCE.md**                                                                                                                 | encore is the source                                                                                                                                                                                                                                  |
| Barrel de-export of factories           | de-export (cleaner)                       | keep exported (compat)                    | **de-export only `ActorSenderLayer`; KEEP `ActorMailboxLayer`/`ActorAddressResolverLayer`**                                               | no `./*` wildcard means de-exporting these makes the shard-parity isolation tests (`address-resolver.test.ts:29/33`, `mailbox.test.ts:106`, `rerun.test.ts:50`) unreachable — `Client.layer.*` can't isolate the resolver to pin the @24-27 invariant |
| GYC effect skew                         | missed                                    | flagged                                   | **flagged as a launch-blocking GYC-side item**                                                                                            | verified beta.60 < beta.66 floor                                                                                                                                                                                                                      |
| registerState compat overload           | evaluated + rejected with reasoning       | bare "call it out"                        | **rejected with A's reasoning, documented in changeset**                                                                                  | A's analysis is more complete                                                                                                                                                                                                                         |
| Wire-format safety                      | golden-string test (A's strength)         | oblique                                   | **golden-string + round-trip test**                                                                                                       | persisted contract                                                                                                                                                                                                                                    |
| Persisted-routing guard for Client move | n/a (thin)                                | only `integration/cluster.test.ts`        | **explicit persisted-routing assertion**                                                                                                  | one smoke test is insufficient for the @882-893 hazard                                                                                                                                                                                                |

## Risks

1. **E5 wire-builder move (highest risk).** Moving `buildOutgoingRequestForSend`
   (`actor.ts:841-904`) inside the Client Tag risks dropping the persisted-gate
   context (@882-893) and silently routing persisted requests as non-persisted. Keep
   the body byte-identical; add a **persisted-routing assertion** in
   `client-layer.test.ts`, not just `integration/cluster.test.ts` smoke.
2. **E2 R-channel regression.** The `ReplySourceLayer.fromMessageStorage` default adapter
   must keep `MessageStorage | ActorAddressResolver` in its requirements and the
   `OperationDefs`/schema-decode (`def.success`/`def.error`) threaded, or `peek` loses
   typed decoding and the actor layers fail to satisfy. Use the
   `makeActorStateLayer`/`makeActorControlLayer` provide-pattern as the reference; add
   a typecheck/test that the actor layers still satisfy after the lift.
3. **E1 single-segment ambiguity.** `parseExecId` @828 collapses a no-separator id to
   `entityId==tag==primaryKey`. Workflow execIds are single-segment and must keep
   round-tripping. The codec must reproduce the fallback exactly; pin with a test. (The
   workflow path uses `WorkflowEngine.poll`, not `decode`, so it's likely unaffected —
   verified, but pinned anyway.)
4. **E1 wire-format byte-identity.** The `\x00`-separated format is persisted into
   `cluster_messages` dedup identity (CONTEXT.md:13-15). Centralizing construction must
   not normalize/escape segments. Golden-string test required.
5. **v3 dual-build.** `gate` runs `typecheck:v3` + `test:v3` + a v3 `tsdown` build. The
   reshape is v4-only (v3/src isolated, no `../src` imports). Verify `bun run test:v3`
   - `typecheck:v3` stay green after E5 (the de-export commit) — v3 has a separate
     barrel and should be unaffected, but confirm.
6. **E6 over-engineering.** If E2/E5 land smaller than projected, the `fromWorkflow`
   split is a large mechanical move for its own sake. Gate it on the re-measured
   post-E5 line count; default to deferring.
7. **effect@beta.75 signature drift.** `PubSub.unbounded({replay:1})`,
   `Effect.fnUntraced` (`Effect.fn.Return`), `Semaphore.withPermit` arity — all
   confirmed present, but verify exact signatures against `node_modules/effect@beta.75`
   at impl time (E3), not just the smol HEAD cache.
8. **registerState public break.** Hard-break per migrate-callers-then-delete; encore
   is pre-1.0 so a minor is defensible. The changeset must document it. (Mitigation
   already chosen: no `State.isState` compat overload.)
9. **Public `.send` R-channel collapse (E5, type-level break).** Repointing `sendFn`
   (`actor.ts:1393`) to a single `Client` Tag changes every producer `.send`'s inferred
   `R` from the triad `ActorMailbox|ActorAddressResolver|Snowflake.Generator` to
   `Client`. `test/types.test.ts:91` pins the old triad (line 93 asserts
   `Order.Place.send(...)`'s exact `R`) and **must be rewritten to `Client`**. The
   public `SenderContext` type (`actor.ts:155`, doc-comment @146-150) must be
   re-pointed to `Client` and re-documented. This is a user-facing type-level break;
   the E7 changeset documents it. Mitigation: it is the _intent_ of decision #1 (one
   Client Tag supersedes the triad) — the break is desired, just made explicit.
   **Note** `buildActorRef.send` (`actor.ts:1943`) is NOT repointed (it dispatches via
   the per-entity rpcClient, mints execId only), so its `R` is unaffected.

## Open questions (must be answered before/during implementation)

1. **GYC effect bump (launch-blocking for PR2, NOT for the encore PR).** Encore peer
   is `effect>=4.0.0-beta.66` / dev `beta.75`; GYC `feat/registrar` is
   `effect@4.0.0-beta.60` (verified GYC `package.json:29` dep / `:60` resolution). Adopting the published encore
   forces a GYC-wide bump (beta.60 → ≥66) plus `@effect/sql` / `@effect/cluster`
   catalog alignment, which can ripple through the registrar's Schema/Effect call
   sites. **Does the encore PR relax its peer floor, or does GYC take a coordinated
   bump on top of `feat/registrar`?** This gates the _second_ PR; it does NOT gate
   publishing encore. Surface before GYC PR2 starts.
2. **ReplySource Service vs callable shape.** CONTEXT.md:31 phrases it as
   `(ExecId) => Effect<PeekResult>`; this plan recommends a `Context.Service` Tag with
   a `peek` method so the R-channel is explicit and swappable. Confirm the callable vs
   method shape at E2 design time (does not change the behavior, only the seam
   ergonomics).
3. **Where does `rerunImpl` live post-E5** — on the `OperationHandle.rerun` surface or
   inside the Client Tag? Not load-bearing; pick the simpler call site and document.
4. **E6 go/no-go** — decided by `wc -l src/actor.ts` after E5 (threshold ~2000 lines).
   Not pre-committed.
5. **(GYC PR2, not this PR) Order state machine reconciliation.** Encore Order is
   `pending|paid|cancelled|refunded|expired`; the existing bucket
   `RegistrationOrder.status` is `pending|paid|failed|expired` (verified
   `app/lib/forms/order.ts:56` — no `cancelled`/`refunded`). The Order actor
   WRAPS/orchestrates (does not replace) the freeze discipline + `markOrderPaid`.
   Confirm `cancelled`/`refunded` have no bucket equivalent yet and where they map
   relative to `failed`. Resolve in GYC PR2.
6. **(GYC PR2, not this PR) Webhook→ExecId resolution + DB standup.** GYC has no DB
   today (bucket Storage only). PR2 must stand up `@effect/sql` + a concrete DB and
   encore's `fromSqlClient` (`storage.ts`), and confirm the webhook
   (`api.stripe-webhook.ts`) resolves the `process` op's ExecId via the default
   MessageStorage ReplySource (reply lands in `cluster_replies`, `peek`/`waitFor` see
   it terminal) rather than a bespoke bucket adapter. Resolve in GYC PR2.

## Downstream (GYC Order PR2 — out of scope for this PR, recorded for continuity)

After this PR merges and publishes, GYC PR2 (stacked on `feat/registrar`) builds a
durable Order encore entity backed by SQL `MessageStorage` stood up in GYC. Ops:
`process` (create Checkout via the registrar's `Payment.createCheckoutSession`, then
suspend awaiting the reply token / ExecId) → `cancel` → `refund` → `expire`. State:
`State<OrderStatus>` with `pending|paid|cancelled|refunded|expired`. The Stripe webhook
resolves the `process` op's ExecId via the default SQL MessageStorage reply mechanism.
The Order WRAPS the registrar's existing Payment / RegistrationOrder / `markOrderPaid`
freeze discipline — it does not replace it. GYC PR2 is gated by open questions #1, #5,
#6 above.
