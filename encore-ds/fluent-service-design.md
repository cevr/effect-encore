# encore-ds — fluent module design (slice 1: `service` + `run`/`all`/`race`)

A second authoring surface for `encore-ds`, shaped after
`fluent-firegrid` (firegrid tutorial `examples/tutorial`), lowering onto
`@effect/workflow` + the existing `DurableStreamsWorkflowEngine` — **no custom
durable journal**. Lives alongside the `Actor.*` surface as a new module; reuses
the engine + the Activity/Deferred lowering already proven in `step.ts`.

## The shape (three distinct things)

Faithful to firegrid / Restate — **definition, ingress, and client are separate**:

1. **Definition** — `service({ name, handlers, descriptors? })`. Generator-method
   handlers; free functions (`run`/`all`/`race`) called inside the body. This is a
   passive, registerable value — you never call a handler on it directly.
2. **Ingress (runtime)** — `makeRuntime({ services, engine })`. Collects the
   service definitions, registers every handler body against one
   `DurableStreamsWorkflowEngine`, and holds it. Exposes `runPromise` / `runFork`.
3. **Client** — `client(ingress, def)` / `sendClient(ingress, def)`. A typed proxy
   bound to the ingress; `client(ingress, incidentReview).hello("world")` is how you
   invoke. The ingress already carries the engine, so client methods run cleanly.

```
service({...})  ──collect──▶  makeRuntime({ services, engine })  ──derive──▶  client(ingress, def)
  (definition)                       (ingress / runtime)                       (typed call surface)
```

## The one idea (free functions, no ctx)

A handler body runs inside the upstream workflow body (`wf.toLayer`), where the
Effect context already carries `WorkflowEngine | WorkflowInstance`
(`engine-runtime.ts`, exercised by `step.ts`). So a free `run(action, { name })`
is just `Activity.make({ name, execute: action })` — an Effect whose `R` is
`WorkflowEngine | WorkflowInstance`. That requirement is the "fail outside an
active runtime" guarantee, for free: the activity is only satisfiable inside a
registered body. This is `step.ts`'s `ctx.run` lifted from a **ctx object** to a
**context-reaching free function**; the lowering is otherwise identical.

## What slice 1 proves

1. `service({ name, handlers })` with generator handlers compiles to registered
   upstream `Workflow`s.
2. `makeRuntime({ services, engine })` registers them against one engine and yields
   a runnable ingress.
3. Free `run` (thunk + name, no ctx) lowers to a durable `Activity`, memoized /
   replay-stable.
4. `all([...])` / `race([...])` compose durable handles **name-free** — durable
   identity comes from each inner `run`'s `name`, never call order.
5. `client(ingress, def)` invokes a handler and returns its decoded result.

Out of scope for slice 1: `object` / `workflow` / `state` / `sharedState` /
`signal` / `awakeable` / `deferred` / `select` / `spawn` / cross-definition
`call`/`send` over child sessions, compensation/retry, and the typed `schemas()`
boundary (defaults to `Schema.Unknown`).

## Module layout (new)

```
encore-ds/src/fluent/
  free.ts        run / all / race  (lower to Activity / Effect.all / Effect.race)
  service.ts     service(): handler types, compile handlers → Workflows
  runtime.ts     makeRuntime({ services, engine }) → ingress; client / sendClient
  index.ts       re-exports: service, run, all, race, makeRuntime, client, sendClient
```

Reuses unchanged: `workflowEngineLayer` (`workflow.ts`), the vendored engine,
`outcome.ts`/`receipt.ts` for result shaping. `step.ts` is untouched (the `Actor`
surface keeps it); `free.ts` re-derives the same Activity lowering without the ctx
wrapper.

Handlers return a plain `Effect.Effect<Output, Error, WorkflowEngine | WorkflowInstance>`
— no `Operation<T>` alias (firegrid keeps one for brevity; we dropped it per
request). Author signatures annotate the Effect directly or lean on inference.

## Type surface

