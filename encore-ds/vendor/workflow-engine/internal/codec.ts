import { Workflow } from "effect/unstable/workflow"
import type { Effect } from "effect"
import { Cause, Exit, Schema } from "effect"

export const decodeWorkflowResult = (
  workflow: Workflow.Any,
  value: unknown,
): Effect.Effect<Workflow.Result<unknown, unknown>> =>
  // v4: `Schema.decodeUnknown` → `Schema.decodeUnknownEffect`. The engine
  // surfaces no schema error to upstream WorkflowEngine APIs, so the error/
  // services channels are erased to `never` (same as the v3 cast).
  Schema.decodeUnknownEffect(Workflow.Result({
    success: workflow.successSchema,
    error: workflow.errorSchema,
  }))(value) as Effect.Effect<Workflow.Result<unknown, unknown>>

export const encodeWorkflowResult = (
  workflow: Workflow.Any,
  value: Workflow.Result<unknown, unknown>,
): Effect.Effect<unknown> =>
  // v4: `Schema.encode` → `Schema.encodeUnknownEffect`. `encodeEffect` requires
  // the input to be exactly the schema's `Type` (the `Union` of Complete |
  // Suspended, which TS won't infer through the erased `Result<unknown,unknown>`);
  // `encodeUnknownEffect` accepts `unknown` input, matching the v3 `as never` cast.
  Schema.encodeUnknownEffect(Workflow.Result({
    success: workflow.successSchema,
    error: workflow.errorSchema,
  }))(value) as Effect.Effect<unknown>

const reviveCause = (value: unknown): Cause.Cause<unknown> => {
  const record = value as { _tag?: string; failure?: unknown; defect?: unknown }
  if (record?._tag === "Fail") return Cause.fail(record.failure)
  if (record?._tag === "Die") return Cause.die(record.defect)
  return value as Cause.Cause<unknown>
}

export const reviveExit = (value: unknown): Exit.Exit<unknown, unknown> => {
  const record = value as { _tag?: string; value?: unknown }
  if (record?._tag === "Success") return Exit.succeed(record.value)
  if (record?._tag === "Failure") {
    return Exit.failCause(reviveCause((record as { cause?: unknown }).cause))
  }
  return value as Exit.Exit<unknown, unknown>
}

export const reviveEncodedResult = (value: unknown): Workflow.Result<unknown, unknown> => {
  const record = value as { _tag?: string; exit?: unknown }
  if (record._tag === "Suspended") {
    return new Workflow.Suspended({})
  }
  if (record._tag === "Complete") {
    return new Workflow.Complete({ exit: reviveExit(record.exit) })
  }
  return value as Workflow.Result<unknown, unknown>
}
