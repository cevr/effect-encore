# effect-encore

Erlang gen_server semantics over `@effect/cluster`.

## Why

`@effect/cluster` is powerful but low-level. Defining a single entity requires custom `Schema.Class` implementations, `Rpc.make`, `RpcGroup`, `Entity.make`, handler wiring via `entity.toLayer`, and a hand-rolled client service. A typical entity runs 100+ lines before any business logic.

effect-encore compresses this into a declarative DSL with a unified call site for both entities and workflows.

## Core API

### Entity — reactive message handlers

```ts
import { Actor } from "effect-encore";
import { Schema } from "effect";

const Order = Actor.fromEntity("Order", {
  Place: {
    payload: { item: Schema.String, qty: Schema.Number },
    success: Schema.String,
    primaryKey: (p) => `${p.item}-${p.qty}`,
  },
  Cancel: {
    payload: { reason: Schema.String },
    primaryKey: (p) => p.reason,
  },
});
```

### Workflow — durable multi-step processes

```ts
const ProcessOrder = Actor.fromWorkflow("ProcessOrder", {
  payload: { orderId: Schema.String },
  success: OrderResult,
  error: OrderError,
  idempotencyKey: (p) => p.orderId,
});
```

### Unified Call Site

Both entities and workflows share the same `ref.call` / `ref.cast` interface:

```ts
// Entity
const ref = yield * Order.actor("ord-1");
const result = yield * ref.call(Order.Place({ item: "widget", qty: 3 }));
const execId = yield * ref.cast(Order.Place({ item: "widget", qty: 3 }));

// Workflow — identical call site
const ref = yield * ProcessOrder.actor("ord-1");
const result = yield * ref.call(ProcessOrder.Run({ orderId: "ord-1" }));
const execId = yield * ref.cast(ProcessOrder.Run({ orderId: "ord-1" }));
```

### Peek & Watch

Track execution status via opaque `ExecId`:

```ts
// cast returns ExecId<Success, Error> — branded string with phantom types
const execId = yield * ref.cast(Order.Place({ item: "widget", qty: 3 }));

// peek — one-shot status check (on the actor object, not standalone)
const status = yield * Order.peek(execId);
// → Pending | Success | Failure | Interrupted | Defect | Suspended

// watch — polling stream
const stream = Order.watch(execId);
```

### Handle

```ts
// Entity handlers — per operation
const OrderLive = Actor.toLayer(Order, {
  Place: ({ operation }) => Effect.succeed(`order: ${operation.item} x${operation.qty}`),
  Cancel: ({ operation }) => cancelOrder(operation.reason),
});

// Workflow handler — single body with Activities
const ProcessOrderLive = Actor.toLayer(ProcessOrder, (payload) =>
  Effect.gen(function* () {
    const validated = yield* Activity.make({
      name: "Validate",
      success: Schema.String,
      execute: validateOrder(payload.orderId),
    });
    return { orderId: payload.orderId, status: "ok" };
  }),
);
```

### Producer-Only (Client Layer)

For services that send messages to actors they don't handle:

```ts
const OrderClient = Actor.toLayer(Order);
```

### Test

```ts
// Entity test
const OrderTest = Actor.toTestLayer(Order, {
  Place: ({ operation }) => Effect.succeed(`order: ${operation.item}`),
  Cancel: () => Effect.void,
});

// Workflow test — WorkflowEngine.layerMemory provided automatically
const ProcessOrderTest = Actor.toTestLayer(ProcessOrder, (payload) =>
  Effect.succeed({ orderId: payload.orderId, status: "ok" }),
);

const test = it.scopedLive.layer(Layer.provide(OrderTest, TestShardingConfig));

test("places an order", () =>
  Effect.gen(function* () {
    const ref = yield* Order.actor("ord-1");
    const result = yield* ref.call(Order.Place({ item: "widget", qty: 1 }));
    expect(result).toBe("order: widget");
  }));
```

### Lifecycle

```ts
// Entity: passivate
Order.interrupt("ord-1");

// Workflow: cancel + resume
ProcessOrder.interrupt("ord-1");
ProcessOrder.resume("ord-1");

// Workflow-only: execution ID, compensation
const execId = yield * ProcessOrder.executionId({ orderId: "ord-1" });
const compensated = ProcessOrder.withCompensation(activity, (value, cause) => rollback(value));
```

### Delayed Delivery

```ts
const Scheduled = Actor.fromEntity("Scheduled", {
  Process: {
    payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
    primaryKey: (p) => p.id,
    deliverAt: (p) => p.deliverAt,
    persisted: true,
  },
});
```

### Handler Primitives

Import workflow primitives from upstream directly:

```ts
// v4
import { Activity, DurableDeferred, DurableClock } from "effect/unstable/workflow";
// v3
import { Activity, DurableDeferred, DurableClock } from "@effect/workflow";
```

## v3 Support

Import from `effect-encore/v3` for `@effect/cluster` v3 compatibility. Same API, different import paths under the hood.

## Install

```bash
bun add effect-encore
```

Peer dependencies: `effect`, `@effect/cluster` (v3) or `effect` with `effect/unstable/cluster` (v4).

## License

MIT
