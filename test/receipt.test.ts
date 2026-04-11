import { describe, expect, test } from "effect-bun-test";
import {
  Defect,
  Failure,
  Interrupted,
  Pending,
  Success,
  Suspended,
  isFailure,
  isPending,
  isSuccess,
  isSuspended,
  isTerminal,
  makeExecId,
} from "../src/receipt.js";

describe("ExecId", () => {
  test("is a branded string", () => {
    const execId = makeExecId("Process:my-key");
    expect(typeof execId).toBe("string");
    expect(execId).toBe("Process:my-key");
  });

  test("duplicate keys produce identical strings", () => {
    const r1 = makeExecId("Place:pk-123");
    const r2 = makeExecId("Place:pk-123");
    expect(r1).toBe(r2);
  });
});

describe("PeekResult", () => {
  test("Pending is the initial state", () => {
    expect(isPending(Pending)).toBe(true);
    expect(isTerminal(Pending)).toBe(false);
  });

  test("Success carries decoded value", () => {
    const result = Success(42);
    expect(isSuccess(result)).toBe(true);
    expect(result._tag).toBe("Success");
    if (isSuccess(result)) {
      expect(result.value).toBe(42);
    }
    expect(isTerminal(result)).toBe(true);
  });

  test("Failure carries decoded error", () => {
    const result = Failure({ code: "NOT_FOUND" });
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error).toEqual({ code: "NOT_FOUND" });
    }
    expect(isTerminal(result)).toBe(true);
  });

  test("Interrupted is terminal", () => {
    expect(Interrupted._tag).toBe("Interrupted");
    expect(isTerminal(Interrupted)).toBe(true);
  });

  test("Defect carries cause", () => {
    const result = Defect("kaboom");
    expect(result._tag).toBe("Defect");
    if (result._tag === "Defect") {
      expect(result.cause).toBe("kaboom");
    }
    expect(isTerminal(result)).toBe(true);
  });

  test("Suspended is not terminal", () => {
    expect(isSuspended(Suspended)).toBe(true);
    expect(isTerminal(Suspended)).toBe(false);
  });
});
