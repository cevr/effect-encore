/* eslint-disable @typescript-eslint/no-explicit-any -- client proxy erases per-handler types behind the inferred surface */
import { type Effect, type Fiber, Layer, ManagedRuntime } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import { workflowEngineLayer } from "../workflow.ts";
import type {
  HandlerInput,
  HandlerOutput,
  Handlers,
  InvokeOptions,
  ServiceDefinition,
} from "./service.ts";

// ─────────────────────────────────────────────────────────────────────────
// runtime.ts — registration + client surfaces.
//
// Two forms:
//   • Plain-layer / Effect form. `serviceLayer(...defs)` merges handler bodies
//     into one `Layer<never, never, WorkflowEngine>`; `client(def)` returns
//     Effects requiring `WorkflowEngine`. Provide both yourself.
//   • Ingress-bound / Promise form (firegrid-faithful). `makeRuntime({ services,
//     engine })` builds a ManagedRuntime carrying the engine; `client(ingress,
//     def)` / `sendClient(ingress, def)` return Promise-based methods that run
//     against it — no `Effect.provide` at the call site.
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

// ── Ingress ────────────────────────────────────────────────────────────────

/** A runtime carrying registered handler bodies + the durable engine. */
export interface Ingress {
  /** The underlying ManagedRuntime (handler bodies + engine). */
  readonly runtime: ManagedRuntime.ManagedRuntime<any, any>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, WorkflowEngine>) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, WorkflowEngine>) => Fiber.Fiber<A, E>;
  /** Release the engine + all handler registrations. */
  readonly dispose: () => Promise<void>;
}

/**
 * Build an ingress from a set of service definitions and an engine endpoint.
 * Registers every handler body against one engine and holds it; dispose when
 * done (or let the ManagedRuntime be GC'd by your host).
 */
export const makeRuntime = (config: {
  readonly services: ReadonlyArray<ServiceDefinition<string, any>>;
  readonly engine: { readonly streamUrl: string };
}): Ingress => {
  const layer = serviceLayer(...config.services).pipe(
    Layer.provideMerge(workflowEngineLayer(config.engine)),
  );
  const runtime = ManagedRuntime.make(layer as unknown as Layer.Layer<WorkflowEngine, never, never>);
  return {
    runtime,
    runPromise: (effect) => runtime.runPromise(effect as any),
    runFork: (effect) => runtime.runFork(effect as any) as Fiber.Fiber<any, any>,
    dispose: () => runtime.dispose(),
  };
};

// ── Clients ──────────────────────────────────────────────────────────────

/** Effect-returning call surface (plain-layer form). */
export type CallClient<H extends Handlers> = {
  readonly [K in keyof H]: (
    input: HandlerInput<H[K]>,
    options?: InvokeOptions,
  ) => Effect.Effect<HandlerOutput<H[K]>, unknown, WorkflowEngine>;
};

/** Promise-returning call surface bound to an ingress. */
export type BoundClient<H extends Handlers> = {
  readonly [K in keyof H]: (
    input: HandlerInput<H[K]>,
    options?: InvokeOptions,
  ) => Promise<HandlerOutput<H[K]>>;
};

/** Promise-returning fire-and-forget surface bound to an ingress (resolves to execution id). */
export type SendClient<H extends Handlers> = {
  readonly [K in keyof H]: (input: HandlerInput<H[K]>, options?: InvokeOptions) => Promise<string>;
};

/**
 * Typed call surface for a service.
 *   • `client(def)` — Effect form; methods require `WorkflowEngine`.
 *   • `client(ingress, def)` — ingress-bound; methods return Promises.
 * Pass `{ idempotencyKey }` to share a durable execution across calls.
 */
export function client<Name extends string, H extends Handlers>(
  def: ServiceDefinition<Name, H>,
): CallClient<H>;
export function client<Name extends string, H extends Handlers>(
  ingress: Ingress,
  def: ServiceDefinition<Name, H>,
): BoundClient<H>;
export function client(a: any, b?: any): any {
  if (b === undefined) {
    const def = a as ServiceDefinition<string, Handlers>;
    const out: Record<string, any> = {};
    for (const h of def._compiled) {
      out[h.key] = (input: unknown, options?: InvokeOptions) => h.execute(input, options);
    }
    return out;
  }
  const ingress = a as Ingress;
  const def = b as ServiceDefinition<string, Handlers>;
  const out: Record<string, any> = {};
  for (const h of def._compiled) {
    out[h.key] = (input: unknown, options?: InvokeOptions) =>
      ingress.runPromise(h.execute(input, options));
  }
  return out;
}

/**
 * Fire-and-forget surface bound to an ingress. `sendClient(ingress, def).h(input)`
 * dispatches a durable execution and resolves to its execution id (not the result).
 */
export const sendClient = <Name extends string, H extends Handlers>(
  ingress: Ingress,
  def: ServiceDefinition<Name, H>,
): SendClient<H> => {
  const out: Record<string, (input: unknown, options?: InvokeOptions) => Promise<string>> = {};
  for (const h of def._compiled) {
    out[h.key] = (input: unknown, options?: InvokeOptions) => ingress.runPromise(h.send(input, options));
  }
  return out as SendClient<H>;
};
