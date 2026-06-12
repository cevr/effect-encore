import { Cause, Exit, Option } from "effect";
import { Defect, Failure, Interrupted, Pending, type PeekResult, Success } from "./receipt.ts";

// Map a handler's Exit to a PeekResult. Cause-walking logic mirrors
// effect-encore's `mapExitToWorkflowPeekResult` (Effect 4 Cause API).
export const exitToOutcome = (exit: Exit.Exit<unknown, unknown>): PeekResult => {
  if (Exit.isSuccess(exit)) return Success(exit.value);
  const cause = exit.cause;
  const errorOpt = Cause.findErrorOption(cause);
  if (Option.isSome(errorOpt)) return Failure(errorOpt.value);
  const defectResult = Cause.findDefect(cause);
  if (defectResult._tag === "Success") return Defect(String(defectResult.success));
  const interruptResult = Cause.findInterrupt(cause);
  if (interruptResult._tag === "Success") return Interrupted;
  return Pending;
};

// The reply row stores the PeekResult shape as JSON. Success/Failure values are
// assumed JSON-serializable (the operation's success/error schemas). Defect is
// stringified at `exitToOutcome` time.
export const encodeOutcome = (result: PeekResult): string => JSON.stringify(result);

export const decodeOutcome = (encoded: string): PeekResult => JSON.parse(encoded) as PeekResult;
