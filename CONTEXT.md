# effect-encore — domain context

Declarative actors + durable workflows over effect v4 cluster/rpc/workflow. This file
names the load-bearing concepts so architecture reviews and AI navigation use one vocabulary.

## Core concepts

- **Actor** — a declarative entity or workflow definition (`Actor.fromEntity` / `Actor.fromWorkflow`)
  that compiles to effect's cluster `Entity` / `Workflow`. Not a new runtime.
- **Operation** — one named message on an Actor (`payload` / `success` / `error` / `id` / `persisted`
  / `deliverAt`). Callers construct an OperationValue and dispatch it via `ref.execute(op)` (await a
  reply) or `ref.send(op)` (fire-and-forget). Delivery mode is the caller's choice, not the definition's.
- **Invocation** — one typed call to an Operation. It owns the input, operation value, actor identity,
  and ExecId. Encore compiles it once before execution or transport.
- **ExecId** — the reply token. A branded string `entityId\x00tag\x00primaryKey` identifying one
  operation execution, returned by `send` and consumed by `peek` / `waitFor`. Carries phantom
  `Success`/`Error` types. **The wire/dedup identity** — its format is a persisted contract.
- **PeekResult** — the terminal-or-not state of an execution: `Pending | Success | Failure |
Interrupted | Defect | Suspended`. What `peek(execId)` returns and `waitFor` polls to terminal.

## Seams (where behaviour is swapped without editing in place)

- **Client** — the unified transport seam. One Tag owns
  `send / resolve / peek / flush / redeliver / pruneWorkflow` plus the wire-envelope builder, with adapters
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
- **State\<A\>** — the opaque per-entity mutable state handle:
  `get / set / update / changes`, with **per-State mutation serialization** (concurrent `update`s
  linearized). The module functions are the only public operations. The read closure, write closure,
  PubSub, and semaphore are private mechanics. The state is local to one actor runtime.
- **Stored reply lookup** — the Client-owned read path from ExecId to PeekResult. It uses Effect
  `MessageStorage` and the internal address resolver. Exit classification and ExecIdCodec remain pure,
  public utilities. There is no separate reply service.
- **Message deletion** — the internal storage capability for `deleteInvocation`.
  Effect owns address-wide `MessageStorage` cleanup. Encore adds only the single-invocation deletion
  required by entity rerun.
