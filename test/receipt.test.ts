import { describe, expect, test } from "effect-bun-test";
import { Schema } from "effect";
import {
  Defect,
  ExecIdCodec,
  Failure,
  Interrupted,
  Pending,
  PeekResultSchema,
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
    expect(String(execId)).toBe("Process:my-key");
  });

  test("duplicate keys produce identical strings", () => {
    const r1 = makeExecId("Place:pk-123");
    const r2 = makeExecId("Place:pk-123");
    expect(r1).toBe(r2);
  });

  test("ExecIdCodec.encode mints the frozen \\x00-joined wire format", () => {
    const execId = ExecIdCodec.encode({
      entityId: "Order",
      tag: "Place",
      primaryKey: "pk-123",
    });
    expect(String(execId)).toBe("Order\x00Place\x00pk-123");
  });

  test("ExecIdCodec round-trips a 3-tuple", () => {
    const components = { entityId: "Order", tag: "Place", primaryKey: "pk-123" };
    expect(ExecIdCodec.decode(ExecIdCodec.encode(components))).toEqual(components);
  });

  test("ExecIdCodec.decode collapses a single-segment workflow id", () => {
    const execId = "exec-42";
    expect(ExecIdCodec.decode(execId)).toEqual({
      entityId: execId,
      tag: execId,
      primaryKey: execId,
    });
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

describe("PeekResultSchema", () => {
  const schema = PeekResultSchema(Schema.String, Schema.Number);
  const encode = Schema.encodeSync(schema);
  const decode = Schema.decodeUnknownSync(schema);

  test("round-trips Pending", () => {
    const value = { _tag: "Pending" as const };
    expect(decode(encode(value))).toEqual(value);
  });

  test("round-trips Success", () => {
    const value = { _tag: "Success" as const, value: "hello" };
    expect(decode(encode(value))).toEqual(value);
  });

  test("round-trips Failure", () => {
    const value = { _tag: "Failure" as const, error: 42 };
    expect(decode(encode(value))).toEqual(value);
  });

  test("round-trips Interrupted", () => {
    const value = { _tag: "Interrupted" as const };
    expect(decode(encode(value))).toEqual(value);
  });

  test("round-trips Defect", () => {
    const value = { _tag: "Defect" as const, cause: "kaboom" };
    expect(decode(encode(value))).toEqual(value);
  });

  test("round-trips Suspended", () => {
    const value = { _tag: "Suspended" as const };
    expect(decode(encode(value))).toEqual(value);
  });

  test("rejects unknown _tag", () => {
    expect(() => decode({ _tag: "Unknown" } as unknown)).toThrow();
  });
});