```ts
// service.ts — handler inference
type GeneratorHandler = (input: any) => Generator<any, any, any>
type HandlerInput<H>  = H extends (input: infer I) => any ? I : never
type HandlerOutput<H> = H extends (...a: any) => Generator<any, infer O, any> ? O : never

interface DefinitionConfig<Name extends string, H extends Record<string, GeneratorHandler>> {
  readonly name: Name
  readonly handlers: H
  readonly descriptors?: Partial<Record<keyof H, HandlerDescriptor>>  // slice 1: input/output schemas, default Schema.Unknown
}

interface ServiceDefinition<Name extends string, H> {
  readonly name: Name
  readonly _compiled: ReadonlyArray<CompiledHandler>   // internal: { key, workflow, body } per handler
}

export const service: <Name extends string, H extends Record<string, GeneratorHandler>>(
  def: DefinitionConfig<Name, H>,
) => ServiceDefinition<Name, H>
```

```ts
// runtime.ts
interface Ingress {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, WorkflowEngine>) => Promise<A>
  readonly runFork:    <A, E>(effect: Effect.Effect<A, E, WorkflowEngine>) => Fiber<A, E>
  readonly [InternalEngine]: WorkflowEngine // captured engine, used by client()
}

export const makeRuntime: (config: {
  readonly services: ReadonlyArray<ServiceDefinition<string, any>>
  readonly engine: { readonly streamUrl: string }
}) => Effect.Effect<Ingress, never, Scope.Scope>   // scoped: owns the engine lifecycle

// typed proxy bound to the ingress
type CallClient<H> = { readonly [K in keyof H]: (input: HandlerInput<H[K]>) => Promise<HandlerOutput<H[K]>> }
type SendClient<H> = { readonly [K in keyof H]: (input: HandlerInput<H[K]>) => Promise<ExecId> }

export const client:     <Name extends string, H>(ingress: Ingress, def: ServiceDefinition<Name, H>) => CallClient<H>
export const sendClient: <Name extends string, H>(ingress: Ingress, def: ServiceDefinition<Name, H>) => SendClient<H>
```

## Compilation: handler → Workflow

Each handler `*h(input)` becomes one upstream `Workflow.make`:

```ts
const wf = Workflow.make({
  name: `${serviceName}/${handlerKey}`,
  payload: Schema.Struct({ input: descriptor?.input ?? Schema.Unknown, __id: Schema.String }),
  success: descriptor?.output ?? Schema.Unknown,
  error:   descriptor?.error,
  idempotencyKey: (p) => p.__id,           // see "Invocation identity"
})

// generator body → Effect, lowered with Effect.fnUntraced; R = WorkflowEngine | WorkflowInstance
const body = (payload, _executionId) => Effect.fnUntraced(handler)(payload.input)

const handlerLayer = wf.toLayer(body)      // Layer<never, never, WorkflowEngine>
```

`makeRuntime` merges all handler layers, provides one `workflowEngineLayer(engine)`,
builds the scoped engine, and captures it on the ingress. `client(ingress, def)`
maps each handler key to `(input) => ingress.runPromise(wf.execute({ input, __id }))`.

## Free functions (`free.ts`)

```ts
// run(action, { name }) | run(name, action)  — action is a thunk or an Effect
export const run = (a, b?): Effect.Effect<any, any, WorkflowEngine | WorkflowInstance> => {
  const { name, action, options } = resolveRunArgs(a, b)   // missing name → Effect.fail(DurableExecutionError)
  return Activity.make({
    name,
    success: options?.success ?? Schema.Unknown,
    error:   options?.error,
    execute: toEffect(action),                              // thunk → Effect.suspend/promise; Effect passthrough
  })
}

// name-free: durable identity is each inner run's name
export const all  = <Ops extends readonly Effect.Effect<any, any, any>[]>(ops: Ops) =>
  Effect.all(ops, { concurrency: "unbounded" })

export const race = (ops: NonEmptyReadonlyArray<Effect.Effect<any, any, any>>) =>
  Effect.raceAll(ops)
```

