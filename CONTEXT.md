# effect-encore — domain context

Declarative actors + durable workflows over effect v4 cluster/rpc/workflow. This file
names the load-bearing concepts so architecture reviews and AI navigation use one vocabulary.

## Core concepts

- **Actor** — a declarative entity or workflow definition (`Actor.fromEntity` / `Actor.fromWorkflow`)
  that compiles to effect's cluster `Entity` / `Workflow`. Not a new runtime.
- **Operation** — one named message on an Actor (`payload` / `success` / `error` / `id` / `persisted`
  / `deliverAt`). Callers construct an OperationValue and dispatch it via `ref.execute(op)` (await a
  reply) or `ref.send(op)` (fire-and-forget). Delivery mode is the caller's choice, not the definition's.
- **ExecId** — the reply token. A branded string `entityId\x00tag\x00primaryKey` identifying one
  operation execution, returned by `send` and consumed by `peek` / `waitFor`. Carries phantom
  `Success`/`Error` types. **The wire/dedup identity** — its format is a persisted contract.
- **PeekResult** — the terminal-or-not state of an execution: `Pending | Success | Failure |
Interrupted | Defect | Suspended`. What `peek(execId)` returns and `waitFor` polls to terminal.

## Seams (where behaviour is swapped without editing in place)

- **Client** _(landed — seam #1)_ — the unified transport seam. One Tag owning
  `send / resolve / peek / flush / redeliver` plus the wire-envelope builder, with adapters
  `Client.layer.{fromConfig, fromSharding, memory, test}`. Supersedes the hand-assembled
  mailbox+resolver+Snowflake triad. Address resolution (`fromConfig`/`fromSharding`, carrying the
  shard-parity invariant) survives as an **internal strategy** the Client holds, not a public Tag.
  Adapter-contract caveat: `fromConfig`/`fromSharding`/`memory` support the full
  `send + peek + flush + redeliver` surface (and `fromSharding` the `send → peek → Success/Failure`
  reply round-trip over a real cluster runtime). `Client.layer.test` is **send-routing +
  control/peek-over-its-own-storage ONLY** — its injected per-entity test client
  (`Entity.makeTestClient`) routes replies through an in-memory `RpcServer.makeNoSerialization`
  that bypasses the `entityManager` (the only writer of handler replies to `MessageStorage`), so a
  `{ discard: true }` reply reaches no storage and `peek` stays `Pending`. Reply round-trips on the
  test transport go through the `fromWorkflow` test path (WorkflowEngine-persisted) instead.
- **State\<A\>** _(landed — seam #2)_ — the per-entity mutable state handle:
  `get / set / update / changes`, with **per-State mutation serialization** (concurrent `update`s
  linearized). Grown from the read-only `ActorStateHandle` (`get`+`watch`). In-process
  (`SubscriptionRef`) today; durable per-entity backing (`cluster_states` + CAS) is a deferred
  follow-up, not in the port.
- **ReplySource** _(landed — seam #3)_ — the await-engine's seam:
  `(ExecId) => Effect<PeekResult>`. Lifts the mechanism (ExecId mint/parse, Exit→PeekResult mapping,
  the `waitFor` poll loop) out of `actor.ts` into `receipt.ts`, so the reply-source is swappable and
  the Exit-classification logic is unit-testable. **Default adapter = `MessageStorage`** (the existing
  storage-backed `peekImpl`). Downstreams that resolve a token from an external event (e.g. a Stripe
  webhook) drive it through the same default SQL `MessageStorage` — the reply lands in
  `cluster_replies` and `peek`/`waitFor` see it terminal. The seam also collapses the triplicated
  ExecId format into one **ExecIdCodec**.

- **EncoreMessageStorage** — the storage seam (extends upstream `MessageStorage` with
  `deleteEnvelope` for surgical `.rerun`). SQL adapter is concrete; the `layer`/`fromMessageStorage`
  composers make a second adapter mechanical.

## Order workflow (downstream — GYC registrar, the consuming use case)

- **Order** — a durable encore actor in GYC modelling a registration payment's full lifecycle:
  `process` (create Stripe Checkout session, then suspend awaiting the reply token) →
  `cancel` (abandon a pending session) → `refund` (Stripe refund post-paid) → `expire`
  (deadline sweep, pending→expired). State machine: `pending | paid | cancelled | refunded | expired`.
  Backed by encore's **SQL `MessageStorage`** stood up in GYC (`@effect/sql` + a DB) — the Order is a
  first-class durable actor; the Stripe webhook resolves the `process` operation's **ExecId** when the
  payment settles (`checkout.session.completed`).
