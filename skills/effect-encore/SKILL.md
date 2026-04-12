---
name: effect-encore
description: Declarative actors and durable workflows for @effect/cluster. Use when building actor/entity definitions with effect-encore, wiring handlers, writing execute/send/peek/watch patterns, testing actors, defining workflows with the step DSL, or migrating from raw @effect/cluster Entity/Rpc/RpcGroup code.
---

# effect-encore

Declarative actors and durable workflows for `@effect/cluster`. Unified call site for entities and workflows with a step DSL for durable orchestration.

## Navigation

```
What are you working on?
├─ Defining an entity              → §Entity
├─ Defining a workflow             → §Workflow
├─ Wiring handlers / layers        → §Handle
├─ Calling / sending               → §Client
├─ Tracking execution (peek/watch) → §Peek
├─ Waiting for completion          → §WaitFor
├─ Testing                         → §Test
├─ Lifecycle (interrupt/resume)    → §Lifecycle
├─ Delayed delivery (deliverAt)    → §DeliverAt
├─ Observability                   → §Observability
├─ v3 compatibility                → §v3
└─ Migrating from raw cluster      → §Migration
```

## Core Concepts

- **Unified call site.** Entities and workflows share `ref.execute(op)` / `ref.send(op)`. Callers don't care which is which.
- **Delivery mode is the caller's choice.** Every operation supports `execute` and `send`. The definition doesn't decide — the caller does.
- **Value dispatch.** Construct an operation value, pass it to `ref.execute(op)` or `ref.send(op)`.
- **One layer, two roles.** `Actor.toLayer(actor, handlers)` = consumer + producer. `Actor.toLayer(actor)` = producer only.
- **Step DSL.** Workflow handlers receive `(payload, step)` — no raw `Activity`/`DurableDeferred`/`DurableClock` imports needed.
- **Compiles to @effect/cluster.** Not a new runtime. `Actor.fromEntity` produces an `Entity`, `Actor.fromWorkflow` wraps `Workflow.make`.

## Entity

### Multi-operation entity actor

```ts
const Counter = Actor.fromEntity("Counter", {
  Increment: {
    payload: { amount: Schema.Number },
    success: Schema.Number,
    primaryKey: (p) => String(p.amount),
  },
  GetCount: {
    success: Schema.Number,
    primaryKey: () => "singleton",
  },
});

// Constructors are on the object directly
Counter.Increment({ amount: 5 }); // → OperationValue
Counter.GetCount(); // zero-input, still callable
```

### OperationDef fields

| Field        | Type                                 | Required | Description                             |
| ------------ | ------------------------------------ | -------- | --------------------------------------- |
| `payload`    | `Schema.Top \| Schema.Struct.Fields` | no       | Inline fields or pre-built Schema.Class |
| `success`    | `Schema.Top`                         | no       | Success response schema (default: Void) |
| `error`      | `Schema.Top`                         | no       | Error schema (default: Never)           |
| `persisted`  | `boolean`                            | no       | Persist to MessageStorage               |
| `primaryKey` | `(payload) => string`                | **yes**  | Deduplication / exec ID key             |
| `deliverAt`  | `(payload) => DateTime`              | no       | Delayed delivery extractor              |

### ActorObject properties

| Property                    | Type        | Description                               |
| --------------------------- | ----------- | ----------------------------------------- |
| `Counter.Increment(...)`    | Constructor | Returns `OperationValue`                  |
| `Counter._meta.name`        | `"Counter"` | Actor name (literal type)                 |
| `Counter._meta.entity`      | `Entity`    | Underlying cluster Entity                 |
| `Counter._meta.definitions` | Record      | Raw operation definitions                 |
| `Counter.Context`           | Context tag | DI tag for client factory                 |
| `Counter.actor(id)`         | Method      | `yield* Counter.actor("id")` → `ActorRef` |
| `Counter.peek(execId)`      | Method      | One-shot status check                     |
| `Counter.watch(execId)`     | Method      | Polling stream of status changes          |
| `Counter.waitFor(execId)`   | Method      | Poll until terminal (or custom filter)    |
| `Counter.interrupt(id)`     | Method      | Passivate entity                          |
| `Counter.$is(tag)`          | Type guard  | `Counter.$is("Increment")(value)`         |

### Reserved operation names

