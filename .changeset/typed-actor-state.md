---
"effect-encore": minor
---

Typed actor state. `Actor.fromEntity(name, defs, { state: { schema, error? } })` now wires the registered state handle through `Schema.decodeUnknown` at the read boundary. `getState` / `watchState` / `waitForState` return `Schema.Type<schema>` instead of `unknown`, and emissions are validated through the schema (defense-in-depth at the registry boundary, not a bare type assertion). The optional `error` schema decodes the failure channel.

```ts
const Counter = Actor.fromEntity(
  "Counter",
  { Increment: { ... } },
  { state: { schema: Schema.Number } },
);

// inferred as Effect<number, ...>
const value = yield* Counter.getState("c1");
```

Backwards compatible — actors declared without `state` continue to return `unknown` from the state methods.
