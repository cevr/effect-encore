# effect-encore

Declarative actors and durable workflows for `@effect/cluster`.

## Commands

```bash
bun run gate          # all checks concurrent: typecheck, typecheck:v3, lint, fmt, build, test
bun run typecheck     # tsgo --noEmit (v4)
bun run typecheck:v3  # tsgo --noEmit -p v3/tsconfig.json
bun run lint          # oxlint + effect-language-service (src strict, test relaxed)
bun run build         # tsdown v4 + v3 concurrent
bun test              # bun test
```

## Architecture

- `src/actor.ts` — entire v4 API: `Actor.fromEntity`, `Actor.fromWorkflow`, `toLayer`, `toTestLayer`, types, runtime
- `v3/src/actor.ts` — v3 mirror using `@effect/cluster`, `@effect/rpc`, `@effect/workflow` imports
- `src/receipt.ts` — `ExecId<S,E>` branded type, `PeekResult` ADT
- Both v3 and v4 import from the same `effect@4.x` — v3 distinction is only the cluster/rpc/workflow packages

## Payload Classification

Three payload forms, two operation shapes:

| Definition                                          | `isOpaquePayload`      | Operation shape       | Handler access       |
| --------------------------------------------------- | ---------------------- | --------------------- | -------------------- |
| `payload: { field: Schema.String }` (struct fields) | N/A                    | `{ _tag, ...fields }` | `operation.field`    |
| `payload: MySchemaClass` (Schema.Class)             | `false` — has `fields` | `{ _tag, ...fields }` | `operation.field`    |
| `payload: Schema.String` (scalar)                   | `true` — no `fields`   | `{ _tag, _payload }`  | `operation._payload` |

Discriminator: `Schema.isSchema(payload) && !("fields" in payload)`. Schema.Class has `fields`, scalars don't.

## ExecId

- Format: `entityId\0tag\0primaryKey` (null byte separator — safe with colons in any segment)
- `entity.executionId(entityId, op)` — `Effect<ExecId<S,E>>` (pure internally)
- `workflow.executionId(payload)` — `Effect<ExecId<S,E>>` (needs WorkflowEngine)
- Workflow ExecIds come from upstream `idempotencyKey(payload)`

## Effect LSP Linting

- Config lives in `.effect-lsp.json` / `.effect-lsp.test.json` — NOT in tsconfig plugins
- CLI needs `--lspconfig "$(cat .effect-lsp.json)"` — without it, reports "Checked 0 files"
- `tsconfig.src.json` / `tsconfig.test.json` scope which files get checked
- `globalDate` is error in src, off in test (test setup uses `Date.now()`)

## Gotchas

- `Effect.die(new Error(...))` is idiomatic for defects — no LSP rule catches it (by design)
- Entity `interrupt` is stubbed — `Sharding.passivate` is not a public API
- Entity peek returns **encoded** values from storage; `decodeValue` uses `Schema.decodeUnknownEffect` with fallback
- Workflow peek uses real `Exit.Exit` (not encoded) — walk `Cause` tree via `Cause.findErrorOption`/`findDefect`/`findInterrupt`
- v3 `Cause` API differs: use `failureOption`/`dieOption`/`isInterruptedOnly` instead of v4's `findErrorOption`/`findDefect`/`findInterrupt`
- `withCompensation` is NOT on the actor — it's a workflow primitive. Import from `Workflow` directly.
