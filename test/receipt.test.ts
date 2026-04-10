import { describe, expect, it } from "bun:test";
import {
  Defect,
  Failure,
  Interrupted,
  Pending,
  Success,
  isFailure,
  isPending,
  isSuccess,
  isTerminal,
  makeCastReceipt,
} from "../src/receipt.js";

describe("CastReceipt", () => {
  it("is serializable — roundtrips through JSON", () => {
    const receipt = makeCastReceipt({
      actorType: "MyActor",
      entityId: "e-1",
      operation: "DoWork",
      primaryKey: "pk-1",
    });

    const json = JSON.stringify(receipt);
    const parsed = JSON.parse(json);
    expect(parsed._tag).toBe("CastReceipt");
    expect(parsed.actorType).toBe("MyActor");
    expect(parsed.entityId).toBe("e-1");
    expect(parsed.operation).toBe("DoWork");
    expect(parsed.primaryKey).toBe("pk-1");
  });

  it("carries actorType, entityId, operation, primaryKey", () => {
    const receipt = makeCastReceipt({
      actorType: "Order",
      entityId: "ord-123",
      operation: "Validate",
      primaryKey: "key-abc",
    });

    expect(receipt._tag).toBe("CastReceipt");
    expect(receipt.actorType).toBe("Order");
    expect(receipt.entityId).toBe("ord-123");
    expect(receipt.operation).toBe("Validate");
    expect(receipt.primaryKey).toBe("key-abc");
  });

  it("duplicate primaryKey produces identical receipt fields", () => {
    const r1 = makeCastReceipt({
      actorType: "Order",
      entityId: "ord-1",
      operation: "Place",
      primaryKey: "pk-123",
    });
    const r2 = makeCastReceipt({
      actorType: "Order",
      entityId: "ord-1",
      operation: "Place",
      primaryKey: "pk-123",
    });
    expect(r1.actorType).toBe(r2.actorType);
    expect(r1.entityId).toBe(r2.entityId);
    expect(r1.operation).toBe(r2.operation);
    expect(r1.primaryKey).toBe(r2.primaryKey);
  });
});

describe("PeekResult", () => {
  it("Pending is the initial state", () => {
    expect(isPending(Pending)).toBe(true);
    expect(isTerminal(Pending)).toBe(false);
  });

  it("Success carries decoded value", () => {
    const result = Success(42);
    expect(isSuccess(result)).toBe(true);
    expect(result._tag).toBe("Success");
    if (isSuccess(result)) {
      expect(result.value).toBe(42);
    }
    expect(isTerminal(result)).toBe(true);
  });

  it("Failure carries decoded error", () => {
    const result = Failure({ code: "NOT_FOUND" });
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error).toEqual({ code: "NOT_FOUND" });
    }
    expect(isTerminal(result)).toBe(true);
  });

  it("Interrupted is terminal", () => {
    expect(Interrupted._tag).toBe("Interrupted");
    expect(isTerminal(Interrupted)).toBe(true);
  });

  it("Defect carries cause", () => {
    const result = Defect("kaboom");
    expect(result._tag).toBe("Defect");
    if (result._tag === "Defect") {
      expect(result.cause).toBe("kaboom");
    }
    expect(isTerminal(result)).toBe(true);
  });
});

// Actor.peek tests moved to test/peek.test.ts