- **`run`**: identical lowering to `step.ts`'s `ctx.run`, minus `withCompensation`
  (undo/retry are slice-2). Memoization is the engine's: yielding the same activity
  twice re-evaluates the Effect but the engine returns the recorded terminal fact —
  at-most-once side effect.
- **`all` / `race`**: plain `Effect.all` / `Effect.raceAll` — "free helpers over
  Effect concurrency/race semantics" (firegrid README). No positional durable
  counter; durability lives in the inner `run` names.
  - **Known nuance** (matches the reference): `race` durability is only as stable as
    the runs that recorded a terminal fact. If the loser is interrupted before
    recording, it re-runs on replay. Acceptable for slice 1; a fully replay-stable
    durable race (named `DurableDeferred.raceAll`) is a later refinement.

## Usage (target ergonomics)

```ts
import { Effect } from "effect"
import { service, run, all, race, makeRuntime, client } from "encore-ds/fluent"

const incidentReview = service({
  name: "incidentReview",
  handlers: {
    *hello(name: string) {
      return yield* run(() => `Hello, ${name}!`, { name: "compose" })
    },
    *parallel(input: IncidentInput) {
      const triage  = run(() => classify(input), { name: "classify" })
      const context = run(() => collect(input),  { name: "collect" })
      const [t, c]  = yield* all([triage, context])
      return `${t.route}+${c.summary}`
    },
    *fastest(id: string) {
      return yield* race([
        run(() => primary(id),   { name: "primary" }),
        run(() => secondary(id), { name: "secondary" }),
      ])
    },
  },
})

const program = Effect.gen(function* () {
  const ingress  = yield* makeRuntime({ services: [incidentReview], engine: { streamUrl } })
  const incidents = client(ingress, incidentReview)

  const greeting = await incidents.hello("world")
  const summary  = await incidents.parallel({ incidentId: "inc-1", severity: 3 })
  return { greeting, summary }
})

Effect.runPromise(Effect.scoped(program))
```

Define → `makeRuntime` (collect + register + engine, one call) → `client(ingress, def)`.
No per-service `.toLayer()`, no manual engine merge, no `.execute` on the definition.

## Conformance tests (slice 1)

Real `DurableStreamTestServer` (mirrors `tiny-workflow.test.ts`):

- **SERVICE-RUN-ONCE** — handler with one `run`; invoke twice with the same id →
  durable result returned, body not re-run (`runs === 1`).
- **SERVICE-SEQUENTIAL** — two sequential `run`s compose; both recorded.
- **SERVICE-ALL** — `all([run a, run b])` runs concurrently, both memoized.
- **SERVICE-RACE** — `race([fast, slow])` returns fast.
- **CLIENT-INVOKE** — `client(ingress, def).hello("x")` returns the decoded output.
- **FREE-FN-FAILS-OUTSIDE** — `run(...)` outside a body is unsatisfiable
  (`WorkflowEngine | WorkflowInstance` unmet) — type-level + runtime.

## Deferred decisions (flagged)

1. **Invocation identity for `service`.** SDD/firegrid: "each call a fresh
   invocation." Slice-1 default: `__id` = per-call uuid (fresh), overridable. Open:
   should bare calls dedup by input, with dedup reserved for child sessions? Leaning
   fresh-per-call.
2. **One stream per definition** (SDD §7) vs. one stream per `makeRuntime` engine
   (here). Contained to runtime wiring; revisit with `object`/`workflow`.
3. **Replay-stable durable `race`** — slice 1 uses `Effect.raceAll` (reference
   parity); named `DurableDeferred.raceAll` is a refinement.
4. **`undo`/compensation + `retry`** on `run` — slice 2.
5. **`descriptors` / `schemas()` typed boundary** — defaults to `Schema.Unknown`;
   full Effect-Schema IO is slice 2.
6. **`object` / `workflow` / `state` / signals / `select` / `spawn` / `call` /
   `send` child sessions** — later slices.
```
