import { describe, expect, test } from "effect-bun-test";
import { Effect, Exit, Schema } from "effect";
import type { RpcMessage } from "effect/unstable/rpc";
import type { MessageStorage } from "effect/unstable/cluster";
import {
  Defect,
  decodeValue,
  defaultReplySource,
  ExecIdCodec,
  Failure,
  Interrupted,
  mapExitToPeekResult,
  mapExitToWorkflowPeekResult,
  Pending,
  PeekResultSchema,
  type PeekResult,
  ReplySource,
  ReplySourceLayer,
  type ReplySourceShape,
  Success,
  Suspended,
  isFailure,
  isPending,
  isSuccess,
  isSuspended,
  isTerminal,
  makeExecId,
} from "../src/receipt.js";
import type { ActorAddressResolver } from "../src/actor-address-resolver.js";

class OrderError extends Schema.TaggedErrorClass<OrderError>()("OrderError", {
  message: Schema.String,
}) {}

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
  const schema = PeekResultSchema(Schema.String, Schema.Finite);
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

describe("decodeValue", () => {
  test("returns the raw value when no schema is given", () => {
    expect(Effect.runSync(decodeValue(undefined, { item: "widget" }))).toEqual({
      item: "widget",
    });
  });

  test("decodes through the schema when it succeeds", () => {
    expect(Effect.runSync(decodeValue(Schema.String, "hello"))).toBe("hello");
  });

  test("falls back to the raw value when the schema rejects it", () => {
    // best-effort typed view: a decode failure surfaces the raw wire value,
    // it does NOT throw (the reply was already validated on the wire).
    expect(Effect.runSync(decodeValue(Schema.Finite, "not-a-number"))).toBe("not-a-number");
  });
});

describe("mapExitToPeekResult (entity — encoded ExitEncoded)", () => {
  const run = (
    exit: RpcMessage.ExitEncoded<unknown, unknown>,
    def?: Parameters<typeof mapExitToPeekResult>[1],
  ) => Effect.runSync(mapExitToPeekResult(exit, def));

  test("Success decodes the value through def.success", () => {
    const result = run({ _tag: "Success", value: "42" }, { success: Schema.String });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.value).toBe("42");
  });

  test("Success without a def passes the raw value", () => {
    const result = run({ _tag: "Success", value: { item: "widget" } });
    expect(result).toEqual(Success({ item: "widget" }));
  });

  test("Failure (Fail cause) decodes the error through def.error", () => {
    const result = run(
      {
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: "OrderError", message: "boom" } }],
      },
      { error: OrderError },
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.error).toBeInstanceOf(OrderError);
      expect((result.error as OrderError).message).toBe("boom");
    }
  });

  test("Die cause maps to Defect", () => {
    const result = run({ _tag: "Failure", cause: [{ _tag: "Die", defect: "kaboom" }] });
    expect(result).toEqual(Defect("kaboom"));
  });

  test("Interrupt cause maps to Interrupted", () => {
    const result = run({ _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] });
    expect(result._tag).toBe("Interrupted");
  });

  test("empty cause maps to Pending", () => {
    const result = run({ _tag: "Failure", cause: [] });
    expect(result._tag).toBe("Pending");
  });
});

describe("mapExitToWorkflowPeekResult (workflow — real Exit.Exit)", () => {
  test("Success carries the value", () => {
    expect(mapExitToWorkflowPeekResult(Exit.succeed("done"))).toEqual(Success("done"));
  });

  test("Fail maps to Failure", () => {
    const err = OrderError.make({ message: "boom" });
    const result = mapExitToWorkflowPeekResult(Exit.fail(err));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.error).toBe(err);
  });

  test("Die maps to Defect", () => {
    const result = mapExitToWorkflowPeekResult(Exit.die("kaboom"));
    expect(result._tag).toBe("Defect");
    if (result._tag === "Defect") expect(result.cause).toBe("kaboom");
  });

  test("Interrupt maps to Interrupted", () => {
    expect(mapExitToWorkflowPeekResult(Exit.interrupt(1))._tag).toBe("Interrupted");
  });
});

describe("entity vs workflow Exit-classification parity", () => {
  // The two await paths classify the same logical outcome identically: the
  // entity path off an encoded ExitEncoded, the workflow path off a real Exit.
  test("Success → Success on both paths", () => {
    const entity = Effect.runSync(mapExitToPeekResult({ _tag: "Success", value: 7 }));
    const workflow = mapExitToWorkflowPeekResult(Exit.succeed(7));
    expect(entity._tag).toBe("Success");
    expect(workflow._tag).toBe("Success");
  });

  test("Die → Defect on both paths", () => {
    const entity = Effect.runSync(
      mapExitToPeekResult({ _tag: "Failure", cause: [{ _tag: "Die", defect: "x" }] }),
    );
    const workflow = mapExitToWorkflowPeekResult(Exit.die("x"));
    expect(entity._tag).toBe("Defect");
    expect(workflow._tag).toBe("Defect");
  });

  test("Interrupt → Interrupted on both paths", () => {
    const entity = Effect.runSync(
      mapExitToPeekResult({ _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 0 }] }),
    );
    const workflow = mapExitToWorkflowPeekResult(Exit.interrupt(0));
    expect(entity._tag).toBe("Interrupted");
    expect(workflow._tag).toBe("Interrupted");
  });
});

// Pin the default adapter's requirements (Risk #2): the storage-backed peek
// must keep requiring exactly MessageStorage + ActorAddressResolver, so the
// actor layers still satisfy it after the lift. This is a compile-time
// assertion — if `defaultReplySource.peek`'s R-channel drifts, `tsgo` fails.
const _replySourcePeekRChannel: ReplySourceShape["peek"] = defaultReplySource.peek;
type _PeekRIsStorageAndResolver =
  ReturnType<ReplySourceShape["peek"]> extends Effect.Effect<
    PeekResult,
    infer _E,
    MessageStorage.MessageStorage | ActorAddressResolver
  >
    ? true
    : never;
const _peekRChannelCheck: _PeekRIsStorageAndResolver = true;
void _replySourcePeekRChannel;
void _peekRChannelCheck;

describe("ReplySource seam", () => {
  test("exposes a default fromMessageStorage adapter Layer", () => {
    expect(ReplySourceLayer.fromMessageStorage).toBeDefined();
  });

  test("the Tag is a Context.Service identifier", () => {
    expect(ReplySource.key).toBe("effect-encore/receipt/ReplySource");
  });
});
