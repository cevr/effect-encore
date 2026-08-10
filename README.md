# effect-encore

Declarative actors and durable workflows for effect v4 (`effect/unstable/cluster`).

```bash
bun add effect-encore
```

Peer dependency: `effect >= 4.0.0-beta.106`. This package supports Effect v4 only.

## Why

Effect's cluster API (`effect/unstable/cluster`) requires custom `Schema.Class`, `Rpc.make`, `RpcGroup`, `Entity.make`, handler wiring, and a hand-rolled client service. Workflows add `Activity`, `DurableDeferred`, `DurableClock`, and `Workflow.make` on top. effect-encore compresses both into a declarative DSL — define entities and workflows as plain objects, get typed actors with execute/send/peek/watch/waitFor and a step DSL for durable orchestration.

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

Use `ProcessOrder.prune(executionId)` after retention ends. It removes the run,
activity, and durable clock records for that workflow execution.

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

### Entity State

Long-lived entity handlers can expose live, in-memory state without a
side-channel registry in the host app. Build a `State<A>` value over the backing
cell, register it from the entity scope, and mutate through it; clients read or
watch it through the actor, keyed by the same `entityId` used for operations.

`State<A>` is a typed view over the cell plus a subscribable change stream:
`State.get` / `State.set` / `State.update` / `State.updateAndGet` / `State.modify`
serialize their read/apply/write/publish through a per-`State` lock, and
`State.changes` is a replay-1 stream of every committed write. The state value is
opaque. Use these functions instead of its internal closures or synchronization.

```ts
const CounterLive = Actor.toLayer(
  Counter,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(0);
    const state = yield* Actor.State.make(SubscriptionRef.get(ref), (value) =>
      SubscriptionRef.set(ref, value),
    );

    yield* Actor.registerState(state);

    return Counter.of({
      Increment: ({ operation }) => Actor.State.updateAndGet(state, (n) => n + operation.amount),
    });
  }),
);

const current = yield * Counter.getState<number>("counter-1");

const changes = Counter.watchState<number>("counter-1");
const activeIds = yield * Counter.listStateEntityIds();
```

Cold `getState` and `watchState` calls materialize the entity before reading the
registered state; apps do not need to define their own no-op operation for that
case. The registration finalizer removes the state handle when the entity scope
closes. `Actor.toLayer` and `Actor.toTestLayer` provide the state registry
locally; remote producer-only runtimes cannot observe another process's live
heap state.

### SQL Message Storage

Entity `.rerun(payload)` needs surgical deletion of one persisted request and
its replies. SQL-backed runtimes can use Encore's SQL layer instead of writing
their own adapter:

```ts
import { fromSqlClient } from "effect-encore";
import { SqliteClient } from "@effect/sql-sqlite-bun";

const MessageStorageLive = fromSqlClient().pipe(
  Layer.provide(SqliteClient.layer({ filename: "app.db" })),
);
```

`fromSqlClient()` provides upstream `MessageStorage.MessageStorage` and Encore's
internal rerun deletion operations. It uses Effect Cluster's default
`cluster_messages` / `cluster_replies` tables and default sharding config. Use
`fromSqlClientWithShardingConfig()` when the host provides a custom
`ShardingConfig`.

### Canonical JSON identity

Use one stable JSON representation for durable workflow identities and
idempotency keys. Object keys use recursive UTF-16 order. Array order stays
unchanged.

```ts
import { canonicalJsonSha256, canonicalJsonString } from "effect-encore";

const encoded = canonicalJsonString({ z: 1, a: 2 });
// {"a":2,"z":1}

const digest = yield * canonicalJsonSha256({ z: 1, a: 2 });
// lowercase 64-character SHA-256 digest
```

### Handle — Workflow (Step DSL)

Workflow handlers receive `(payload, step)`. The Step interface gives one convenient
surface over Effect workflow primitives. Encore owns the assembly and stable naming.

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

Compensations run in reverse registration order after a workflow failure. Each
compensation is a durable Activity. A completed compensation does not run again
after replay or restart.

A failed compensation suspends the workflow. The error log includes the
`executionId`, `stepId`, and `attempt`. The `undo` Effect can fail with the
Workflow error type. Encore uses the Workflow error schema for the durable
compensation Activity. An operator can read the pending compensation. The
operator can then retry it or stop its retries:

