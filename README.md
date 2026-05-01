# effect-encore

Declarative actors and durable workflows for `@effect/cluster`.

```bash
bun add effect-encore
```

Peer dependency: `effect >= 4.0.0-beta.46`.
For v3 `@effect/cluster` compat: `import { Actor } from "effect-encore/v3"`.

## Why

`@effect/cluster` requires custom `Schema.Class`, `Rpc.make`, `RpcGroup`, `Entity.make`, handler wiring, and a hand-rolled client service. Workflows add `Activity`, `DurableDeferred`, `DurableClock`, and `Workflow.make` on top. effect-encore compresses both into a declarative DSL — define entities and workflows as plain objects, get typed actors with execute/send/peek/watch/waitFor and a step DSL for durable orchestration.

## Core API

### Entity — reactive message handlers

```ts
import { Actor } from "effect-encore";
import { Schema } from "effect";

const Order = Actor.fromEntity("Order", {
  Place: {
    payload: { item: Schema.String, qty: Schema.Number },
    success: Schema.String,
    persisted: true,
    id: (p) => `${p.item}-${p.qty}`,
  },
  Cancel: {
    payload: { reason: Schema.String },
    persisted: true,
    id: (p) => p.reason,
  },
});
```

Persisted entity operations dedupe by the `primaryKey` returned from `id`; completions are reused until `.rerun(payload)` explicitly clears that execution.

### Workflow — durable multi-step processes

```ts
const ProcessOrder = Actor.fromWorkflow("ProcessOrder", {
  payload: { orderId: Schema.String },
  success: OrderResult,
  error: OrderError,
  id: (p) => p.orderId,
  signals: {
    ManagerApproval: { success: ApprovalDecision },
    Cancel: {},
  },
  captureDefects: true,
  suspendOnFailure: false,
});
```

### Identity & Type Guards

```ts
// .name — the actor's name
Order.name; // "Order"
ProcessOrder.name; // "ProcessOrder"

// .type — the cluster entity type
Order.type; // "Order"
ProcessOrder.type; // "Workflow/ProcessOrder"

// Type guards
Actor.isEntity(Order); // true — narrows to EntityActor
Actor.isWorkflow(ProcessOrder); // true — narrows to WorkflowActor

// .of — typed identity for handler construction
Order.of({ Place: ..., Cancel: ... }); // infers handler types from defs
```

### Unified Call Site

Both entities and workflows share the same `ref.execute` / `ref.send` interface:

```ts
// Entity
const ref = yield * Order.ref("ord-1");
const result = yield * ref.execute(Order.Place({ item: "widget", qty: 3 }));
const execId = yield * ref.send(Order.Place({ item: "widget", qty: 3 }));

// Workflow — nullary actor()
const ref = yield * ProcessOrder.ref();
const result = yield * ref.execute(ProcessOrder.Run({ orderId: "ord-1" }));
const execId = yield * ref.send(ProcessOrder.Run({ orderId: "ord-1" }));
```

### Peek, Watch & WaitFor

Track execution status via opaque `ExecId`:

```ts
const execId = yield * ref.send(Order.Place({ item: "widget", qty: 3 }));

// one-shot status check
const status = yield * Order.peek(execId);
// → Pending | Success | Failure | Interrupted | Defect | Suspended

// polling stream
const stream = Order.watch(execId);

// block until terminal (or custom filter)
const final = yield * Order.waitFor(execId);
const custom =
  yield *
  Order.waitFor(execId, {
    filter: (r) => r._tag === "Success",
    schedule: Schedule.spaced("1 second"),
  });

// compute ExecId without executing
const id = yield * Order.executionId("ord-1", Order.Place({ item: "widget", qty: 3 }));
```

### Handle — Entity

```ts
const OrderLive = Actor.toLayer(Order, {
  Place: ({ operation }) => Effect.succeed(`order: ${operation.item} x${operation.qty}`),
  Cancel: ({ operation }) => cancelOrder(operation.reason),
});

// Use .of for type-safe handlers when yielding services in Effect.gen
const OrderLive = Actor.toLayer(
  Order,
  Effect.gen(function* () {
    const db = yield* Database;
    return Order.of({
      Place: ({ operation }) => db.placeOrder(operation.item, operation.qty),
      Cancel: ({ operation }) => db.cancelOrder(operation.reason),
    });
  }),
);
```

### Handle — Workflow (Step DSL)

Workflow handlers receive `(payload, step)` — a context object that wraps upstream workflow primitives.

