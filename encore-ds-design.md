# encore-ds — design sketch

Keep encore's DSL. Swap the backbone from `@effect/cluster` to **DurableTable +
Durable Streams**. No cluster dependency.

The punchline after reading all three codebases: **the workflow half is almost
free, and the entity half is one good idea repeated.** That idea is

> a stream-per-actor inbox + `insertOrGet` for both "claim the drain" and
> "idempotent enqueue."

Everything else falls out of that.

---

## The big picture

```
            TODAY (effect-cluster)                    encore-ds
   ┌───────────────────────────────┐      ┌───────────────────────────────┐
   │ Sharding  (routing, activation)│      │  naming: actorId → streamUrl   │
   │ MessageStorage (cluster_msgs)  │      │  DurableTable inbox per actor  │
   │ cluster_replies                │      │  DurableTable replies (by ExecId)│
   │ shard mgr / rebalance / clock  │      │  ── deleted ──                 │
   │ WorkflowEngine                 │      │  DurableStreamsWorkflowEngine  │
   └───────────────────────────────┘      └───────────────────────────────┘
        4 cluster Tags to replace              the public surface ports ~as-is
```

Encore's public API (`fromEntity`, `OperationHandle.execute/send/peek/...`,
`toLayer`) is abstracted over four cluster Tags: `MessageStorage`, `Sharding`,
`Entity.toLayer`, `ActorAddressResolver`. We reimplement those four; `actor.ts`,
`receipt.ts`, `step.ts` mostly come along for the ride.

What's deleted outright (invariant 2 — activation model makes them unnecessary):
shard manager, rebalancing, entity migration, distributed clock.

---

## 1. Addressing = naming, not a directory

Cluster hashes `entityId → shardId → runner`. We don't. The id **is** the
location:

```ts
// addressing.ts
const inboxUrl = (actorId: string) => `${base}/encore/${actorType}/${actorId}/inbox`;
const stateUrl = (actorId: string) => `${base}/encore/${actorType}/${actorId}/state`;
const replyUrl = (actorId: string) => `${base}/encore/${actorType}/${actorId}/replies`;
```

A sender computes the inbox URL from the id and appends. It never learns which
process drains it — that's cluster's location-transparency, achieved by
**convention instead of a shard table**.

ExecId stays byte-for-byte what encore uses today (`entityId\0tag\0primaryKey`,
verified `actor.ts:1383-1386`), so `receipt.ts` and every `peek/watch/waitFor`
signature port unchanged. The `id` fn keeps its two shapes (verified
`actor.ts:114-128`):

```ts
resolveId(p); // string            -> { entityId: s,            primaryKey: s }
// { entityId, pk? } -> { entityId, primaryKey: pk ?? entityId }
```

---

## 2. The mailbox is a DurableTable

Encore's `ActorMailbox.fromConfig` is literally `MessageStorage.saveRequest` +
"treat `Duplicate` as enqueued" (verified `actor-mailbox.ts:96-124`).
`DurableTable.insertOrGet` is literally first-writer-wins + "`Found` carries the
existing row" (verified `DurableTable.ts:805-840`). They're the same shape.

```ts
// mailbox.ts
const Inbox = DurableTable("encore-inbox", {
  msgId: Schema.String, // primary key = ExecId (so re-send is idempotent)
  tag: Schema.String,
  payload: Schema.Unknown, // encoded
  arrivalOff: Schema.Number, // persisted from insertOrGet's Inserted.offset
});

const enqueue = (actorId, msg) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.of(inboxUrl(actorId));
    const r = yield* inbox.insertOrGet(msg);
    // Inserted OR Found both mean "it's in the queue" — encore's Duplicate==enqueued
    return r._tag === "Inserted" ? r.offset : /* look up existing */ msg.arrivalOff;
  });
```

**Feed = push, never poll.** `rows()` is replay-then-tail (verified
`DurableTable.ts:742-772`). We're strictly lower latency than cluster's
`entityMessagePollInterval`.

**One gotcha, already solved.** `rows()` is a keyed-LWW view — it does **not**
hand back messages in arrival order (verified, no consumption offset on `rows()`).
So we stamp the arrival offset from `insertOrGet` onto the row and sort the drain
by it (invariant 5):

```ts
const drainInOrder = (actorId) =>
  Inbox.of(inboxUrl(actorId)).pipe(
    Effect.flatMap(inbox => inbox.rows()),
    Stream.// buffer + order by arrivalOff, advance cursor past last processed
  )
```

---

## 3. Single-writer = `insertOrGet` on an owner key

`insertOrGet` is **not a lock** and **never expires** (the doc comment is
emphatic, `DurableTable.ts:119-131`). We don't want a lock — we want the
activity-claim pattern the workflow engine already uses (verified
`engine-runtime.ts:63-98`):

```ts
// activation.ts
const claimDrain = (actorId, epoch) =>
  Owners.of(...).pipe(
    Effect.flatMap(t => t.insertOrGet({ key: `${actorId}/${epoch}`, worker: myId })),
    Effect.map(r => r._tag === "Inserted"
      ? Owned          //  I drain this actor
      : r.row.worker === myId ? Owned : NotOwner(r.row.worker)))
```

