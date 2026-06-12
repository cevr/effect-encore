/* eslint-disable @typescript-eslint/no-explicit-any -- workflow payload/schema types are erased at the adapter boundary */
import { Duration, Effect, type Layer, Option, Schedule, type Schema, Stream } from "effect";
import { Workflow as UpstreamWorkflow } from "effect/unstable/workflow";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import { DurableStreamsWorkflowEngine } from "../vendor/workflow-engine/durable-streams-workflow-engine.ts";
import { exitToOutcome } from "./outcome.ts";
import {
  type ExecId,
  isTerminal,
  makeExecId,
  type PeekResult,
  Pending,
  Suspended,
} from "./receipt.ts";
import {
  makeSignal,
  makeStepContext,
  type SignalDefs,
  type WorkflowSignal,
  type WorkflowStepContext,
} from "./step.ts";

// ─────────────────────────────────────────────────────────────────────────
// workflow.ts — authoring-DSL adapter over DurableStreamsWorkflowEngine.
//
// Per design invariant 8: the engine ALREADY implements the upstream
// effect/unstable/workflow WorkflowEngine (durable execution on DurableTable).
// We do not write a second engine. fromWorkflow compiles encore's declarative
// def into an upstream Workflow.make and exposes the encore surface
// (execute/send/peek/watch/waitFor/interrupt/resume + signals + step DSL).
// ─────────────────────────────────────────────────────────────────────────

/** Provide the durable workflow engine for a given Durable Streams URL.
 *  Re-export of the vendored engine's public composition surface. */
export const workflowEngineLayer = (options: { readonly streamUrl: string }) =>
  DurableStreamsWorkflowEngine.layer(options);

export interface WorkflowDef<
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Signals extends SignalDefs,
> {
  readonly payload: Payload;
  /** Deterministic idempotency key (workflow id is string-only). */
  readonly id: (payload: Schema.Struct.Type<Payload>) => string;
  readonly success?: Success;
  readonly error?: Error;
  readonly signals?: Signals;
  readonly captureDefects?: boolean;
  readonly suspendOnFailure?: boolean;
  readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown>;
}

type PayloadIn<Payload extends Schema.Struct.Fields> = Schema.Struct.Type<Payload>;

export interface WorkflowActor<
  Name extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
> {
  readonly name: Name;
  readonly workflow: UpstreamWorkflow.Workflow<Name, Schema.Struct<Payload>, Success, Error>;

  readonly execute: (
    payload: PayloadIn<Payload>,
  ) => Effect.Effect<Success["Type"], Error["Type"], WorkflowEngine>;
  readonly send: (
    payload: PayloadIn<Payload>,
  ) => Effect.Effect<ExecId<Success["Type"], Error["Type"]>, never, WorkflowEngine>;
  readonly executionId: (
    payload: PayloadIn<Payload>,
  ) => Effect.Effect<ExecId<Success["Type"], Error["Type"]>>;
  readonly peek: (
    payload: PayloadIn<Payload>,
  ) => Effect.Effect<PeekResult<Success["Type"], Error["Type"]>, never, WorkflowEngine>;
  readonly watch: (
    payload: PayloadIn<Payload>,
    options?: { readonly interval?: Duration.Input },
  ) => Stream.Stream<PeekResult<Success["Type"], Error["Type"]>, never, WorkflowEngine>;
  readonly waitFor: (
    payload: PayloadIn<Payload>,
  ) => Effect.Effect<PeekResult<Success["Type"], Error["Type"]>, never, WorkflowEngine>;
  readonly interrupt: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
  readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;

  /** Register the workflow body. The handler receives the payload and a step
   *  context (step.run/sleep/race/undo). Provide with `workflowEngineLayer`. */
  readonly toLayer: <R>(
    handler: (
      payload: PayloadIn<Payload>,
      ctx: WorkflowStepContext<Error>,
    ) => Effect.Effect<Success["Type"], Error["Type"], R>,
  ) => Layer.Layer<never, never, WorkflowEngine | Exclude<R, any>>;
}

type RawPeek<Success extends Schema.Top, Error extends Schema.Top> = PeekResult<
  Success["Type"],
  Error["Type"]
