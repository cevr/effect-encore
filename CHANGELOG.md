# effect-encore

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
