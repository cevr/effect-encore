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

/** Derives an execution id from a call's input + options. Captures the kind's identity contract. */
type IdentityFn = (input: unknown, options?: InvokeOptions) => string;

const compileHandler = (
  definitionName: string,
  key: string,
  handler: GeneratorHandler,
  descriptor: HandlerDescriptor | undefined,
  deriveId: IdentityFn,
): CompiledHandler => {
  // `input` carries the handler argument (decoded via the descriptor's input
  // schema, default opaque). `__id` carries the execution id — its derivation is
  // the kind's identity contract (fresh per call for service; keyed for workflow).
  const inputSchema = descriptor?.input ?? Schema.Unknown;
  const outputSchema = descriptor?.output ?? Schema.Unknown;
  const wf = Workflow.make(`${definitionName}/${key}`, {
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
    ({ input, __id: deriveId(input, options) }) as never;

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

const compileDefinition = <Name extends string, H extends Handlers>(
  name: Name,
  handlers: H,
  descriptors: Partial<Record<keyof H, HandlerDescriptor>> | undefined,
  deriveId: IdentityFn,
): ServiceDefinition<Name, H> => ({
  name,
  handlers,
  _compiled: Object.entries(handlers).map(([key, handler]) =>
    compileHandler(name, key, handler as GeneratorHandler, descriptors?.[key as keyof H], deriveId),
  ),
});

// service — stateless; each call a fresh durable execution (override via
// InvokeOptions.idempotencyKey).
const freshIdentity: IdentityFn = (_input, options) =>
  options?.idempotencyKey ?? crypto.randomUUID();

/** Define a stateless durable service — each call is a fresh invocation. */
export const service = <const Name extends string, H extends Handlers>(
  def: ServiceConfig<Name, H>,
): ServiceDefinition<Name, H> =>
  compileDefinition(def.name, def.handlers, def.descriptors, freshIdentity);

// ── workflow — keyed; one durable run per key ──────────────────────────────

/** A workflow definition is structurally a definition; the kind differs in identity. */
export type WorkflowDefinition<Name extends string, H extends Handlers> = ServiceDefinition<Name, H>;

export interface WorkflowConfig<Name extends string, H extends Handlers> {
  readonly name: Name;
  readonly handlers: H;
  readonly descriptors?: Partial<Record<keyof H, HandlerDescriptor>>;
  /**
   * Derives the run key from a handler's input. Same key → same durable run
   * (one-run-per-key). Default: the input itself if a string, else its JSON form.
   * Must be deterministic.
   */
  readonly key?: (input: any) => string;
}

const defaultKey = (input: unknown): string =>
  typeof input === "string" ? input : JSON.stringify(input);

/**
 * Define a keyed durable workflow — one primary run per key. Unlike `service`
 * (fresh per call), invoking a workflow handler with the same key resolves to the
 * same durable execution by default.
 */
export const workflow = <const Name extends string, H extends Handlers>(
  def: WorkflowConfig<Name, H>,
): WorkflowDefinition<Name, H> => {
  const keyFn = def.key ?? defaultKey;
  const keyedIdentity: IdentityFn = (input, options) => options?.idempotencyKey ?? keyFn(input);
  return compileDefinition(def.name, def.handlers, def.descriptors, keyedIdentity);
};