`_tag`, `_meta`, `$is`, `Context`, `actor`, `peek`, `watch`, `interrupt`, `executionId` — compile-time type guard + runtime check.

### Pre-built Schema.Class payload

Escape hatch for custom symbol implementations. The `primaryKey`/`deliverAt` options in OperationDef are ignored when using a Schema.Class — symbols must be on the class.

```ts
class CustomPayload extends Schema.Class<CustomPayload>("CustomPayload")({
  id: Schema.String,
}) {
  [PrimaryKey.symbol]() {
    return this.id;
  }
}

const MyActor = Actor.fromEntity("MyActor", {
  Run: { payload: CustomPayload, success: Schema.Void, persisted: true, primaryKey: (p) => p.id },
});
```

## Workflow

### Workflow actor (single-op "Run")

```ts
const ProcessOrder = Actor.fromWorkflow("ProcessOrder", {
  payload: { orderId: Schema.String },
  success: OrderResult,
  error: OrderError,
  idempotencyKey: (p) => p.orderId,
});

// Single constructor — always "Run"
ProcessOrder.Run({ orderId: "ord-1" }); // → OperationValue
```

### WorkflowDef fields

| Field                    | Type                   | Required | Description                                 |
| ------------------------ | ---------------------- | -------- | ------------------------------------------- |
| `payload`                | `Schema.Struct.Fields` | **yes**  | Workflow input fields                       |
| `success`                | `Schema.Top`           | no       | Success schema (default: Void)              |
| `error`                  | `Schema.Top`           | no       | Error schema (default: Never)               |
| `idempotencyKey`         | `(payload) => string`  | **yes**  | Deterministic execution ID                  |
| `signals`                | `SignalDefs`           | no       | Declarative signal definitions (see below)  |
| `captureDefects`         | `boolean`              | no       | Capture defects as workflow failures        |
| `suspendOnFailure`       | `boolean`              | no       | Suspend workflow on failure instead of fail |
| `suspendedRetrySchedule` | `Schedule`             | no       | Retry schedule for suspended workflows      |

### WorkflowActorObject properties

All entity properties plus:

| Property                            | Description                                     |
| ----------------------------------- | ----------------------------------------------- |
| `ProcessOrder.resume(execId)`       | Resume suspended workflow                       |
| `ProcessOrder.executionId(payload)` | Compute deterministic execution ID              |
| `ProcessOrder.Approval`             | Signal property (from `signals` on WorkflowDef) |

### Declarative signals

Signals are defined on `WorkflowDef.signals` and become typed properties on the actor — single source of truth:

```ts
const ProcessOrder = Actor.fromWorkflow("ProcessOrder", {
  payload: { orderId: Schema.String },
  success: OrderResult,
  idempotencyKey: (p) => p.orderId,
  signals: {
    Approval: { success: Schema.String, error: ApprovalError },
    Cancel: {}, // void signal — Schema.Void/Schema.Never defaults
  },
});

// Typed properties on the actor
ProcessOrder.Approval.token; // Effect<Token, never, WorkflowInstance>
ProcessOrder.Approval.await; // Effect<string, ApprovalError, ...>
ProcessOrder.Approval.succeed({ token, value }); // Effect<void, never, WorkflowEngine>
ProcessOrder.Approval.fail({ token, error }); // Effect<void, never, WorkflowEngine>
ProcessOrder.Approval.tokenFromExecutionId(id); // Token (pure)

// Inside the workflow handler — reference the actor's signals directly
Actor.toLayer(ProcessOrder, (payload, step) =>
  Effect.gen(function* () {
    const token = yield* ProcessOrder.Approval.token;
    yield* step.run("send-email", { do: sendEmail({ token }), success: Schema.Void });
    const decision = yield* ProcessOrder.Approval.await;
  }),
);

// External resolution
const token = ProcessOrder.Approval.tokenFromExecutionId(execId);
yield * ProcessOrder.Approval.succeed({ token, value: "approved" });
```

Signal names must not collide with reserved workflow properties (`Run`, `actor`, `peek`, etc.).

## Step DSL

Workflow handlers receive `(payload, step)` — a `WorkflowStepContext` that wraps upstream `Activity`, `DurableDeferred`, and `DurableClock`. No direct upstream imports needed.

### step.run — execute a durable activity

