import { Effect, Schema, type Exit } from "effect";
import * as Workflow from "effect/unstable/workflow/Workflow";

export const WorkflowStarted = Schema.TaggedStruct("WorkflowStarted", {
  schemaVersion: Schema.Literal(1),
  workflowName: Schema.String,
  executionId: Schema.String,
  parentWorkflowName: Schema.optional(Schema.String),
  parentExecutionId: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  createdAtMillis: Schema.Number,
});
export type WorkflowStarted = typeof WorkflowStarted.Type;

export const OwnerClaimed = Schema.TaggedStruct("OwnerClaimed", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  runnerId: Schema.String,
  claimedAtMillis: Schema.Number,
  expiresAtMillis: Schema.Number,
});
export type OwnerClaimed = typeof OwnerClaimed.Type;

export const WorkflowCompleted = Schema.TaggedStruct("WorkflowCompleted", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  result: Schema.Unknown,
  createdAtMillis: Schema.Number,
});
export type WorkflowCompleted = typeof WorkflowCompleted.Type;

export const WorkflowSuspended = Schema.TaggedStruct("WorkflowSuspended", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  result: Schema.Unknown,
  createdAtMillis: Schema.Number,
});
export type WorkflowSuspended = typeof WorkflowSuspended.Type;

export const WorkflowInterrupted = Schema.TaggedStruct("WorkflowInterrupted", {
  schemaVersion: Schema.Literal(1),
  unsafe: Schema.Boolean,
  createdAtMillis: Schema.Number,
});
export type WorkflowInterrupted = typeof WorkflowInterrupted.Type;

export const WorkflowResumed = Schema.TaggedStruct("WorkflowResumed", {
  schemaVersion: Schema.Literal(1),
  createdAtMillis: Schema.Number,
});
export type WorkflowResumed = typeof WorkflowResumed.Type;

export const ActivityCompleted = Schema.TaggedStruct("ActivityCompleted", {
  schemaVersion: Schema.Literal(1),
  ownerEpoch: Schema.String,
  activityId: Schema.String,
  exit: Schema.Unknown,
  createdAtMillis: Schema.Number,
});
export type ActivityCompleted = typeof ActivityCompleted.Type;

export const DeferredCompleted = Schema.TaggedStruct("DeferredCompleted", {
  schemaVersion: Schema.Literal(1),
  deferredName: Schema.String,
  exit: Schema.Unknown,
  createdAtMillis: Schema.Number,
});
export type DeferredCompleted = typeof DeferredCompleted.Type;

export const ClockScheduled = Schema.TaggedStruct("ClockScheduled", {
  schemaVersion: Schema.Literal(1),
  clockName: Schema.String,
  deferredName: Schema.String,
  wakeAtMillis: Schema.Number,
  createdAtMillis: Schema.Number,
});
export type ClockScheduled = typeof ClockScheduled.Type;

const SnapshotEntry = Schema.Tuple([Schema.String, Schema.Unknown]);

export const SnapshotTaken = Schema.TaggedStruct("SnapshotTaken", {
  schemaVersion: Schema.Literal(1),
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  activities: Schema.Array(SnapshotEntry),
  deferreds: Schema.Array(SnapshotEntry),
  clocks: Schema.Array(SnapshotEntry),
  interrupted: Schema.Boolean,
  unsafeInterrupted: Schema.Boolean,
  suspended: Schema.Boolean,
  takenAtMillis: Schema.Number,
});
export type SnapshotTaken = typeof SnapshotTaken.Type;

export const ExecutionRecord = Schema.Union([
  WorkflowStarted,
  OwnerClaimed,
  WorkflowCompleted,
  WorkflowSuspended,
  WorkflowInterrupted,
  WorkflowResumed,
  ActivityCompleted,
  DeferredCompleted,
  ClockScheduled,
  SnapshotTaken,
]);
export type ExecutionRecord = typeof ExecutionRecord.Type;

export interface SequencedRecord {
  readonly seqNum: number;
  readonly record: ExecutionRecord;
}