```ts
const pending = yield * ProcessOrder.compensation.pending(executionId);
yield * ProcessOrder.compensation.decidePending(executionId, "Retry");
```

`retry` starts the next Activity attempt. `stop` skips the failed compensation
and continues with older compensations. The workflow keeps its original failure
after compensation ends. An interrupt-only cause does not start compensation.
An interrupted compensation does not wait for an operator decision. `retry`
and `stop` are convenience methods over `decide`. Every decision checks the
pending Step ID and attempt. A different pending attempt or durable decision
fails with `CompensationDecisionConflictError`. A run without a pending attempt
fails with `CompensationNotPendingError`.

`decide` waits until the durable winning decision is visible. Apply
`Effect.timeout` at the application boundary when an operator request needs a
time limit. `pending` reads the durable compensation history. Its work grows
with the number of compensation attempts for that workflow execution.

Step IDs share the durable Activity namespace. Do not use a Step ID that is an
encoded Encore internal tuple such as `["Compensate","charge-card"]`.

The default `waitFor` filter waits for a terminal result. It does not return a
suspended result. Use an explicit filter when an operator must detect the wait:

```ts
const suspended =
  yield *
  ProcessOrder.waitFor(payload, {
    filter: (result) => result._tag === "Suspended",
  });
```

Keep `captureDefects` enabled for operator recovery from compensation defects.

### Signal — external resolution

Signals are declared on `WorkflowDef.signals` and become typed properties on the actor:

```ts
// Defined on the workflow (see above)
// signals: { ManagerApproval: { success: ApprovalDecision } }

// Resolve from outside the workflow
const token = ProcessOrder.ManagerApproval.tokenFromExecutionId(executionId);
yield * ProcessOrder.ManagerApproval.succeed({ token, value: decision });
```

### Sender-Only (Client Layer)

`.send()` (fire-and-forget dispatch) goes through the deep `Client` transport seam — one `Context.Service` Tag that owns the wire-envelope builder plus the mailbox/resolver/snowflake strategy internally. Consumer hosts that already have full `Sharding.Sharding` get the wiring for free from `Actor.toLayer`.

Sender-only / ops-only hosts that must NOT register entity managers wire ONE `Client.layer.*` adapter. `Client.layer.fromConfig` dispatches through `MessageStorage` directly — requires only `MessageStorage` + `ShardingConfig`, no `Sharding` runtime, no `notifyLocal` deadlock:

```ts
import { Layer } from "effect";
import { MessageStorage, ShardingConfig } from "effect/unstable/cluster";
import { ClientLayer } from "effect-encore";

const SenderSupport = ClientLayer.fromConfig.pipe(
  Layer.provide(MessageStorage.layerMemory), // or your durable storage
  Layer.provide(ShardingConfig.layer()),
);

// Or, for tests / single-process setups — bundle includes in-memory
// storage and default sharding config:
const SenderTest = ClientLayer.memory;

// (Consumer hosts that already host the cluster runtime use
// `ClientLayer.fromSharding`, which dispatches via `sharding.sendOutgoing`
// and bundles its own `Snowflake.Generator`.)

// Sends are durably enqueued; the consumer's storage poll loop picks them up
// on the next entityMessagePollInterval tick.
yield * Order.Place.send({ item: "widget", qty: 3 });

// Await the applied result from the same sender-only host — `.sendAndAwait`
// fires a durable `send` then polls the persisted reply until terminal.
// No local `Sharding` required (unlike `.execute`). The required `timeout`
// guards against unbounded sender-side polling; a persisted Failure surfaces
// in the error channel, and exceeding the timeout fails with
// `SendAndAwaitTimeout`.
const placed =
  yield * Order.Place.sendAndAwait({ item: "widget", qty: 3 }, { timeout: "30 seconds" });
```

Storage-only dispatch rejects non-persisted requests. Only persisted requests can
cross this boundary. Mailbox and address resolution are internal Client strategies.

#### Client storage transactions

`Client.withTransaction(effect)` lets a host compose Client control operations with
host storage work under the selected Effect `MessageStorage` transaction boundary.
Rollback and nesting behavior come from that storage adapter. SQL storage uses the
shared `SqlClient` transaction and nested savepoints. Memory storage provides only
the transaction behavior defined by Effect's memory adapter.

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
