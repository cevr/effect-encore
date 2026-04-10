# effect-encore

Erlang gen_server semantics over `@effect/cluster`.

## Why

`@effect/cluster` is powerful but low-level. Defining a single entity requires custom `Schema.Class` implementations, `Rpc.make`, `RpcGroup`, `Entity.make`, handler wiring via `entity.toLayer`, and a hand-rolled client service. A typical entity runs 100+ lines before any business logic.

effect-encore compresses this into a declarative DSL:

```ts
import { Actor } from "effect-encore";
import { Schema } from "effect";

const Counter = Actor.make("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
  },
});
```

Every operation supports `call` (block for reply), `cast` (fire-and-forget with receipt), and `peek`/`watch` (check or stream results). Delivery mode is the caller's choice, not the definition's — just like Erlang's `gen_server:call` vs `gen_server:cast`.

## Core API

### Define

```ts
// Multi-operation actor
const OrderValidation = Actor.make("OrderValidation", {
  Validate: {
    payload: { orderId: Schema.String },
    success: Schema.String,
    error: ValidationError,
    persisted: true,
    primaryKey: (p) => p.orderId,
  },
  Cancel: {
    payload: { orderId: Schema.String },
    persisted: true,
    primaryKey: (p) => p.orderId,
  },
});

// Single-operation actor (no operation namespace on ref)
const VectorUpdate = Actor.single("VectorUpdate", {
  payload: { locationId: Schema.String },
  persisted: true,
  primaryKey: (p) => p.locationId,
});

// Delayed delivery
const Scheduled = Actor.make("Scheduled", {
  Process: {
    payload: { id: Schema.String, deliverAt: Schema.DateTimeUtc },
    primaryKey: (p) => p.id,
    deliverAt: (p) => p.deliverAt,
    persisted: true,
  },
});

// Pre-built Schema.Class (escape hatch for custom symbol implementations)
const WithCustomPayload = Actor.make("Custom", {
  Run: { payload: MySchemaClass, success: Schema.Void },
});
```

### Handle

```ts
// Plain handlers
const handlers = Handlers.handlers(OrderValidation, {
  Validate: (req) => validateOrder(req.payload.orderId),
  Cancel: (req) => cancelOrder(req.payload.orderId),
});

// From Effect context
const handlers = Handlers.handlers(
  OrderValidation,
  Effect.gen(function* () {
    const db = yield* Database;
    return {
      Validate: (req) => db.validate(req.payload.orderId),
      Cancel: (req) => db.cancel(req.payload.orderId),
    };
  }),
);
```

### Call & Cast

```ts
const makeRef = yield * Actor.client(OrderValidation);
const ref = makeRef("order-123");

// call — block for reply
const result = yield * ref.Validate.call({ orderId: "abc" });

// cast — fire-and-forget, get receipt
const receipt = yield * ref.Validate.cast({ orderId: "abc" });

// peek — one-shot status check via receipt
const status = yield * Peek.peek(OrderValidation, receipt);

// watch — polling stream of status changes
const stream = Peek.watch(OrderValidation, receipt);
```

### Test

```ts
const makeRef = yield * Testing.testClient(Counter, handlerLayer);
const ref = yield * makeRef("counter-1");
const result = yield * ref.Increment.call({ amount: 5 });
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