>;

export const fromWorkflow = <
  const Name extends string,
  const Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  const Signals extends SignalDefs = {},
>(
  name: Name,
  def: WorkflowDef<Payload, Success, Error, Signals>,
): WorkflowActor<Name, Payload, Success, Error> & {
  readonly [K in keyof Signals]: WorkflowSignal<Schema.Struct<Payload>, any, any>;
} => {
  const options: Record<string, unknown> = { payload: def.payload, idempotencyKey: def.id };
  if (def.success) options["success"] = def.success;
  if (def.error) options["error"] = def.error;
  if (def.suspendedRetrySchedule) options["suspendedRetrySchedule"] = def.suspendedRetrySchedule;

  let wf = (UpstreamWorkflow.make as (n: string, o: unknown) => UpstreamWorkflow.Workflow<
    Name,
    Schema.Struct<Payload>,
    Success,
    Error
  >)(name, options);
  if (def.captureDefects !== undefined)
    wf = wf.annotate(UpstreamWorkflow.CaptureDefects, def.captureDefects);
  if (def.suspendOnFailure !== undefined)
    wf = wf.annotate(UpstreamWorkflow.SuspendOnFailure, def.suspendOnFailure);

  const signals: Record<string, WorkflowSignal<any, any, any>> = {};
  for (const [sigName, sigDef] of Object.entries(def.signals ?? {})) {
    signals[sigName] = makeSignal(wf as any, sigName, sigDef);
  }

  // The Success/Error decoding services are erased here — for plain schemas
  // they are `never`; the cast keeps the public peek/watch/waitFor requirement
  // channel at `WorkflowEngine` only.
  const peekById = (
    executionId: string,
  ): Effect.Effect<RawPeek<Success, Error>, never, WorkflowEngine> =>
    Effect.map(wf.poll(executionId), (opt): RawPeek<Success, Error> => {
      if (Option.isNone(opt)) return Pending as RawPeek<Success, Error>;
      const result = opt.value;
      if (result._tag === "Suspended") return Suspended as RawPeek<Success, Error>;
      return exitToOutcome(result.exit) as RawPeek<Success, Error>;
    }) as Effect.Effect<RawPeek<Success, Error>, never, WorkflowEngine>;

  const execIdFor = (payload: PayloadIn<Payload>) => wf.executionId(payload as never);

  return {
    ...signals,
    name,
    workflow: wf,

    execute: (payload) => wf.execute(payload as never) as Effect.Effect<any, any, WorkflowEngine>,

    send: (payload) =>
      Effect.map(wf.execute(payload as never, { discard: true }), (id) =>
        makeExecId(id),
      ) as Effect.Effect<ExecId<Success["Type"], Error["Type"]>, never, WorkflowEngine>,

    executionId: (payload) => Effect.map(execIdFor(payload), (id) => makeExecId(id)),

    peek: (payload) => Effect.flatMap(execIdFor(payload), peekById),

    watch: (payload, opts) => {
      const interval = opts?.interval ?? Duration.millis(200);
      return Stream.unwrap(
        Effect.map(execIdFor(payload), (executionId) =>
          Stream.fromEffectSchedule(peekById(executionId), Schedule.spaced(interval)).pipe(
            Stream.takeUntil((r) => isTerminal(r)),
          ),
        ),
      );
    },

    waitFor: (payload) =>
      Effect.flatMap(execIdFor(payload), (executionId) =>
        peekById(executionId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(100)),
            until: (r: RawPeek<Success, Error>) => isTerminal(r),
          }),
        ),
      ),

    interrupt: (executionId) => wf.interrupt(executionId),
    resume: (executionId) => wf.resume(executionId),

    toLayer: ((handler: any) =>
      wf.toLayer((payload: any, executionId: string) =>
        handler(payload, makeStepContext(wf as any, executionId)),
      )) as WorkflowActor<Name, Payload, Success, Error>["toLayer"],
  } as WorkflowActor<Name, Payload, Success, Error> & {
    readonly [K in keyof Signals]: WorkflowSignal<Schema.Struct<Payload>, any, any>;
  };
};
