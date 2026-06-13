/* eslint-disable @typescript-eslint/no-explicit-any -- handler payload/result types are erased at the Workflow adapter boundary */
import { Effect, type Layer, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";

// ─────────────────────────────────────────────────────────────────────────
// service.ts — the `service` definition primitive (slice 1).
//
// A `service({ name, handlers })` is a passive, registerable value. Each
// generator-method handler `*h(input)` compiles to one upstream `Workflow`:
// the body is the generator lowered with `Effect.fnUntraced`, running under the
// engine context that the free functions (run/all/race) reach into.
//
// Definition ≠ client. You collect definitions, register them (serviceLayer),
// and invoke through `client(def)` — never by calling a handler on the
// definition itself.
// ─────────────────────────────────────────────────────────────────────────

type GeneratorHandler = (input: any) => Generator<any, any, any>;
export type Handlers = Record<string, GeneratorHandler>;

export type HandlerInput<H> = H extends (input: infer I) => any ? I : never;
export type HandlerOutput<H> = H extends (...args: any[]) => Generator<any, infer O, any> ? O : never;

interface CompiledHandler {
  readonly key: string;
  readonly workflow: Workflow.Any;
  /** Registers the handler body against a `WorkflowEngine`. */
  readonly layer: Layer.Layer<never, never, WorkflowEngine>;
  /** Invokes the handler — a fresh durable execution per call. */
  readonly execute: (input: unknown) => Effect.Effect<unknown, unknown, WorkflowEngine>;
}

export interface ServiceDefinition<Name extends string, H extends Handlers> {
  readonly name: Name;
  /** Retained for input/output type inference; not a call surface. */
  readonly handlers: H;
  /** Internal: per-handler compiled workflow + registration + invoker. */
  readonly _compiled: ReadonlyArray<CompiledHandler>;
}

export interface ServiceConfig<Name extends string, H extends Handlers> {
  readonly name: Name;
  readonly handlers: H;
}

const compileHandler = (serviceName: string, key: string, handler: GeneratorHandler): CompiledHandler => {
  // Slice 1: schema-less I/O. `input` is opaque (Schema.Unknown); `__id` carries
  // a per-call idempotency key so each invocation is a fresh execution.
  const wf = Workflow.make(`${serviceName}/${key}`, {
    payload: { input: Schema.Unknown, __id: Schema.String },
    idempotencyKey: (p: { readonly __id: string }) => p.__id,
    success: Schema.Unknown,
  });

  // The generator body → Effect. `Effect.fnUntraced(handler)` turns the
  // generator-method into an Effect-returning function; the Effects it yields
  // (run/all/race) add WorkflowEngine | WorkflowInstance to R, satisfied by
  // wf.toLayer's body context.
  const bodyFn = Effect.fnUntraced(handler as any) as (input: unknown) => Effect.Effect<unknown, never, any>;

  const layer = wf.toLayer((payload: { readonly input: unknown }) =>
    bodyFn(payload.input),
  ) as Layer.Layer<never, never, WorkflowEngine>;

  const execute = (input: unknown): Effect.Effect<unknown, unknown, WorkflowEngine> =>
    wf.execute({ input, __id: crypto.randomUUID() } as never) as Effect.Effect<unknown, unknown, WorkflowEngine>;

  return { key, workflow: wf, layer, execute };
};

/** Define a stateless durable service. */
export const service = <const Name extends string, H extends Handlers>(
  def: ServiceConfig<Name, H>,
): ServiceDefinition<Name, H> => ({
  name: def.name,
  handlers: def.handlers,
  _compiled: Object.entries(def.handlers).map(([key, handler]) => compileHandler(def.name, key, handler)),
});
