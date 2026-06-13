/* eslint-disable @typescript-eslint/no-explicit-any -- client proxy erases per-handler types behind the inferred surface */
import { type Effect, Layer } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import type {
  HandlerInput,
  HandlerOutput,
  Handlers,
  InvokeOptions,
  ServiceDefinition,
} from "./service.ts";

// ─────────────────────────────────────────────────────────────────────────
// runtime.ts — registration + client surface (slice 1, plain-layer form).
//
// `serviceLayer(...defs)` merges every handler body into one
// `Layer<never, never, WorkflowEngine>`; provide it alongside
// `workflowEngineLayer({ streamUrl })`. `client(def)` is the typed call surface
// — methods return Effects requiring `WorkflowEngine`, satisfied by that layer.
//
// An ingress-bound wrapper (a ManagedRuntime carrying the engine, so calls run
// without `Effect.provide`) is a thin layer on top of this — deferred until the
// mechanism is proven.
// ─────────────────────────────────────────────────────────────────────────

/** Merge the handler registrations of one or more services into one layer. */
export const serviceLayer = (
  ...defs: ReadonlyArray<ServiceDefinition<string, any>>
): Layer.Layer<never, never, WorkflowEngine> =>
  Layer.mergeAll(
    ...(defs.flatMap((d) => d._compiled.map((h) => h.layer)) as [
      Layer.Layer<never, never, WorkflowEngine>,
      ...Array<Layer.Layer<never, never, WorkflowEngine>>,
    ]),
  );

export type CallClient<H extends Handlers> = {
  readonly [K in keyof H]: (
    input: HandlerInput<H[K]>,
    options?: InvokeOptions,
  ) => Effect.Effect<HandlerOutput<H[K]>, unknown, WorkflowEngine>;
};

/**
 * Typed call surface for a service. `client(def).handler(input)` invokes a
 * handler as a fresh durable execution and returns its decoded result. Pass
 * `{ idempotencyKey }` to share an execution across calls (durable dedup).
 */
export const client = <Name extends string, H extends Handlers>(
  def: ServiceDefinition<Name, H>,
): CallClient<H> => {
  const out: Record<
    string,
    (input: unknown, options?: InvokeOptions) => Effect.Effect<unknown, unknown, WorkflowEngine>
  > = {};
  for (const h of def._compiled) {
    out[h.key] = (input: unknown, options?: InvokeOptions) => h.execute(input, options);
  }
  return out as CallClient<H>;
};
