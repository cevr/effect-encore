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
export type HandlerOutput<H> = H extends (...args: any[]) => Generator<any, infer O, any>
  ? O
  : never;

/**
 * Runtime serialization for a handler's I/O at the durable boundary. The static
 * input/output types still come from the generator signature; descriptors only
 * supply the encode/decode schemas (default `Schema.Unknown` — opaque JSON).
 */
export interface HandlerDescriptor<
  I extends Schema.Top = Schema.Top,
  O extends Schema.Top = Schema.Top,
> {
  readonly input?: I;
  readonly output?: O;
}

/** Typed I/O boundary for a handler. `schemas({ input, output })`. */
export const schemas = <I extends Schema.Top = typeof Schema.Unknown, O extends Schema.Top = typeof Schema.Unknown>(
  d: HandlerDescriptor<I, O>,
): HandlerDescriptor<I, O> => d;

/** Options for a single handler invocation. */
export interface InvokeOptions {
  /**
   * Idempotency key for this call. Two invocations with the same key resolve to
   * the **same durable execution** — the second returns the recorded result and
   * the body is not re-run. Omitted → a fresh per-call execution.
   */
  readonly idempotencyKey?: string;
}

interface CompiledHandler {
  readonly key: string;
  readonly workflow: Workflow.Any;
  /** Registers the handler body against a `WorkflowEngine`. */
  readonly layer: Layer.Layer<never, never, WorkflowEngine>;
  /** Invokes the handler. Same `idempotencyKey` → same durable execution. */
  readonly execute: (
    input: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<unknown, unknown, WorkflowEngine>;
  /** Fire-and-forget dispatch; resolves to the execution id, not the result. */
  readonly send: (
    input: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<string, unknown, WorkflowEngine>;
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
  readonly descriptors?: Partial<Record<keyof H, HandlerDescriptor>>;
}

const compileHandler = (
  serviceName: string,
  key: string,
  handler: GeneratorHandler,
  descriptor: HandlerDescriptor | undefined,
): CompiledHandler => {
  // `input` carries the handler argument (decoded via the descriptor's input
  // schema, default opaque). `__id` carries the idempotency key so callers
  // control execution identity (fresh per call, or shared for dedup).
  const inputSchema = descriptor?.input ?? Schema.Unknown;
  const outputSchema = descriptor?.output ?? Schema.Unknown;
  const wf = Workflow.make(`${serviceName}/${key}`, {
    payload: { input: inputSchema, __id: Schema.String },
    idempotencyKey: (p: { readonly __id: string }) => p.__id,
    success: outputSchema,
  });

  // The generator body → Effect. `Effect.fnUntraced(handler)` turns the
  // generator-method into an Effect-returning function; the Effects it yields
  // (run/all/race) add WorkflowEngine | WorkflowInstance to R, satisfied by
  // wf.toLayer's body context.
  const bodyFn = Effect.fnUntraced(handler as any) as (
    input: unknown,
  ) => Effect.Effect<unknown, never, any>;

  const layer = wf.toLayer((payload: { readonly input: unknown }) =>
    bodyFn(payload.input),
  ) as Layer.Layer<never, never, WorkflowEngine>;

  const payloadFor = (input: unknown, options?: InvokeOptions) =>
    ({ input, __id: options?.idempotencyKey ?? crypto.randomUUID() }) as never;

  const execute = (
    input: unknown,
    options?: InvokeOptions,
  ): Effect.Effect<unknown, unknown, WorkflowEngine> =>
    wf.execute(payloadFor(input, options)) as Effect.Effect<unknown, unknown, WorkflowEngine>;

  const send = (
    input: unknown,
    options?: InvokeOptions,
  ): Effect.Effect<string, unknown, WorkflowEngine> =>
    wf.execute(payloadFor(input, options), { discard: true }) as Effect.Effect<
      string,
      unknown,
      WorkflowEngine
    >;

  return { key, workflow: wf, layer, execute, send };
};

/** Define a stateless durable service. */
export const service = <const Name extends string, H extends Handlers>(
  def: ServiceConfig<Name, H>,
): ServiceDefinition<Name, H> => ({
  name: def.name,
  handlers: def.handlers,
  _compiled: Object.entries(def.handlers).map(([key, handler]) =>
    compileHandler(def.name, key, handler, def.descriptors?.[key as keyof H]),
  ),
});
