---
name: effect-encore
description: Erlang gen_server semantics over @effect/cluster. Use when building actor/entity definitions with effect-encore, wiring handlers, writing call/cast/peek/watch patterns, testing actors, or migrating from raw @effect/cluster Entity/Rpc/RpcGroup code.
---

# effect-encore

Thin protocol layer over `@effect/cluster` providing Erlang gen_server semantics.

## Navigation

```
What are you working on?
├─ Defining an actor              → §Define
├─ Wiring handlers                → §Handle
├─ Calling / casting              → §Client
├─ Checking results (peek/watch)  → §Peek
├─ Testing                        → §Test
├─ Delayed delivery (deliverAt)   → §DeliverAt
├─ Workflows                      → §Workflow
├─ Observability                  → §Observability
├─ v3 compatibility               → §v3
└─ Migrating from raw cluster     → §Migration
```

## Core Concepts

- **Delivery mode is the caller's choice.** Every operation supports `call`, `cast`, and `watch`. The definition doesn't decide — the caller does.
- **Identity is separate from the message.** Get a ref to an entity, then send messages through it.
- **Compiles to @effect/cluster.** Not a new runtime. `Actor.make` produces an `Entity` under the hood.

## Define

### Multi-operation actor

```ts
const Counter = Actor.make("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
  },
  GetCount: {
    success: Schema.Number,
  },
});
```

### Single-operation actor

No operation namespace on the ref — `ref.call()` instead of `ref.Op.call()`.

```ts
const VectorUpdate = Actor.single("VectorUpdate", {
  payload: { locationId: Schema.String },
  persisted: true,
  primaryKey: (p) => p.locationId,
});
```

### OperationConfig fields

| Field        | Type                                 | Default         | Description                             |
| ------------ | ------------------------------------ | --------------- | --------------------------------------- |
| `payload`    | `Schema.Top \| Schema.Struct.Fields` | `Schema.Void`   | Inline fields or pre-built Schema.Class |
| `success`    | `Schema.Top`                         | `Schema.Void`   | Success response schema                 |
| `error`      | `Schema.Top`                         | `Schema.Never`  | Error schema                            |
| `persisted`  | `boolean`                            | cluster default | Persist to MessageStorage               |
| `primaryKey` | `(payload) => string`                | none            | Deduplication key extractor             |
| `deliverAt`  | `(payload) => DateTime`              | none            | Delayed delivery extractor              |

### Pre-built Schema.Class payload

When you need full control (custom symbols, complex types), pass a `Schema.Class` directly. The `primaryKey`/`deliverAt` options are ignored — symbols must be on the class.

```ts
class CustomPayload extends Schema.Class<CustomPayload>("CustomPayload")({
  id: Schema.String,
  when: Schema.DateTimeUtc,
}) {
  [PrimaryKey.symbol]() {
    return this.id;
  }
  [DeliverAt.symbol]() {
    return this.when;
  }
}

const MyActor = Actor.make("MyActor", {
  Run: { payload: CustomPayload, success: Schema.Void, persisted: true },
});
```

### Escape hatch: raw Rpcs

```ts
const MyActor = Actor.from("MyActor", [
  Rpc.make("Op1", { ... }),
  Rpc.make("Op2", { ... }),
]);
```

## Handle

```ts
// Plain object
const layer = Handlers.handlers(Counter, {
  Increment: (req) => Effect.succeed(req.payload.amount + 1),
  GetCount: () => Effect.succeed(42),
});

// From Effect context (yield services)
const layer = Handlers.handlers(
  Counter,
  Effect.gen(function* () {
    const db = yield* Database;
    return {
      Increment: (req) => db.increment(req.payload.amount),
      GetCount: () => db.getCount(),
    };
  }),
);
```

### HandlerOptions

```ts
Handlers.handlers(actor, build, {
  spanAttributes: { team: "platform" },
  maxIdleTime: 60_000,
  concurrency: 10,
  mailboxCapacity: 100,
});
```

## Client

```ts
// Get a ref factory (requires Sharding in context)
const makeRef = yield * Actor.client(Counter);
const ref = makeRef("counter-1");

// call — synchronous, block for reply
const result = yield * ref.Increment.call({ amount: 5 });

// cast — fire-and-forget, returns CastReceipt
const receipt = yield * ref.Increment.cast({ amount: 5 });
```

### CastReceipt

