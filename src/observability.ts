// ── Observability ─────────────────────────────────────────────────────────
//
// Effect Cluster automatically creates spans for every handler invocation:
//   `${entityType}(${entityId}).${rpcTag}`
//
// This is done by the entity manager setting `spanPrefix` and RpcServer
// wrapping each handler in `Effect.withSpan`. No custom RpcMiddleware needed.
//
// To add custom attributes to these spans, pass `spanAttributes` to
// `Handlers.handlers(actor, build, { spanAttributes: { ... } })`.
//
// For advanced use cases (custom middleware, auth, rate limiting), attach
// middleware directly to Rpcs before passing to `Actor.from()`:
//   `Rpc.make("Op", {...}).middleware(MyMiddleware)`

export { CurrentAddress } from "effect/unstable/cluster/Entity";

export const defaultSpanAttributes = (actorName: string): Record<string, string> => ({
  "actor.name": actorName,
  "actor.library": "effect-encore",
});