```
   process A ──insertOrGet({actorId}/0)──▶  Inserted   → A drains
   process B ──insertOrGet({actorId}/0)──▶  Found(A)   → B backs off
```

**Takeover is by re-keying, not revocation** (invariant 6). A is presumed dead?
Mint `${actorId}/1`. Old key is immortal and harmless; the new key starts a fresh
race, fenced underneath by the stream's producer epoch (verified
`Producer.ts:72-130`, `restart(epoch)`). No leases, no expiry, no liveness clock.

The drain loop:

```
 wake → claimDrain → replay inbox to tail → run handler per msg
                                   │              │
                                   │              └─ write reply row (ExecId)
                                   │              └─ advance cursor
                                   └─ release (just stop; nothing resident)
```

---

## 4. send (producer-only) and execute

`send` must work **with no handler in this process** — that's the entire reason
`ActorMailbox.fromConfig` exists (verified). Under stream-per-actor it's trivial:
append to the inbox URL.

```ts
Op.send     = (p) => enqueue(actorId(p), encode(p)).pipe(Effect.as(execId(p)))
Op.execute  = (p) => enqueue(...).pipe(Effect.zipRight(waitForReply(execId(p))))
```

No `Sharding`, no in-process registration, no `notifyLocal` deadlock. A pure
producer host provides only the inbox table layer.

---

## 5. Reply correlation = `waitForStoredRow`

Encore: `requestIdForPrimaryKey → repliesForUnfiltered → mapExitToPeekResult`
(verified `actor.ts:1001-1050`). Ours collapses to a keyed wait — DurableTable
already ships the exact primitive (`waitForStoredRow`, `DurableTable.ts:565-606`):

```ts
// replies.ts
const Replies = DurableTable("encore-replies", {
  execId: Schema.String,         // primary key
  exit:   Schema.Unknown,        // encoded Exit
})

const waitForReply = (execId) =>
  Replies.of(replyUrl(...)).pipe(
    Effect.flatMap(t => t.waitForStoredRow(execId)),
    Effect.map(row => mapExitToPeekResult(decode(row.exit))) // reuse encore's mapper
  )

peek    = (p) => Replies...get(execId(p)).map(opt => opt ? map(opt) : Pending)
watch   = (p) => Replies...rows().filter(execId).map(map)        // PeekResult stream
waitFor = (p) => waitForReply(execId(p))                         // until terminal
```

`PeekResult` (Pending/Success/Failure/Interrupted/Defect/Suspended) ports verbatim
from `receipt.ts`.

---

## 6. Workflows — wire, don't rebuild (invariant 8)

`DurableStreamsWorkflowEngine` already **is** an upstream `@effect/workflow`
`WorkflowEngine` (verified — `WorkflowEngine.makeUnsafe`, `engine-runtime.ts:307`;
layer adds the upstream Tag). Activity memoization, `DurableDeferred`, durable
clock with boot-recovery, `interrupt`/`resume` — all present. encore's `step.ts`
already targets _upstream_ primitives, not cluster.

So `fromWorkflow` is mostly a **layer swap**:

```ts
// workflow.ts — replace the cluster engine layer with:
DurableStreamsWorkflowEngine.layer({ streamUrl: base });
// step.run / step.sleep / step.race / undo / captureDefects / suspendOnFailure: unchanged
```

The one thing the engine lacks is **signals** (verified: no signal method). Build
them the way the engine's own deferreds work — resolve a `DurableDeferred` and
drop an inbox event so the driver observes it:

```ts
signal.succeed = (execId, value) =>
  Effect.zipRight(
    DurableDeferred.succeed(deferred, { token: tokenFor(execId), value }),
    enqueue(execId, { tag: "__signal", name: signal.name }),
  ); // wake + observe
```

---

## 7. Preemption lives in the driver, not storage (invariant 7)

Delivering a cancel is trivial (`insert` + tail). Making the _running turn_ react
mid-step is a separate concern. The driver runs a watcher fiber over the
cancel/signal feed **next to** the step fiber:

```ts
// driver.ts
Effect.raceFirst(
  runHandler(msg, { signal: abort }), // the work
  watchInbox(actorId).pipe(
    // the interrupt feed
    Stream.filter(isCancelFor(execId)),
    Stream.runHead,
    Effect.flatMap(() => coopAbort(abort) /* or hard Fiber.interrupt */),
  ),
);
```

Storage's job ends at "durable + observable." Cooperative-`AbortSignal`-vs-hard-
interrupt is the driver's call.

---

## 8. Stream proliferation — being de-risked in parallel

> **Status:** a separate spike is exploring a more performant backend, so the
> stream-cost ceiling is **not ours to solve**. Our only job here is to make sure
> encore-ds never _assumes_ stream cost, so it inherits whatever the spike lands
> on. That assumption is contained to exactly one file — see "design contract"
> below. The file-backed findings below are the _current_ backend's numbers, kept
> as a reference point, not a constraint we design to.