export const ExecutionRecordJson = Schema.fromJsonString(Schema.toCodecJson(ExecutionRecord));

export const encodeRecord = (record: ExecutionRecord): Effect.Effect<string> =>
  Schema.encodeUnknownEffect(ExecutionRecordJson)(record).pipe(Effect.orDie);
export const decodeRecord = (record: string): Effect.Effect<ExecutionRecord> =>
  Schema.decodeUnknownEffect(ExecutionRecordJson)(record).pipe(Effect.orDie);

const AnyOrVoid = Schema.Union([Schema.Void, Schema.Any]);
const GenericWorkflowResultJson = Schema.toCodecJson(
  Workflow.Result({ success: AnyOrVoid, error: AnyOrVoid }),
);
const GenericActivityExitJson = Schema.toCodecJson(
  Schema.Exit(GenericWorkflowResultJson, Schema.Never, Schema.Defect),
);
const GenericExitJson = Schema.toCodecJson(Schema.Exit(AnyOrVoid, AnyOrVoid, Schema.Defect));

type Encoder<A> = (value: A) => Effect.Effect<unknown>;
type Decoder<A> = (value: unknown) => Effect.Effect<A>;

export const encodeWorkflowResult = (
  workflow: Workflow.Any,
  result: Workflow.Result<unknown, unknown>,
): Effect.Effect<unknown> => {
  const encode = Schema.encodeUnknownEffect(
    Schema.toCodecJson(
      Workflow.Result({
        success: workflow.successSchema,
        error: workflow.errorSchema,
      }),
    ),
  ) as unknown as Encoder<Workflow.Result<unknown, unknown>>;
  return encode(result).pipe(Effect.orDie);
};

export const decodeWorkflowResult = (
  workflow: Workflow.Any,
  value: unknown,
): Effect.Effect<Workflow.Result<unknown, unknown>> => {
  const decode = Schema.decodeUnknownEffect(
    Schema.toCodecJson(
      Workflow.Result({
        success: workflow.successSchema,
        error: workflow.errorSchema,
      }),
    ),
  ) as unknown as Decoder<Workflow.Result<unknown, unknown>>;
  return decode(value).pipe(Effect.orDie);
};

export const encodeActivityExit = (
  exit: Exit.Exit<Workflow.Result<unknown, unknown>, never>,
): Effect.Effect<unknown> =>
  Schema.encodeUnknownEffect(GenericActivityExitJson)(exit).pipe(Effect.orDie);

export const decodeActivityExit = (
  value: unknown,
): Effect.Effect<Exit.Exit<Workflow.Result<unknown, unknown>, never>> =>
  Schema.decodeUnknownEffect(GenericActivityExitJson)(value).pipe(Effect.orDie) as Effect.Effect<
    Exit.Exit<Workflow.Result<unknown, unknown>, never>
  >;

export const encodeDeferredExit = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<unknown> =>
  Schema.encodeUnknownEffect(GenericExitJson)(exit).pipe(Effect.orDie);

export const decodeDeferredExit = (value: unknown): Effect.Effect<Exit.Exit<unknown, unknown>> =>
  Schema.decodeUnknownEffect(GenericExitJson)(value).pipe(Effect.orDie) as Effect.Effect<
    Exit.Exit<unknown, unknown>
  >;

export const encodeWorkflowPayload = (
  workflow: Workflow.Any,
  payload: object,
): Effect.Effect<unknown> => {
  const encode = Schema.encodeUnknownEffect(
    Schema.toCodecJson(workflow.payloadSchema),
  ) as unknown as Encoder<object>;
  return encode(payload).pipe(Effect.orDie);
};

export const decodeWorkflowPayload = (
  workflow: Workflow.Any,
  payload: unknown,
): Effect.Effect<object> => {
  const decode = Schema.decodeUnknownEffect(
    Schema.toCodecJson(workflow.payloadSchema),
  ) as unknown as Decoder<object>;
  return decode(payload).pipe(Effect.orDie);
};