Carries the full compound key needed for peek/watch:

```ts
type CastReceipt = {
  _tag: "CastReceipt";
  actorType: string;
  entityId: string;
  operation: string;
  primaryKey: string;
};
```

## Peek

One-shot status check via CastReceipt. Requires `MessageStorage | Sharding` in context.

```ts
const status = yield * Peek.peek(Counter, receipt);
// Returns: Pending | Success | Failure | Interrupted | Defect
```

### Watch

Polling stream that emits on status changes and completes on terminal result.

```ts
const stream = Peek.watch(Counter, receipt, { interval: Duration.millis(200) });
```

### Gotchas

- `peek` requires a real `primaryKey` on the operation. Cast without `primaryKey` works (fire-and-forget) but the receipt is NOT peekable.
- `peek` uses `actor.name` (not `receipt.actorType`) for the EntityAddress lookup.

## DeliverAt

Add delayed delivery to any operation:

```ts
const Scheduled = Actor.make("Scheduled", {
  Process: {
    payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
    primaryKey: (p) => p.id,
    deliverAt: (p) => p.deliverAt,
    persisted: true,
  },
});
```

The `deliverAt` field must be in the payload schema — the extractor reads it from the payload instance. The library generates a `Schema.Class` with `DeliverAt.symbol` attached.

`deliverAt` without `primaryKey` is valid (delayed but not deduped).

## Test

```ts
// Handler isolation — no cluster infrastructure needed
const makeRef = yield * Testing.testClient(Counter, handlerLayer);
const ref = yield * makeRef("counter-1");
const result = yield * ref.Increment.call({ amount: 5 });

// Full cluster integration — use TestRunner.layer
const status = yield * Peek.peek(Counter, receipt);
```

`testClient` preserves handler layer error and requirement types — services in handler layers flow through correctly.

For integration tests with `TestRunner.layer`, use `TestClock.adjust(1)` before sending messages to trigger shard assignment.

## Workflow

Re-exports from `effect/unstable/workflow`:

```ts
import { Workflow } from "effect-encore";

const { DurableDeferred, Activity } = Workflow;
```

`WorkflowRef` provides `call`, `cast`, `interrupt`, `resume`.
`workflowPoll` returns `Pending | Success | Failure | Suspended`.

## Observability

Cluster already creates spans `EntityType(entityId).RpcTag` automatically. No custom middleware needed.

Pass extra attributes via `HandlerOptions.spanAttributes`. Access current entity address via `Entity.CurrentAddress` (re-exported from `Observability.CurrentAddress`).

## v3

Import from `effect-encore/v3`. Same API, different import paths:

| v4                          | v3                                |
| --------------------------- | --------------------------------- |
| `effect/unstable/cluster`   | `@effect/cluster`                 |
| `effect/unstable/rpc`       | `@effect/rpc`                     |
| `effect/unstable/workflow`  | `@effect/workflow`                |
| `Schema.Top`                | `Schema.Schema.Any`               |
| `Duration.Input`            | `Duration.DurationInput`          |
| `Stream.fromEffectSchedule` | `Stream.repeatEffectWithSchedule` |

v3 `CauseEncoded` is a recursive tree (not flat array like v4) — `peek.ts` has a tree walker for this.

## Migration

### From raw @effect/cluster

| Before (raw cluster)                                                | After (effect-encore)                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| Custom `Schema.Class` with `PrimaryKey.symbol` + `DeliverAt.symbol` | `primaryKey` + `deliverAt` in OperationConfig          |
| `Rpc.make` + `RpcGroup.make` + `Entity.fromRpcGroup`                | `Actor.make(name, operations)`                         |
| `entity.toLayer(Effect.gen(...))` with `entity.of({...})`           | `Handlers.handlers(actor, {...})`                      |
| `Context.Tag` + `makeClientLayer` per entity                        | `Actor.client(def)` — no extra tags                    |
| `client(entityId).Op(payload, { discard: true })`                   | `ref.Op.cast(payload)` — returns `CastReceipt`         |
| Manual `getMessageStatus(primaryKey)` with empty address fields     | `Peek.peek(actor, receipt)` with correct compound key  |
| Custom `RpcMiddleware` for spans                                    | Not needed — cluster creates spans automatically       |
| `Entity.makeTestClient` + manual RpcClient mapping                  | `Testing.testClient(actor, layer)` — returns typed Ref |