I read the **durable-streams server** (`durable-streams/durable-streams`, the
file-backed store). On _today's_ backend, "is a stream a cheap key-prefix or an
expensive object" is concrete and **it is an object**:

```
streamsDir/
  <base64url(streamPath)>/          ← one DIRECTORY per stream  (file-manager.ts:18-29)
      segment_00000.log             ← + ≥1 segment file
  <base64url(...)>/                 ← all streams are FLAT SIBLINGS (no nesting)
  ...
            + per-stream metadata/producer-state in LMDB
```

- **Creation:** `mkdir` + write empty segment (verified `file-manager.ts`). Lazy —
  on first PUT/append. Not free: ≥2 inodes + LMDB keys per actor.
- **Enumeration:** `listStreamPaths()` = `fs.readdir(streamsDir)` = **O(N) over a
  single flat directory** (verified). At 10⁶–10⁸ actors that's millions of sibling
  dirs — the classic flat-namespace filesystem cliff.
- **GC:** built in. `Stream-TTL` / `Stream-Expires-At` headers on PUT →
  auto-cleanup (verified `docs/building-a-server.md:111-113`). Dead-actor inboxes
  expire themselves; no global sweep needed.

**What this means for the design:**

| Concern                    | Verdict                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| Per-actor stream is "free" | **No** — it's a dir + segment + LMDB entry. Budget it.                    |
| Global enumeration         | **Never do it.** Addressing is by-name (invariant 1); we never `readdir`. |
| Dead-actor GC              | **Solved** by `Stream-TTL` on the inbox; set a TTL on enqueue.            |
| 10⁸ flat dirs              | **The real ceiling.** Needs verifying against the FS the server runs on.  |

**Design contract (this is what keeps us insulated from the spike's outcome):**

1. **`addressing.ts` is the only file that knows physical stream layout.** Whether
   one actor = one stream, or N cold actors multiplex onto a shared stream with
   key-prefixed rows (`{actorId}:{msgId}`), is a decision local to that seam.
   Nothing in `mailbox/activation/replies/driver` may assume stream-per-actor.
2. **Never enumerate.** We address by name (invariant 1); no code path calls
   `readdir`/`listStreamPaths`. This holds regardless of backend.
3. **Set a TTL on enqueue.** Free dead-inbox GC on the file backend, harmless on a
   better one.

Given (1), the spike can land _any_ backend — better FS layout, a KV/LMDB-native
store, sharded streams — and encore-ds picks it up with at most a change to
`addressing.ts`. So we proceed with the design now; the backend question runs on
its own track.

Also noted from the server (affects idempotency posture, not blocking): the
file-store does **not** atomically commit producer state with data appends
(`docs/deployment.md:292`) — which is exactly why we key every durable effect by
`ExecId`/`attempt` and make replay return the recorded outcome (invariant 6).

---

## 9. Module sketch

```
src/
  addressing.ts   actorId → streamUrl; ExecId derive            (the only seam that
                                                                 knows physical layout)
  receipt.ts      ExecId + PeekResult                           ← port ~verbatim
  mailbox.ts      Inbox table: insertOrGet enqueue, rows() feed, order by arrivalOff
  activation.ts   owner-key claim, drain loop, epoch takeover
  replies.ts      Replies table + waitForStoredRow
  driver.ts       step fiber ‖ cancel/signal watcher fiber
  state.ts        durable state row + rows() watch   (see decision below)
  workflow.ts     DurableStreamsWorkflowEngine layer + signal plumbing
  step.ts         ← port ~verbatim (targets upstream @effect/workflow already)
  actor.ts        fromEntity/fromWorkflow/toLayer/toTestLayer   ← ported surface
  index.ts
```

New code: `mailbox / activation / replies / driver / state`. Ported: `actor /
receipt / step`.

---

## 10. First slice (`tiny-encore`) — what makes this real

One entity + one workflow, end to end, with conformance tests that double as the
spec:

1. two claimers race → one `Inserted` drains, loser sees `Found` _(activation)_
2. idempotent `send` → duplicate payload == enqueued, same ExecId _(mailbox)_
3. `execute` round-trip → reply correlated by ExecId _(replies)_
4. crash mid-step → replay returns recorded outcome, no double-run _(idempotency)_
5. cancel mid-activation → driver observes it _(driver)_
6. `send` from a process with **no handler layer** _(producer-only)_
7. one signal resolves a `DurableDeferred` and wakes the workflow _(workflow)_

---

## Two decisions I want your call on

- **Entity state.** encore's is live-heap-only (`Ref<Map>`, lost on restart,
  `actor-state.ts:42`). On DurableTable I'd make it a **durable, projectable row** —
  strictly more capable (cross-process, survives restart). Sketched that way in
  `state.ts` above. Say the word if you'd rather keep exact live-heap parity.
- **Where it lives.** New `packages/encore-ds` in this repo (easy to diff surface
  against the cluster version) vs. standalone vs. inside firegrid. Leaning in-repo.
