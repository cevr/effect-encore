---
"effect-encore": minor
---

### Bug fixes

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
