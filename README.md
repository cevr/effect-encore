# effect-encore

Erlang gen_server semantics over `@effect/cluster`.

```bash
bun add effect-encore
```

Peer dependency: `effect >= 4.0.0-beta.46`.
For v3 `@effect/cluster` compat: `import { Actor } from "effect-encore/v3"`.

## Why

`@effect/cluster` entities require custom `Schema.Class`, `Rpc.make`, `RpcGroup`, `Entity.make`, handler wiring, and a hand-rolled client service. effect-encore compresses this into a declarative DSL.

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
  captureDefects: true,
  suspendOnFailure: false,
});
```

### Unified Call Site

Both entities and workflows share the same `ref.execute` / `ref.send` interface:

```ts
// Entity
const ref = yield * Order.actor("ord-1");
const result = yield * ref.execute(Order.Place({ item: "widget", qty: 3 }));
const execId = yield * ref.send(Order.Place({ item: "widget", qty: 3 }));

// Workflow — nullary actor()
const ref = yield * ProcessOrder.actor();
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
```

### Handle — Workflow (Step DSL)

Workflow handlers receive `(payload, step)` — a context object that wraps upstream workflow primitives:

```ts
const ProcessOrderLive = Actor.toLayer(ProcessOrder, (payload, step) =>
  Effect.gen(function* () {
    // step.run — shorthand (infallible only)
    const order = yield* step.run("create-order", createOrder(payload));

    // step.run — shorthand with undo (value, cause)
    const charge = yield* step.run("charge-card", chargeCard(order), (charge, _cause) =>
      refundCharge(charge.id),
    );

    // step.run — full options (typed errors, retry)
    const receipt = yield* step.run("send-receipt", {
      do: sendReceipt(order, charge),
      success: ReceiptSchema,
      error: ReceiptError,
      retry: { times: 3 },
    });

    // step.sleep — durable sleep
    yield* step.sleep("cooling-period", "5 minutes");

    // step.signal — await external input
    const approval = step.signal({ name: "manager-approval", success: ApprovalDecision });
    const token = yield* approval.token;
    yield* step.run("send-approval-email", sendApprovalEmail({ token }));
    const decision = yield* approval.await;

    // step.race — first activity to complete wins
    const winner = yield* step.race("fast-path", [activity1, activity2]);

    // step.executionId, step.attempt
    const key = `${step.executionId}/my-key`;
    const attempt = yield* step.attempt;

    return { orderId: order.id, chargeId: charge.id };
  }),
);
```

### Signal — external resolution

```ts
// Define once on the actor
const approval = ProcessOrder.signal({ name: "manager-approval", success: ApprovalDecision });

// Resolve from outside the workflow
export const approve = (token: WorkflowSignalToken, value: typeof ApprovalDecision.Type) =>
  approval.succeed({ token, value });

// Get a token from a known execution
const token = approval.tokenFromExecutionId(executionId);
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
    yield* step.run("work", Effect.succeed("done"));
    return { orderId: payload.orderId, status: "ok" };
  }),
);

const test = it.scopedLive.layer(Layer.provide(OrderTest, TestShardingConfig));

test("places an order", () =>
  Effect.gen(function* () {
    const ref = yield* Order.actor("ord-1");
    const result = yield* ref.execute(Order.Place({ item: "widget", qty: 1 }));
    expect(result).toBe("order: widget");
  }));
```

### Lifecycle

```ts
// Workflow: cancel + resume
yield * ProcessOrder.interrupt("ord-1");
yield * ProcessOrder.resume("ord-1");
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
    primaryKey: (p) => p.id,
    deliverAt: (p) => p.deliverAt,
    persisted: true,
  },
});
```

## License

MIT