**Always provide `success` and `error` schemas.** Activities serialize results through JSON — explicit schemas ensure durable round-tripping and typed decode. The shorthand (`step.run(id, effect)`) uses `Schema.Unknown` internally, which accepts any JSON-safe value but loses type safety on decode. Use it for prototyping; prefer full options for production workflows.

```ts
// Full options (recommended) — explicit schemas for durable serialization
const result =
  yield *
  step.run("process", {
    do: processPayment(payload),
    success: PaymentResult,
    error: PaymentError,
    undo: (value, cause) => refundPayment(value.paymentId),
    retry: { times: 3 }, // or a Schedule
  });

// Shorthand — infallible, uses Schema.Unknown (quick & dirty, prototyping)
const result = yield * step.run("validate", validateOrder(payload.orderId));

// Shorthand with undo (saga compensation) — same Schema.Unknown caveat
const charge =
  yield *
  step.run("charge", chargeCard(payload.cardId, payload.amount), (chargeResult, cause) =>
    refundCard(chargeResult.chargeId),
  );
```

### step.sleep — durable sleep

```ts
yield * step.sleep("cooldown", "30 minutes");
yield * step.sleep("delay", "5 seconds", { inMemoryThreshold: "2 seconds" });
```

### step.race — first activity to complete

```ts
import { Activity } from "effect/unstable/workflow"; // only needed for race step types

const winner =
  yield *
  step.race("fastest", [
    Activity.make({ name: "a", success: Schema.String, execute: taskA }),
    Activity.make({ name: "b", success: Schema.String, execute: taskB }),
  ]);
```

### step.executionId — current execution ID

```ts
const id = step.executionId; // string
```

### step.attempt — current attempt number

```ts
const attempt = yield * step.attempt; // Effect<number>
```

### step.suspend — suspend the workflow

```ts
yield * step.suspend; // Effect<never>
```

### step.idempotencyKey — derived key

```ts
const key = yield * step.idempotencyKey("sub-step"); // "executionId/sub-step"
const keyWithAttempt = yield * step.idempotencyKey("sub-step", { includeAttempt: true });
```

### step.scope / step.provideScope / step.addFinalizer

```ts
const scope = yield * step.scope;
yield * step.provideScope(effectNeedingScope);
yield * step.addFinalizer((exit) => cleanup(exit));
```

### Full workflow handler example

```ts
const ProcessOrderLive = Actor.toLayer(ProcessOrder, (payload, step) =>
  Effect.gen(function* () {
    const validated = yield* step.run("validate", {
      do: validateOrder(payload.orderId),
      success: ValidatedOrder,
    });

    const charge = yield* step.run("charge", {
      do: chargeCard(validated.cardId, validated.amount),
      success: ChargeResult,
      error: ChargeError,
      undo: (charge, cause) => refundCard(charge.chargeId),
      retry: { times: 3 },
    });

    yield* step.sleep("cooldown", "5 seconds");

    return { orderId: payload.orderId, chargeId: charge.chargeId, status: "ok" };
  }),
);
```

## Handle

### Entity handlers — Actor.toLayer

```ts
// Consumer + producer — registers handlers AND provides Context
const CounterLive = Actor.toLayer(Counter, {
  Increment: ({ operation }) => Effect.succeed(operation.amount + 1),
  GetCount: () => Effect.succeed(42),
});

// From Effect context (yield services)
const CounterLive = Actor.toLayer(
  Counter,
  Effect.gen(function* () {
    const db = yield* Database;
    return {
      Increment: ({ operation }) => db.increment(operation.amount),
      GetCount: () => db.getCount(),
    };
  }),
);
```

### Workflow handler — Actor.toLayer

```ts
const ProcessOrderLive = Actor.toLayer(ProcessOrder, (payload, step) =>
  Effect.gen(function* () {
    const validated = yield* step.run("validate", {
      do: validateOrder(payload.orderId),
      success: ValidatedOrder,
    });
    return { orderId: payload.orderId, status: "ok" };
  }),
);
```

### Producer-only (client layer)

For services that send messages to actors they don't handle:

```ts
const CounterClient = Actor.toLayer(Counter);
```

### HandlerOptions (entity only)

```ts
Actor.toLayer(actor, handlers, {
  spanAttributes: { team: "platform" },
  maxIdleTime: 60_000,
  concurrency: 10,
  mailboxCapacity: 100,
});
```

