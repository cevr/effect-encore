import { WorkflowEngine } from "effect/unstable/workflow"
import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import type { DurableTableError } from "../durable-operators/index.ts"
import { makeWorkflowEngine } from "./internal/engine-runtime.ts"
import {
  type WorkflowEngineDurableStateOptions,
  WorkflowEngineTable,
  workflowEngineTableLayerOptions,
} from "./internal/table.ts"

export * from "./internal/table.ts"

const workerIdForOptions = (
  options: WorkflowEngineDurableStateOptions,
): string =>
  options.workerId ?? `worker:${options.streamUrl}`

const make = (
  options: WorkflowEngineDurableStateOptions,
): Effect.Effect<
  // v4: service value-type accessor `Tag["Type"]` → `Tag["Service"]`.
  WorkflowEngine.WorkflowEngine["Service"],
  DurableTableError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // workflow-engine-durable-state.ENGINE.4
    // workflow-engine-durable-state.ENGINE.5
    const table = yield* WorkflowEngineTable
    return yield* makeWorkflowEngine(
      table,
      workerIdForOptions(options),
    )
  }).pipe(
    Effect.provide(WorkflowEngineTable.layer(workflowEngineTableLayerOptions(options))),
  )

const layer = (
  options: WorkflowEngineDurableStateOptions,
): Layer.Layer<WorkflowEngine.WorkflowEngine | WorkflowEngineTable, DurableTableError> =>
  // v4: `Layer.scopedContext` → `Layer.effectContext` (the effect's `Scope` is
  // excluded from the layer's requirements by the constructor, same lifecycle).
  Layer.effectContext(
    Effect.gen(function* () {
      // workflow-engine-durable-state.ENGINE.1
      // workflow-engine-durable-state.ENGINE.4
      // workflow-engine-durable-state.ENGINE.5
      const table = yield* WorkflowEngineTable
      const engine = yield* makeWorkflowEngine(
        table,
        workerIdForOptions(options),
      )
      return Context.make(WorkflowEngineTable, table).pipe(
        Context.add(WorkflowEngine.WorkflowEngine, engine),
      ) as Context.Context<WorkflowEngine.WorkflowEngine | WorkflowEngineTable>
    }),
  ).pipe(
    Layer.provide(WorkflowEngineTable.layer(workflowEngineTableLayerOptions(options))),
  )

export const DurableStreamsWorkflowEngine = {
  make,
  layer,
}
