# effect-encore

## 0.24.0

### Minor Changes

- [`37c9523`](https://github.com/cevr/effect-encore/commit/37c9523bf9dd80bb19111d4073e87a11856e49b8) Thanks [@cevr](https://github.com/cevr)! - Expose pending workflow compensation attempts. Return no pending attempt for a completed run. Reject stale and conflicting operator decisions with a typed error. Wait until the durable winning decision is visible before returning.

## 0.23.0

### Minor Changes

- [`af28e8d`](https://github.com/cevr/effect-encore/commit/af28e8d93a91cd8bc587e8ce0777f48f06d1f0fb) Thanks [@cevr](https://github.com/cevr)! - Allow workflow compensations to fail with the Workflow error type. Persist the failure with the Workflow error schema before operator recovery.

## 0.22.0

### Minor Changes

- [`93c3a0f`](https://github.com/cevr/effect-encore/commit/93c3a0fa81047f8ccc347a6e873faf028146787e) Thanks [@cevr](https://github.com/cevr)! - Add workflow inspection methods that accept a durable execution identifier.

## 0.21.1

### Patch Changes

- [`49fd9ed`](https://github.com/cevr/effect-encore/commit/49fd9edb0aa73607cf4a7bb7cafd6308a0d8fe51) Thanks [@cevr](https://github.com/cevr)! - Delegate workflow idempotency keys to Effect Activity.

## 0.21.0

### Minor Changes

- [`2709cd0`](https://github.com/cevr/effect-encore/commit/2709cd0ab0b9971b337df5bd3e18b3a68ea46734) Thanks [@cevr](https://github.com/cevr)! - Namespace durable signals and add delivery helpers that accept an execution ID.

## 0.20.0

### Minor Changes

- [`b64a218`](https://github.com/cevr/effect-encore/commit/b64a218f9d4d66a40a742bd129c9b4df76fa92e6) Thanks [@cevr](https://github.com/cevr)! - Add a public dynamic signal constructor to Workflow actors.

## 0.19.0

### Minor Changes

- [`718b877`](https://github.com/cevr/effect-encore/commit/718b877cc436d12f542b65c14cc3e632292ef35e) Thanks [@cevr](https://github.com/cevr)! - Allow dynamic signals on workflows with typed success and error schemas.

## 0.18.1

### Patch Changes

- [`4b99b6e`](https://github.com/cevr/effect-encore/commit/4b99b6e1c2b2671d81dc8c6bfe8442e94680c6f5) Thanks [@cevr](https://github.com/cevr)! - Capture the workflow engine in workflow clients created by `Actor.toLayer`.

## 0.18.0

### Minor Changes

- [`50ebc06`](https://github.com/cevr/effect-encore/commit/50ebc0649d18b18488f2322c8e111977cb272f60) Thanks [@cevr](https://github.com/cevr)! - Add stable canonical JSON encoding and SHA-256 helpers for durable workflow identities.

## 0.17.0

### Minor Changes

- [`d364ce2`](https://github.com/cevr/effect-encore/commit/d364ce235891f695c355f965a65cb6bdc4359396) Thanks [@cevr](https://github.com/cevr)! - Make workflow compensation replay-safe. Add operator retry and stop controls for failed compensation Activities. Use Effect Activity retry slots for `step.run` retries. Remove the low-level `makeStepContext` export so workflow assembly stays inside `Actor`.

  Replace `retry: schedule` with `retry: { times }`. Effect Activity retries assign a durable slot to each attempt. They do not accept schedules because schedule delays are not durable.

## 0.16.0

### Minor Changes

- [`2fbd097`](https://github.com/cevr/effect-encore/commit/2fbd0975326bab0f0ad489e677ccb58988c92f52) Thanks [@cevr](https://github.com/cevr)! - Deepen the public API over Effect primitives.
  - Keep the convenient Step API and delegate race execution to Effect Activity.
  - Compile each actor invocation once before execute or send.
  - Internalize mailbox, address resolver, reply-source, and storage Tags.
  - Make State opaque and keep mutation mechanics inside the State module.
  - Keep SQL and custom storage adapters for rerun deletion.

  This release removes the public ReplySource, ActorMailbox, ActorAddressResolver,
  EncoreMessageStorage, ClientShape, and State mechanic fields.

## 0.15.0

### Minor Changes

- [#36](https://github.com/cevr/effect-encore/pull/36) [`c419134`](https://github.com/cevr/effect-encore/commit/c41913433732cee083abd2d6a6f48e514841cfd9) Thanks [@cevr](https://github.com/cevr)! - Upgrade the runtime to Effect 4.0.0-beta.106.

  Add the new `EntityNotAssignedToRunner` cluster routing error to durable send operations.

  Require the Effect `Crypto` service in SQL message storage layers.

### Patch Changes

- [#36](https://github.com/cevr/effect-encore/pull/36) [`8378b53`](https://github.com/cevr/effect-encore/commit/8378b5394c505b8270b442975788f16ea4e6c6bc) Thanks [@cevr](https://github.com/cevr)! - Migrate the lint and typecheck toolchain to the canonical Effect stack (oxlint-plugin-effect via jsPlugins, TypeScript 7, `@effect/tsgo` diagnostics) and clear the resulting violations. Behavior is unchanged.

## 0.14.0

### Minor Changes

- [#34](https://github.com/cevr/effect-encore/pull/34) [`13a6f5e`](https://github.com/cevr/effect-encore/commit/13a6f5ea45cf346ba50099968101a38e111a15d7) Thanks [@cevr](https://github.com/cevr)! - Land the three actor-runtime seams (`Client`, `State<A>`, `ReplySource`) recorded in ADR-0001, reshaping the v4 runtime for the downstream GYC Order entity, and **drop the v3 compatibility leg** — `effect-encore` is now v4-only.

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

## 0.13.0

### Minor Changes

- [`a1b3921`](https://github.com/cevr/effect-encore/commit/a1b3921e74db65ded1a498a92596411c4d5df9a4) Thanks [@cevr](https://github.com/cevr)! - Add `Op.sendAndAwait(payload, { timeout, schedule? })` to entity operation handles: fire a durable send and poll the persisted reply until terminal, without requiring local Sharding. Sender-only hosts (ActorSenderLayer / storage-backed sender runtimes) can now await an entity's applied result instead of being limited to fire-and-forget send. Persisted Failure replies surface in the error channel; Defect/Interrupted die; exceeding the (required) timeout fails with the new `SendAndAwaitTimeout` tagged error. Also exported: `SendAndAwaitTimeout`.

## 0.12.8

### Patch Changes

- [`fc0e36f`](https://github.com/cevr/effect-encore/commit/fc0e36f2e78092c33404028b53cbb69ca89cf79f) Thanks [@cevr](https://github.com/cevr)! - Support Effect v4 beta.75 workflow construction and addressing.

## 0.12.7

### Patch Changes

- [`bef28ac`](https://github.com/cevr/effect-encore/commit/bef28ac42de85ba74b57cff92d7e9bfa31ff150f) Thanks [@cevr](https://github.com/cevr)! - Preserve caller-provided actor ref context over the actor layer context.

## 0.12.6

### Patch Changes

- [`c9923dd`](https://github.com/cevr/effect-encore/commit/c9923dd9b50f562e6aa890977c73ba32f6bf59da) Thanks [@cevr](https://github.com/cevr)! - Merge bound actor-ref context with the caller context at invocation time so
  request-local services remain available while actor runtime services stay hidden.

## 0.12.5

### Patch Changes

- [`25bad3c`](https://github.com/cevr/effect-encore/commit/25bad3cf018cb626ddb3809f706533af920416fe) Thanks [@cevr](https://github.com/cevr)! - Bind actor client refs to the layer-build context so `ActorRef.execute` and
  `ActorRef.send` do not depend on the caller recreating cluster runtime services.

## 0.12.4

### Patch Changes

- [`5c9f9d1`](https://github.com/cevr/effect-encore/commit/5c9f9d1956c477e5ddad909f897e64eb008cff06) Thanks [@cevr](https://github.com/cevr)! - Expose actor-bound `Control` services from entity layers so applications can
  run mailbox control operations without threading cluster storage and address
  resolver requirements through their own services.

## 0.12.3

### Patch Changes

- [`a5003af`](https://github.com/cevr/effect-encore/commit/a5003afb0a54644a85b0b4723b5a3d21668c4417) Thanks [@cevr](https://github.com/cevr)! - Add an actor build-context helper for capturing layer-provided services while leaving entity-scoped services to Encore.

## 0.12.2

### Patch Changes

- [`bc7868e`](https://github.com/cevr/effect-encore/commit/bc7868e68ee8b48652ccfee4ed7cd3ee12b373a9) Thanks [@cevr](https://github.com/cevr)! - Expose actor-specific bound state services from `Actor.toLayer` and `Actor.toTestLayer`.

## 0.12.1

### Patch Changes

- [`fa9f0b7`](https://github.com/cevr/effect-encore/commit/fa9f0b7e9077d947cbab8b4dfe42a7255895c149) Thanks [@cevr](https://github.com/cevr)! - Support Effect v4 beta.66 natively and treat concurrent duplicate actor sends as idempotent.

## 0.12.0

### Minor Changes

- [`fe0d785`](https://github.com/cevr/effect-encore/commit/fe0d785a03e9779c261abc069f83ce45ccab2e1c) Thanks [@cevr](https://github.com/cevr)! - `Actor.toLayer` and `Actor.toTestLayer` now accept a `withScope` option that builds a per-call `Context` from the entity address. The returned context is merged into each handler invocation via `Effect.provide`, so handlers can `yield* Tag` to read services derived from the entity id without threading them as parameters.

  ```ts
  class WorkspaceId extends Context.Service<WorkspaceId, string>()("…/WorkspaceId") {}

  Actor.toLayer(MyActor, handlers, {
    withScope: (address) =>
      Effect.succeed(Context.make(WorkspaceId, parseWorkspace(address.entityId))),
  });
  ```

  `withScope` runs before every handler call (not once per activation), so it can read the live `CurrentAddress` and derive different scopes for different entities. Tags it provides become available to handlers via `yield* Tag` and are reflected as a typed `S` in the layer's requirements (excluded so they're satisfied by `withScope` itself, not external Layer plumbing).

  Use this to lift per-actor-instance setup — workspace ids, request-scoped storage handles, anything derived from the entity key — out of the actor's outer Layer and into a single ergonomic option on `toLayer`.

- [`2bd98ef`](https://github.com/cevr/effect-encore/commit/2bd98efc9af9ada02db94952890c425b9d0ef3da) Thanks [@cevr](https://github.com/cevr)! - `Actor.entityIdCodec(schema)`. Collision-safe codec for tuple-shaped entity ids. `Entity.toLayer` keys entities by a `string` `entityId`; when the natural key is a tuple like `(workspaceId, sessionId, branchId)`, a naive `${a}:${b}:${c}` join collides whenever a component contains `:`. The new codec encodes each component through `encodeURIComponent` before joining on `:`, so segments are unambiguous on decode, then validates the decoded tuple through the supplied schema.

  ```ts
  const Key = Schema.Tuple(Schema.String, Schema.String, Schema.String);
  const codec = Actor.entityIdCodec(Key);
  codec.encode(["ws-1", "sess-2", "branch:3"]); // "ws-1:sess-2:branch%3A3"
  yield * codec.decode("ws-1:sess-2:branch%3A3"); // ["ws-1", "sess-2", "branch:3"]
  ```

  Decode failures surface as `EntityIdDecodeError` (segment is not valid URI-encoded text) or the schema's parse error (tuple shape disagrees).

- [`91e755b`](https://github.com/cevr/effect-encore/commit/91e755b798b6738cb82713c8d345898c2690aa07) Thanks [@cevr](https://github.com/cevr)! - Export `SenderContext` type alias bundling the three producer-side cluster requirements (`MessageStorage | ActorAddressResolver | Sharding`). Use it in `R` channels for ops that send messages to actors instead of re-listing the union at every signature.

- [`d1f48f5`](https://github.com/cevr/effect-encore/commit/d1f48f5b033ce8b8743aba2462a0683b4bd8df40) Thanks [@cevr](https://github.com/cevr)! - Materialize entity state automatically for cold `getState` and `watchState` calls so apps no longer need no-op activation operations.

- [`02e72fc`](https://github.com/cevr/effect-encore/commit/02e72fcf10cede8eeb4fd3551006a2b15e94ff21) Thanks [@cevr](https://github.com/cevr)! - Typed actor state. `Actor.fromEntity(name, defs, { state: { schema, error? } })` now wires the registered state handle through `Schema.decodeUnknown` at the read boundary. `getState` / `watchState` / `waitForState` return `Schema.Type<schema>` instead of `unknown`, and emissions are validated through the schema (defense-in-depth at the registry boundary, not a bare type assertion). The optional `error` schema decodes the failure channel.

  ```ts
  const Counter = Actor.fromEntity(
    "Counter",
    { Increment: { ... } },
    { state: { schema: Schema.Number } },
  );

  // inferred as Effect<number, ...>
  const value = yield* Counter.getState("c1");
  ```

  Backwards compatible — actors declared without `state` continue to return `unknown` from the state methods.

- [`da7e14f`](https://github.com/cevr/effect-encore/commit/da7e14f7009ff311eeea1cb10f70ac1279055dd8) Thanks [@cevr](https://github.com/cevr)! - Add `Actor.waitForState(entityId, predicate)` and `waitForStateOf(address, predicate)` for predicate-driven state observation. Resolves on the first state snapshot satisfying the predicate. Compose `Effect.timeout` for time-bounded waits.

## 0.11.1

### Patch Changes

- [`dc2131c`](https://github.com/cevr/effect-encore/commit/dc2131cb3176ef6db186811f7cf50e9825a1c60a) Thanks [@cevr](https://github.com/cevr)! - Update the Effect v4 toolchain to `effect@4.0.0-beta.64`, refresh the matching SQLite integration package, and run tsdown through Bun so CI and local builds share Bun's package resolution.

## 0.11.0

### Minor Changes

- [`63b4bea`](https://github.com/cevr/effect-encore/commit/63b4bea8f0ee26815737ee158b43c1b6cea5569a) Thanks [@cevr](https://github.com/cevr)! - Add SQL-backed Encore message storage helpers. `fromSqlClient()` and
  `fromSqlClientWithShardingConfig()` now provide both upstream Effect Cluster
  `MessageStorage` and Encore's `EncoreMessageStorage`, including surgical
  `deleteEnvelope` support for entity rerun.

## 0.10.0

### Minor Changes

- [`8729916`](https://github.com/cevr/effect-encore/commit/87299167da4696f8329ea5a72ea0a988f199408d) Thanks [@cevr](https://github.com/cevr)! - Add an Encore-owned live actor state protocol for entity handlers.

  Entity handlers can now call `Actor.registerState({ get, watch })` from the entity scope. The registration is keyed by the current entity address and is automatically deregistered when the entity scope closes.

  Entity actors expose `getState(entityId, { materialize? })`, `watchState(entityId, { materialize? })`, and `listStateEntityIds()` so host apps no longer need to maintain side registries for actor-local state snapshots and streams.

  Also modernizes the project tooling to the `@effect/tsgo` / tsgo setup, upgrades the v4 line to the latest Effect beta, enables type-aware oxlint, and mirrors the state protocol across the v3 entrypoint.

## 0.9.0

### Minor Changes

- [`59885ec`](https://github.com/cevr/effect-encore/commit/59885ecf6acb86538aa5ee86d0d7061a92e954f6) Thanks [@cevr](https://github.com/cevr)! - Add `ActorSenderLayer` — a bundle of `ActorMailbox` + `ActorAddressResolver` + `Snowflake.Generator` (all on the `fromConfig` variants) for sender-only / ops-only hosts. Cuts the producer wiring from a three-layer `Layer.mergeAll` to a single `ActorSenderLayer.layer` (still requires `MessageStorage` + `ShardingConfig`).

  `ActorSenderLayer.layerMemory` provides the same bundle with in-memory storage and default sharding config preset — drop-in for tests and single-process setups.

  The underlying `ActorMailboxLayer` / `ActorAddressResolverLayer` factories remain exported unchanged for advanced wiring (e.g. ops-only hosts that need address math but not `.send`).

- [#17](https://github.com/cevr/effect-encore/pull/17) [`fe13b49`](https://github.com/cevr/effect-encore/commit/fe13b494d4125d5355645ba629ebfe2902081fb2) Thanks [@cevr](https://github.com/cevr)! - Fix producer-only `.send()` deadlock by introducing two narrow Tags that replace the previous `ActorClientService` dispatch surface.

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

## 0.8.3

### Patch Changes

- [`3506a8a`](https://github.com/cevr/effect-encore/commit/3506a8a164db4a5b4f362a4cd949cbd15981deaf) Thanks [@cevr](https://github.com/cevr)! - Remove the `DedupeStrategy` operation option and helper exports.

  Deduplication policy stays at the actor operation boundary through the `id` function: return a stable `primaryKey` for durable at-most-once work, or include the higher-level scheduling/rerun semantics in that key when fresh work should be allowed.

## 0.8.2

### Patch Changes

- [`45c5696`](https://github.com/cevr/effect-encore/commit/45c56963dde2170eac875f99124934927caf6c69) Thanks [@cevr](https://github.com/cevr)! - Add entity operation dedupe strategies for v3 and v4 actors.

  `dedupe: DedupeStrategy.AtMostOnce` remains the default persisted-entity behavior: completions are reused until `.rerun(payload)` explicitly clears the execId. `dedupe: DedupeStrategy.InProgress` marks the storage primary key for adapters that want active-only dedupe, where duplicate producers coalesce while work is in flight but fresh work can enqueue after terminal completion.

## 0.8.1

### Patch Changes

- [`4e58a1c`](https://github.com/cevr/effect-encore/commit/4e58a1cd0cf55e42ffe43235f2ced774e9baafb3) Thanks [@cevr](https://github.com/cevr)! - Workflow `.rerun(payload)` now clears the `Workflow/-/DurableClock` sub-entity in addition to the workflow's own address.

  Previously, a workflow that used `step.sleep` (durable path, i.e. duration ≥ `inMemoryThreshold`) would leave the clock entry behind after `.rerun`. The orphan clock would later fire into a workflow that no longer expects it. Mirrors upstream's `clearClock` (`@effect/cluster/ClusterWorkflowEngine` ~L124-134), which only triggers when a running fiber observes the InterruptSignal — not when the workflow is suspended waiting on the clock.

  Also fixes a workflow `toLayer` / `toTestLayer` type leak: `WorkflowInstance`, `Execution<Name>`, and `Scope.Scope` no longer leak into the layer's `RIn`. These are runtime-injected by the engine and shouldn't appear in the user's required environment. Type-level regression tests added in both v3 and v4.

## 0.8.0

### Minor Changes

- [`abf0b60`](https://github.com/cevr/effect-encore/commit/abf0b6063f1310d78571d474d83f1232b618a523) Thanks [@cevr](https://github.com/cevr)! - Payload-only per-op API + unified `id` fn + surgical rerun primitive.

  **EntityActor — per-op `OperationHandle`**

  Each operation tag is now a handle exposing payload-only methods. The old `Actor.ref(entityId)` + `ref.execute(Actor.Op({...}))` shape is gone.

  ```ts
  // before
  const ref = yield * Counter.ref("loc-A");
  yield * ref.execute(Counter.Increment({ amount: 5 }));

  // after
  yield * Counter.Increment.execute({ id: "loc-A", amount: 5 });
  ```

  `OperationHandle` exposes `execute / send / executionId / peek / watch / waitFor / rerun / make`. Actor-level surface is just `flush / redeliver / interrupt / Context / of / $is`.

  **WorkflowActor — payload-only at actor level**

  Workflows have one op, so methods promote to actor level: `Workflow.execute(payload) / .send / .executionId / .peek / .watch / .waitFor / .rerun / .make`. `ref()` and the `Run` constructor are removed; `make(payload)` is the escape hatch.

  **Unified `id` fn**

  `OperationDef.primaryKey` and `WorkflowDef.idempotencyKey` are replaced by a single `id` fn:
  - `id` returns `string` → `entityId === primaryKey` (entity); idempotency key (workflow).
  - `id` returns `{ entityId, primaryKey? }` → divergent dedup (entity only; workflows reject the object form at the type level). `primaryKey` defaults to `entityId` when omitted.

  **Surgical `.rerun(payload)`**

  Dedup records survive forever. `.rerun(payload)` is the surgical escape hatch:
  - Entity: derives `{entityId, primaryKey}`, deletes the targeted envelope via `EncoreMessageStorage.deleteEnvelope`. No-op on non-existent execId.
  - Workflow: `WorkflowEngine.interrupt` + `EncoreMessageStorage.clearAddress` — wipes run reply and every cached activity reply.

  **`EncoreMessageStorage`**

  New Context.Tag at `effect-encore/storage` extending upstream `MessageStorage` with `deleteEnvelope(requestId)`. Adapters provide both via `encoreMessageStorageLayer(upstream, { deleteEnvelope })` or `fromMessageStorage(storage, { deleteEnvelope })`. Required by `.rerun` on entities.

  **`interrupt` rewired**

  Entity-level `interrupt(entityId)` now calls `storage.clearAddress(address)` (was `Effect.die`). Distinct intent from `flush` (same impl): "stop accepting more work" vs "clean slate". Programmatic in-flight fiber cancellation still requires `Sharding.passivate` (not yet public upstream).

  **Reserved keys (entity)**

  Reserved operation names now: `_tag, _meta, $is, Context, name, type, of, interrupt, flush, redeliver, pipe`. (`ref / peek / watch / waitFor / executionId` removed — they're now per-op handle methods, not actor-level.)

## 0.7.0

### Minor Changes

- [`d4aba0e`](https://github.com/cevr/effect-encore/commit/d4aba0e7702c73090c0234c29b0026e9f1881ebc) Thanks [@cevr](https://github.com/cevr)! - Rename `.actor()` to `.ref()` on EntityActor and WorkflowActor. Fix `Actor.toLayer` to bubble handler requirements instead of `any`.
  - `actor.ref(entityId)` — returns `ActorRef` (was `.actor()`)
  - `Actor.toLayer` entity overload: return type `Layer<Service, never, RX | Scope | MiddlewareClient>` (was `any`)
  - `Actor.toLayer` workflow overload: return type `Layer<Service, never, RX | WorkflowEngine>` (was `any`)
  - `"ref"` replaces `"actor"` in reserved operation/signal names

## 0.6.1

### Patch Changes

- [`ec76eb0`](https://github.com/cevr/effect-encore/commit/ec76eb08fb52a48acd09540bbcbd946a4f558194) Thanks [@cevr](https://github.com/cevr)! - Add `.of` typed identity method on `EntityActor` for type-safe handler construction.
  - `actor.of(handlers)` — returns handlers unchanged but infers types from the actor's operation defs
  - Eliminates manual type annotations when building handlers inside `Effect.gen`
  - Added `"of"` to reserved operation/signal names

## 0.6.0

### Minor Changes

- [`c27a8f8`](https://github.com/cevr/effect-encore/commit/c27a8f82a8ac033e4210eb1b4fe5065fb00e5c54) Thanks [@cevr](https://github.com/cevr)! - Rename `ActorObject` to `EntityActor`, `WorkflowActorObject` to `WorkflowActor`. Add first-class identity and type guards.
  - `actor.name` — the actor's name (e.g. `"VectorUpdate"`)
  - `actor.type` — the cluster entity type (e.g. `"VectorUpdate"` for entities, `"Workflow/GeocodeLocation"` for workflows)
  - `Actor.isEntity(actor)` — type guard narrowing to `EntityActor`
  - `Actor.isWorkflow(actor)` — type guard narrowing to `WorkflowActor`
  - `AnyEntityActor`, `AnyWorkflowActor`, `AnyActor` convenience types
  - `_tag` values: `"EntityActor"` / `"WorkflowActor"`

## 0.5.0

### Minor Changes

- [`ca3726f`](https://github.com/cevr/effect-encore/commit/ca3726f4e77bb3efaa7316891e62c25288ff527e) Thanks [@cevr](https://github.com/cevr)! - Add `flush` and `redeliver` methods to entity ActorObject.
  - `actor.flush(actorId)` — delete all messages and replies via `MessageStorage.clearAddress`
  - `actor.redeliver(actorId)` — clear read leases so messages re-enter polling via `MessageStorage.resetAddress`

  Both require `MessageStorage | Sharding` in the Effect context (same as `peek`/`watch`).

  Fix shard group derivation in `peek`/`flush`/`redeliver` to use `entity.getShardGroup` instead of actor name. The previous implementation computed wrong shard IDs (e.g. `"VectorUpdate:1"` instead of `"default:1"`), which would have caused `resetAddress` to silently no-op.

## 0.4.4

### Patch Changes

- [`6631121`](https://github.com/cevr/effect-encore/commit/66311212259ab5275b8d8fa44e4f5ad59c6a77e4) Thanks [@cevr](https://github.com/cevr)! - Use layerPassthrough polyfill in v3 build — Layer.passthrough was removed from Effect 3.x runtime despite existing in type definitions.

## 0.4.3

### Patch Changes

- [`59961e1`](https://github.com/cevr/effect-encore/commit/59961e1f81d0251ea0f4e5161fc58d22d2c4f8c5) Thanks [@cevr](https://github.com/cevr)! - Fix `Actor.toLayer` layer composition — use passthrough so Sharding/WorkflowEngine flow through to program code.

  The handler layer consumes these services without re-providing them, so `ref.execute()` and `ref.send()` couldn't find them at runtime. v3 uses `Layer.passthrough`; v4 uses a local polyfill via `Layer.merge(Layer.effectContext(Effect.context<RIn>()), layer)`.

## 0.4.2

### Patch Changes

- [`9c74451`](https://github.com/cevr/effect-encore/commit/9c74451f9d8740fd28cda81bc13979cf44e8157b) Thanks [@cevr](https://github.com/cevr)! - Fix `Actor.toLayer` layer composition — use `Layer.provideMerge` instead of `Layer.merge` for handler+client layers. The client layer needs Sharding from the handler layer's output; `Layer.merge` treated them as peers, causing "Service not found: Sharding" when consumers provided ClusterRuntime after the actor layer.

## 0.4.1

### Patch Changes

- [`73fabc1`](https://github.com/cevr/effect-encore/commit/73fabc1c0427322c77df6211e9b6d691048e88fe) Thanks [@cevr](https://github.com/cevr)! - Export `ActorClientService` and `ActorClientFactory` types from both v3 and v4 entry points. These were internal-only, causing TS4023 errors when consumers exported `Actor.toLayer` results.

## 0.4.0

### Minor Changes

- [`f284a99`](https://github.com/cevr/effect-encore/commit/f284a9976ae8a13691b6b89099ef5adb0767a8d6) Thanks [@cevr](https://github.com/cevr)! - Workflow step DSL, caller API cleanup, and declarative signals.

  **Breaking:** `ref.call` → `ref.execute`, `ref.cast` → `ref.send`. Workflow `actor(entityId)` → `actor()` (nullary). Workflow handler receives `(payload, step)` instead of `(payload, executionId)`. `step.signal()` and `WorkflowActorObject.signal()` removed — signals are now declared on `WorkflowDef.signals` and become typed properties on the actor.

  **New:** `WorkflowStepContext` with `step.run`, `step.sleep`, `step.race`, `step.attempt`, `step.suspend`, `step.executionId`, `step.idempotencyKey`, `step.scope`, `step.provideScope`, `step.addFinalizer`, `step.raceSignals`. Declarative `signals` on `WorkflowDef` — `SignalDef`, `SignalDefs` types. `WorkflowSignal` properties on the actor for external resolution. `waitFor` on both entity and workflow actors. `WorkflowDef` absorbs `suspendedRetrySchedule`, `captureDefects`, `suspendOnFailure`.

- [`d100b39`](https://github.com/cevr/effect-encore/commit/d100b39a104ccfb170c768228073c9ea6ae9c3c7) Thanks [@cevr](https://github.com/cevr)! - Add `Actor.withProtocol` for transforming the underlying RpcGroup protocol (middleware, annotations), make `ActorObject` pipeable, and add `PeekResultSchema` generic schema factory for encoding/decoding `PeekResult` values.

## 0.3.0

### Minor Changes

- [`f3cf47b`](https://github.com/cevr/effect-encore/commit/f3cf47b72f9d1bbe182b8676fcd126446ea21b99) Thanks [@cevr](https://github.com/cevr)! - ### Bug fixes
  - **ExecId parsing**: Use null byte separator instead of colon — fixes entity IDs/primary keys containing colons
  - **Peek decoding**: Decode encoded values from storage using `Schema.decodeUnknownEffect` (supports effectful schemas)
  - **Workflow peek cause**: Walk Exit/Cause tree properly — returns `Failure(error)`, `Defect(defect)`, or `Interrupted` instead of wrapping raw cause
  - **Zero-payload operations**: Install `PrimaryKey.symbol` on empty payload class for storage indexing
  - **Missing default**: `mapExitToPeekResult` switch now has default clause
  - **Unknown operation guard**: `Effect.die` with descriptive error instead of silent `undefined`
  - **Entity interrupt**: Stubbed with descriptive error (Sharding.passivate not public API)

  ### Features
  - **Scalar Schema payloads**: `payload: Schema.String` now works. Opaque payloads stored under `_payload`, accessed via `operation._payload` in handlers.
  - **Entity `executionId`**: Pure function `Actor.executionId(entityId, op)` computes `ExecId<S,E>` without executing
  - **Workflow `executionId`**: Now returns branded `ExecId<S,E>` instead of plain `string`
  - **`fromRpcs` on `Actor` namespace**: Escape hatch now accessible via `Actor.fromRpcs`

  ### Breaking changes
  - **ExecId format changed**: From `entityId:tag:primaryKey` to null byte separated. No migration needed (0 users, published last night).
  - **`withCompensation` removed from `WorkflowActorObject`**: Use `Workflow.withCompensation` from upstream directly — it's a workflow primitive, not an actor concern.
  - **Dead compat shims deleted**: `src/client.ts`, `src/handlers.ts`, `src/testing.ts` removed (no subpath exports referenced them).

  ### v3 parity
  - `WorkflowRunDefs` type ported — workflow actors retain typed `ActorRef`
  - Typed `toTestLayer`/`toLayer` overloads for both entity and workflow actors
  - All bug fixes mirrored

## 0.2.0

### Minor Changes

- [`ec79397`](https://github.com/cevr/effect-encore/commit/ec793974282f3c1b8b5a3fefa3a1c36cb92b9506) Thanks [@cevr](https://github.com/cevr)! - Unified Actor API with value-dispatch and layer-based lifecycle
  - `Actor.toLayer(actor)` — client-only layer (producer)
  - `Actor.toLayer(actor, handlers)` — consumer + producer layer (registers entity + provides Context)
  - `Actor.toTestLayer(actor, handlers)` — test layer via Entity.makeTestClient, provides Context
  - `.actor(id)` — yields an ActorRef from context: `const ref = yield* Counter.actor("id")`
  - Removed `Actor.Live` — folded into `Actor.toLayer`
  - Removed `Actor.Test` — replaced by `Actor.toTestLayer` (returns Layer, not Effect)
  - `Actor.Test` now accepts raw handlers instead of pre-built layers
  - Added `"actor"` to reserved operation names

- [`06290e3`](https://github.com/cevr/effect-encore/commit/06290e323ecb1d6de7766ae972cf576e352f1585) Thanks [@cevr](https://github.com/cevr)! - Unified call site for entities and workflows.

  **Breaking changes:**
  - `Actor.make` renamed to `Actor.fromEntity`
  - `primaryKey` is now mandatory on all operations
  - `cast` returns `ExecId<Success, Error>` (branded string) instead of `CastReceipt`
  - `peek`, `watch` moved to actor object methods (`actor.peek(execId)`, `actor.watch(execId)`)
  - Standalone `peek`, `watch`, `NoPrimaryKeyError`, `CastReceipt`, `makeCastReceipt` exports removed
  - `Workflow` namespace export removed — import `Activity`, `DurableDeferred`, `DurableClock` from upstream directly

  **New features:**
  - `Actor.fromWorkflow(name, def)` — workflow actors with unified `ref.call`/`ref.cast` interface
  - `ExecId<Success, Error>` — branded execution identifier with phantom types for typed `peek`
  - `actor.peek(execId)` / `actor.watch(execId)` / `actor.interrupt(id)` on actor objects
  - `PeekResult` now includes `Suspended` variant for workflow state
  - Workflow actors support `resume`, `executionId`, `withCompensation`
  - `Actor.toTestLayer` for workflows provides `WorkflowEngine.layerMemory` automatically