### Handler shape (entity)

Handlers receive `{ operation, request }`:

- `operation` — typed operation value with `_tag` and payload fields spread
- `request` — cluster request metadata (headers, requestId, etc.)

## Client

### actor(id) — get a ref (entity)

```ts
const ref = yield * Counter.actor("counter-1");
```

Requires `Counter.Context` in the environment (provided by `Actor.toLayer` or `Actor.toTestLayer`).

### actor() — get a ref (workflow)

```ts
const ref = yield * ProcessOrder.actor();
```

Workflow actors are nullary — no entity ID needed.

### execute — block for reply

```ts
const result = yield * ref.execute(Counter.Increment({ amount: 5 }));
```

Return type inferred from operation's `success` schema. Error type from `error` schema.

### send — fire-and-forget with ExecId

```ts
const execId = yield * ref.send(Counter.Increment({ amount: 5 }));
// execId: ExecId<number, never> — branded string with phantom types
```

Returns `ExecId<Success, Error>` immediately. Send error channel does NOT include handler errors (discard semantics).

### ExecId

```ts
type ExecId<Success = unknown, Error = unknown> = string & {
  readonly [ExecIdBrand]: { readonly success: Success; readonly error: Error };
};
```

At runtime, just a string. Format:

- Entity: `"entityId\0operationTag\0primaryKey"` (null-byte separated — opaque, don't parse)
- Workflow: upstream `idempotencyKey(payload)` result

## Peek

### peek — one-shot status check

```ts
// On the actor object — takes ExecId, returns typed PeekResult
const status = yield * Counter.peek(execId);
// status: PeekResult<number, never> — types flow from ExecId brand
```

Entity peek requires `MessageStorage | Sharding` in context.
Workflow peek requires `WorkflowEngine` in context.

### watch — polling stream

```ts
const stream = Counter.watch(execId, { interval: Duration.millis(200) });
```

Emits on status changes, completes on terminal result.

### PeekResult

```ts
type PeekResult<A = unknown, E = unknown> =
  | { _tag: "Pending" }
  | { _tag: "Success"; value: A }
  | { _tag: "Failure"; error: E }
  | { _tag: "Interrupted" }
  | { _tag: "Defect"; cause: unknown }
  | { _tag: "Suspended" }; // workflow-only at runtime
```

Guards: `isPending`, `isSuccess`, `isFailure`, `isSuspended`, `isTerminal`.

## WaitFor

### waitFor — poll until terminal

```ts
const result = yield * Counter.waitFor(execId);
// result: PeekResult<number, never> — guaranteed terminal
```

With custom filter and schedule:

```ts
const result =
  yield *
  Counter.waitFor(execId, {
    filter: (r) => r._tag === "Success", // stop only on success
    schedule: Schedule.spaced("500 millis"), // custom poll interval
  });
```

Default: polls every 200ms, stops on any terminal result (`isTerminal`).

Entity waitFor requires `MessageStorage | Sharding` in context.
Workflow waitFor requires `WorkflowEngine` in context.

## Test

### Entity test — Actor.toTestLayer

```ts
const CounterTest = Layer.provide(
  Actor.toTestLayer(Counter, {
    Increment: ({ operation }) => Effect.succeed(operation.amount + 1),
    GetCount: () => Effect.succeed(42),
  }),
  TestShardingConfig,
);

const test = it.scopedLive.layer(CounterTest);

test("increments", () =>
  Effect.gen(function* () {
    const ref = yield* Counter.actor("counter-1");
    const result = yield* ref.execute(Counter.Increment({ amount: 5 }));
    expect(result).toBe(6);
  }));
```

### Workflow test — Actor.toTestLayer

`WorkflowEngine.layerMemory` provided automatically:

```ts
const GreeterTest = Actor.toTestLayer(Greeter, (payload, step) =>
  Effect.succeed(`hello ${payload.name}`),
);

it.scopedLive.layer(GreeterTest)("greets", () =>
  Effect.gen(function* () {
    const ref = yield* Greeter.actor();
    const result = yield* ref.execute(Greeter.Run({ name: "world" }));
    expect(result).toBe("hello world");
  }),
);
```

### Dynamic / inline test layers

Provide the layer around the **full usage** — don't let `ActorRef` escape the provider scope:

```ts
it.scopedLive("dynamic test", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<Array<string>>([]);

    const Tracker = Actor.fromEntity("Tracker", {
      Track: {
        payload: { item: Schema.String },
        success: Schema.String,
        primaryKey: (p) => p.item,
      },
    });

    const TrackerTest = Layer.provide(
      Actor.toTestLayer(Tracker, {
        Track: ({ operation }) =>
          Ref.update(calls, (arr) => [...arr, operation.item]).pipe(
            Effect.as(`tracked: ${operation.item}`),
          ),
      }),
      TestShardingConfig,
    );

    return yield* Effect.gen(function* () {
      const ref = yield* Tracker.actor("t-1");
      const result = yield* ref.execute(Tracker.Track({ item: "widget" }));
      expect(result).toBe("tracked: widget");
    }).pipe(Effect.provide(TrackerTest));
  }),
);
```

### Scope gotcha

`Effect.provide(effect, scopedLayer)` creates a private scope. If you provide only around `actor("id")`, the ref escapes the scope → "All fibers interrupted without error". Provide around the entire block.

## Lifecycle

```ts
// Entity: passivate
Order.interrupt("ord-1");

// Workflow: cancel + resume
ProcessOrder.interrupt("exec-id");
ProcessOrder.resume("exec-id");

// Workflow-only
const execId = yield * ProcessOrder.executionId({ orderId: "ord-1" });
```

## DeliverAt

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

## Observability

Cluster creates spans `EntityType(entityId).RpcTag` automatically. No custom middleware needed. Pass extra attributes via `HandlerOptions.spanAttributes`.

## v3

Import from `effect-encore/v3`. Same API, different import paths:

| v4                         | v3                   |
| -------------------------- | -------------------- |
| `effect/unstable/cluster`  | `@effect/cluster`    |
| `effect/unstable/rpc`      | `@effect/rpc`        |
| `effect/unstable/workflow` | `@effect/workflow`   |
| `Schema.Top`               | `Schema.Schema.Any`  |
| `Context.Service`          | `Context.GenericTag` |

## Migration

### From raw @effect/cluster

| Before (raw cluster)                                                | After (effect-encore)                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Custom `Schema.Class` with `PrimaryKey.symbol` + `DeliverAt.symbol` | `primaryKey` + `deliverAt` in OperationDef                 |
| `Rpc.make` + `RpcGroup.make` + `Entity.fromRpcGroup`                | `Actor.fromEntity(name, operations)`                       |
| `entity.toLayer(Effect.gen(...))` with `entity.of({...})`           | `Actor.toLayer(actor, handlers)`                           |
| `Context.Tag` + `makeClientLayer` per entity                        | `Actor.toLayer(actor)` — provides `actor.Context`          |
| `client(entityId).Op(payload, { discard: true })`                   | `ref.send(Actor.Op(payload))` — returns `ExecId<S, E>`     |
| Manual `getMessageStatus(primaryKey)` with empty address fields     | `actor.peek(execId)` with correct compound key             |
| Custom `RpcMiddleware` for spans                                    | Not needed — cluster creates spans automatically           |
| `Entity.makeTestClient` + manual RpcClient mapping                  | `Actor.toTestLayer(actor, handlers)` — returns typed Layer |
| `Workflow.make` + manual client wiring                              | `Actor.fromWorkflow(name, def)` — unified call site        |
| `Activity`/`DurableDeferred`/`DurableClock` direct imports          | `step.run`/`step.sleep` + declarative `signals` on def     |

### From effect-encore v1 (Actor.make era)

| Before                           | After                                    |
| -------------------------------- | ---------------------------------------- |
| `Actor.make("Name", defs)`       | `Actor.fromEntity("Name", defs)`         |
| `primaryKey` optional            | `primaryKey` mandatory on all operations |
| `ref.call(op)`                   | `ref.execute(op)`                        |
| `ref.cast(op)` → `CastReceipt`   | `ref.send(op)` → `ExecId<S, E>`          |
| `peek(actor, receipt)`           | `actor.peek(execId)`                     |
| `watch(actor, receipt)`          | `actor.watch(execId)`                    |
| `import { Workflow } from "..."` | Step DSL via `(payload, step)` handler   |
| `Workflow.workflow(name, opts)`  | `Actor.fromWorkflow(name, def)`          |
