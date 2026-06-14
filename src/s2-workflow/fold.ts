import { Option } from "effect";
import type {
  ActivityCompleted,
  ClockScheduled,
  DeferredCompleted,
  ExecutionRecord,
  OwnerClaimed,
  SequencedRecord,
  WorkflowCompleted,
  WorkflowStarted,
  WorkflowSuspended,
} from "./records.js";

export type ResultRecord = WorkflowCompleted | WorkflowSuspended;

export interface FoldedExecution {
  readonly tailSeqNum: number;
  readonly started: Option.Option<WorkflowStarted>;
  readonly owner: Option.Option<OwnerClaimed>;
  readonly result: Option.Option<ResultRecord>;
  readonly activities: ReadonlyMap<string, ActivityCompleted>;
  readonly deferreds: ReadonlyMap<string, DeferredCompleted>;
  readonly clocks: ReadonlyMap<string, ClockScheduled>;
  readonly interrupted: boolean;
  readonly unsafeInterrupted: boolean;
  readonly suspended: boolean;
}

const empty = (tailSeqNum: number): FoldedExecution => ({
  tailSeqNum,
  started: Option.none(),
  owner: Option.none(),
  result: Option.none(),
  activities: new Map(),
  deferreds: new Map(),
  clocks: new Map(),
  interrupted: false,
  unsafeInterrupted: false,
  suspended: false,
});

export const foldExecution = (
  records: ReadonlyArray<SequencedRecord>,
  nowMillis: number,
  tailSeqNum = (records[records.length - 1]?.seqNum ?? -1) + 1,
): FoldedExecution => {
  let folded = empty(tailSeqNum);
  const activities = new Map<string, ActivityCompleted>();
  const deferreds = new Map<string, DeferredCompleted>();
  const clocks = new Map<string, ClockScheduled>();

  for (const { record } of records) {
    switch (record._tag) {
      case "WorkflowStarted":
        if (Option.isNone(folded.started)) {
          folded = { ...folded, started: Option.some(record) };
        }
        break;
      case "OwnerClaimed":
        if (record.expiresAtMillis > nowMillis) {
          folded = { ...folded, owner: Option.some(record) };
        } else if (
          Option.isSome(folded.owner) &&
          folded.owner.value.ownerEpoch === record.ownerEpoch
        ) {
          folded = { ...folded, owner: Option.none() };
        }
        break;
      case "WorkflowCompleted":
        if (Option.isNone(folded.result) || folded.result.value._tag !== "WorkflowCompleted") {
          folded = {
            ...folded,
            result: Option.some(record),
            suspended: false,
          };
        }
        break;
      case "WorkflowSuspended":
        if (Option.isNone(folded.result)) {
          folded = {
            ...folded,
            result: Option.some(record),
            suspended: true,
          };
        }
        break;
      case "WorkflowInterrupted":
        folded = {
          ...folded,
          interrupted: true,
          unsafeInterrupted: folded.unsafeInterrupted || record.unsafe,
        };
        break;
      case "WorkflowResumed":
        if (Option.isSome(folded.result) && folded.result.value._tag === "WorkflowSuspended") {
          folded = { ...folded, result: Option.none(), suspended: false };
        }
        break;
      case "ActivityCompleted":
        if (!activities.has(record.activityId)) {
          activities.set(record.activityId, record);
        }
        break;
      case "DeferredCompleted":
        if (!deferreds.has(record.deferredName)) {
          deferreds.set(record.deferredName, record);
        }
        break;
      case "ClockScheduled":
        if (!clocks.has(record.clockName)) {
          clocks.set(record.clockName, record);
        }
        break;
      case "SnapshotTaken":
        activities.clear();
        deferreds.clear();
        clocks.clear();
        for (const [key, value] of record.activities) {
          activities.set(key, value as ActivityCompleted);
        }
        for (const [key, value] of record.deferreds) {
          deferreds.set(key, value as DeferredCompleted);
        }
        for (const [key, value] of record.clocks) {
          clocks.set(key, value as ClockScheduled);
        }
        folded = {
          ...folded,
          result:
            record.result === undefined
              ? Option.none()
              : Option.some(record.result as ResultRecord),
          interrupted: record.interrupted,
          unsafeInterrupted: record.unsafeInterrupted,
          suspended: record.suspended,
        };
        break;
    }
  }

  return {
    ...folded,
    activities,
    deferreds,
    clocks,
  };
};

export const activeOwner = (folded: FoldedExecution): Option.Option<OwnerClaimed> => folded.owner;

export const isTerminal = (result: ExecutionRecord | ResultRecord): boolean =>
  result._tag === "WorkflowCompleted";