**Always provide `success` and `error` schemas.** Activities serialize results through JSON — explicit schemas ensure durable round-tripping and typed decode. The shorthand (`step.run(id, effect)`) uses `Schema.Unknown` internally, which accepts any JSON-safe value but loses type safety on decode. Use it for prototyping; prefer full options for production workflows.

```ts
const ProcessOrderLive = Actor.toLayer(ProcessOrder, (payload, step) =>
  Effect.gen(function* () {
    // step.run — full options (recommended)
    const order = yield* step.run("create-order", {
      do: createOrder(payload),
      success: OrderSchema,
    });

    // step.run — with undo (compensation on workflow failure)
    const charge = yield* step.run("charge-card", {
      do: chargeCard(order),
      success: ChargeResult,
      undo: (charge, _cause) => refundCharge(charge.id),
      retry: { times: 3 },
    });

    // step.sleep — durable sleep
    yield* step.sleep("cooling-period", "5 minutes");

    // signal — await external input (defined on WorkflowDef.signals)
    const token = yield* ProcessOrder.ManagerApproval.token;
    yield* step.run("send-approval-email", {
      do: sendApprovalEmail({ token }),
      success: Schema.Void,
    });
    const decision = yield* ProcessOrder.ManagerApproval.await;

    // step.race — first activity to complete wins
    const winner = yield* step.race("fast-path", [
      { name: "route-a", execute: routeA(order), success: RouteResult },
      { name: "route-b", execute: routeB(order), success: RouteResult },
    ]);

    // step.run — shorthand (infallible, Schema.Unknown — quick & dirty)
    const debug = yield* step.run("log", Effect.succeed("ok"));

    return { orderId: order.id, chargeId: charge.id };
  }),
);
```

### Signal — external resolution

Signals are declared on `WorkflowDef.signals` and become typed properties on the actor:

```ts
// Defined on the workflow (see above)
// signals: { ManagerApproval: { success: ApprovalDecision } }

// Resolve from outside the workflow
const token = ProcessOrder.ManagerApproval.tokenFromExecutionId(executionId);
yield * ProcessOrder.ManagerApproval.succeed({ token, value: decision });
```

### Producer-Only (Client Layer)

```ts
const OrderClient = Actor.toLayer(Order);
```

### Test

```ts
const OrderTest = Actor.toTestLayer(Order, {
  Place: ({ operation }) => Effect.succeed(`order: ${operation.item}`),
  Cancel: () => Effect.void,
});

const ProcessOrderTest = Actor.toTestLayer(ProcessOrder, (payload, step) =>
  Effect.gen(function* () {
    yield* step.run("work", {
      do: Effect.succeed("done"),
      success: Schema.String,
    });
    return { orderId: payload.orderId, status: "ok" };
  }),
);

const test = it.scopedLive.layer(Layer.provide(OrderTest, TestShardingConfig));

test("places an order", () =>
  Effect.gen(function* () {
    const ref = yield* Order.ref("ord-1");
    const result = yield* ref.execute(Order.Place({ item: "widget", qty: 1 }));
    expect(result).toBe("order: widget");
  }));
```

### Lifecycle

```ts
// Workflow: cancel + resume
yield * ProcessOrder.interrupt("ord-1");
yield * ProcessOrder.resume("ord-1");

// Entity: flush all messages + replies
yield * Order.flush("ord-1");

// Entity: redeliver — clear read leases so unprocessed messages re-enter polling
yield * Order.redeliver("ord-1");
```

### Protocol Transform

Transform the underlying `RpcGroup` protocol — middleware, annotations, or any protocol-level operation:

```ts
import { RpcMiddleware } from "effect/unstable/rpc";

class AuthMiddleware extends RpcMiddleware.Service<AuthMiddleware>()("AuthMiddleware", {
  error: Schema.Never,
}) {}

const SecureOrder = Actor.fromEntity("Order", defs).pipe(
  Actor.withProtocol((protocol) => protocol.middleware(AuthMiddleware)),
);
```

### PeekResult Schema

Encode/decode `PeekResult` values for serialization:

```ts
import { PeekResultSchema } from "effect-encore";

const schema = PeekResultSchema(Schema.String, OrderError);
const decode = Schema.decodeUnknownSync(schema);
const encode = Schema.encodeSync(schema);
```

### Delayed Delivery

```ts
const Scheduled = Actor.fromEntity("Scheduled", {
  Process: {
    payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
    id: (p) => p.id,
    deliverAt: (p) => p.deliverAt,
    persisted: true,
  },
});
```

## License

MIT
