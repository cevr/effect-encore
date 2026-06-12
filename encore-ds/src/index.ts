// encore-ds — declarative actors on DurableTable + Durable Streams.
// Public surface (entity half). The workflow half wires onto
// DurableStreamsWorkflowEngine — see task #6.

export * as Actor from "./actor.ts";
export { EncoreConfig, type EncoreConfigShape } from "./config.ts";
export {
  type ExecId,
  makeExecId,
  parseExecId,
  type PeekResult,
  type ExecIdParts,
  isPending,
  isSuccess,
  isFailure,
  isSuspended,
  isTerminal,
  Pending,
  Success,
  Failure,
  Interrupted,
  Defect,
  Suspended,
} from "./receipt.ts";
export { CANCEL_TAG } from "./mailbox.ts";
export type { EntityIdReturn } from "./addressing.ts";
export { actorStreamUrl } from "./addressing.ts";

// Workflow half — adapter over DurableStreamsWorkflowEngine.
export {
  fromWorkflow,
  workflowEngineLayer,
  type WorkflowActor,
  type WorkflowDef,
} from "./workflow.ts";
export {
  makeSignal,
  makeStepContext,
  type WorkflowSignal,
  type WorkflowStepContext,
  type SignalDef,
  type SignalDefs,
  type StepRunOptions,
} from "./step.ts";
