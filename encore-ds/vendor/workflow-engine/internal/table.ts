import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
  type DurableTableTagClass,
} from "../../durable-operators/index.ts"
import { RowOtelContextSchema } from "../../otel/row-otel.ts"

export interface WorkflowEngineDurableStateOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly headers?: DurableTableHeaders
  readonly workerId?: string
  readonly txTimeoutMs?: number
}

const WorkflowExecutionRowSchema = Schema.Struct({
  executionId: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  interrupted: Schema.Boolean,
  suspended: Schema.Boolean,
  cause: Schema.optional(Schema.Unknown),
  finalResult: Schema.optional(Schema.Unknown),
  // firegrid-row-otel-propagation.ROW_OTEL.1 — trace context captured at the
  // first `engine.execute` write; later `resume` calls (including cross-host
  // wake-ups) re-hydrate it as the parent of the workflow body span.
  _otel: Schema.optional(RowOtelContextSchema),
})
export type WorkflowExecutionRow = Schema.Schema.Type<typeof WorkflowExecutionRowSchema>

const WorkflowActivityRowSchema = Schema.Struct({
  activityKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  activityName: Schema.String,
  attempt: Schema.Number,
  result: Schema.Unknown,
})

const WorkflowActivityClaimRowSchema = Schema.Struct({
  claimKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  activityName: Schema.String,
  attempt: Schema.Number,
  workerId: Schema.String,
  claimedAtMs: Schema.Number,
})
export type WorkflowActivityClaimRow = Schema.Schema.Type<typeof WorkflowActivityClaimRowSchema>

const WorkflowDeferredRowSchema = Schema.Struct({
  deferredKey: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String,
  exit: Schema.Unknown,
})

const WorkflowClockWakeupRowSchema = Schema.Struct({
  clockKey: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  executionId: Schema.String,
  clockName: Schema.String,
  deferredName: Schema.String,
  deadlineMs: Schema.Number,
  // v4: multi-literal unions move from `Schema.Literal(a, b)` to `Schema.Literals([a, b])`.
  status: Schema.Literals(["pending", "fired"]),
})
export type WorkflowClockWakeupRow = Schema.Schema.Type<typeof WorkflowClockWakeupRowSchema>

const workflowEngineSchemas = {
  executions: WorkflowExecutionRowSchema,
  activities: WorkflowActivityRowSchema,
  activityClaims: WorkflowActivityClaimRowSchema,
  deferreds: WorkflowDeferredRowSchema,
  clockWakeups: WorkflowClockWakeupRowSchema,
} as const

// `DurableTable(namespace, schemas)` returns a value typed as
// `DurableTableTagClass<Schemas, Self=any>` — a `Context.Service` (no `new`
// constructor in the type) so it cannot be a bare `extends` target. Cast it to
// a constructor type whose `Self` is bound to this subclass, giving a
// `Context.Service`-style class that (a) is a value with the static `.layer`
// and (b) is usable as a bare type for the engine layer's requirements channel.
// This is the same dynamic-tag-class cast the DurableTable factory documents.
type WorkflowEngineTableBaseClass = DurableTableTagClass<
  typeof workflowEngineSchemas,
  WorkflowEngineTable
> & {
  new (_: never): DurableTableService<typeof workflowEngineSchemas>
}

const WorkflowEngineTableBase = DurableTable(
  "firegrid.workflow",
  workflowEngineSchemas,
  // eslint-disable-next-line local/no-launder-cast -- dynamic DurableTable tag-class → constructible Context.Service base
) as unknown as WorkflowEngineTableBaseClass

export class WorkflowEngineTable extends WorkflowEngineTableBase {}

export type WorkflowEngineTableService = DurableTableService<typeof workflowEngineSchemas>

export const workflowEngineTableLayerOptions = (
  options: WorkflowEngineDurableStateOptions,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: options.streamUrl,
    contentType: options.contentType ?? "application/json",
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  },
  txTimeoutMs: options.txTimeoutMs ?? 2_000,
})
