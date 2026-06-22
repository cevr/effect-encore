import { describe, expect, test } from "effect-bun-test";
import { ExecIdCodec, makeExecId } from "../src/receipt.js";

describe("ExecIdCodec", () => {
  describe("golden wire format", () => {
    test("encode produces the exact \\x00-joined byte layout", () => {
      const execId = ExecIdCodec.encode({
        entityId: "Order",
        tag: "Place",
        primaryKey: "pk-123",
      });
      expect(String(execId)).toBe("Order\x00Place\x00pk-123");
    });

    test("encode is byte-identical to the legacy inline template", () => {
      const entityId = "Order";
      const tag = "Place";
      const primaryKey = "pk-123";
      const legacy = makeExecId(`${entityId}\x00${tag}\x00${primaryKey}`);
      const codec = ExecIdCodec.encode({ entityId, tag, primaryKey });
      expect(String(codec)).toBe(String(legacy));
    });
  });

  describe("encode ∘ decode round-trip", () => {
    test("plain 3-tuple", () => {
      const components = { entityId: "Order", tag: "Place", primaryKey: "pk-123" };
      expect(ExecIdCodec.decode(ExecIdCodec.encode(components))).toEqual(components);
    });

    test("empty segments", () => {
      const components = { entityId: "", tag: "", primaryKey: "" };
      // empty execId has no separators → no-separator fallback, NOT a round-trip
      // of all-empty; pin the actual encoded form's decode instead.
      const encoded = ExecIdCodec.encode(components);
      expect(String(encoded)).toBe("\x00\x00");
      expect(ExecIdCodec.decode(encoded)).toEqual({
        entityId: "",
        tag: "",
        primaryKey: "",
      });
    });

    test("primaryKey containing a separator splits at the first two seps only", () => {
      // The decode slices primaryKey from after the SECOND separator to end, so a
      // primaryKey carrying its own \x00 survives intact.
      const components = {
        entityId: "Order",
        tag: "Place",
        primaryKey: "a\x00b\x00c",
      };
      expect(ExecIdCodec.decode(ExecIdCodec.encode(components))).toEqual(components);
    });

    test("segments with adjacent/embedded special chars", () => {
      const components = {
        entityId: "ent:with:colons",
        tag: "Tag-Name",
        primaryKey: "pk with spaces / and / slashes",
      };
      expect(ExecIdCodec.decode(ExecIdCodec.encode(components))).toEqual(components);
    });
  });

  describe("single-segment workflow id fallback", () => {
    test("a no-separator id decodes to entityId == tag == primaryKey", () => {
      const execId = "workflow-execution-id-abc";
      expect(ExecIdCodec.decode(execId)).toEqual({
        entityId: execId,
        tag: execId,
        primaryKey: execId,
      });
    });

    test("matches the workflow makeExecId(executionId) shape", () => {
      const executionId = "exec-42";
      const wfExecId = makeExecId(executionId);
      expect(ExecIdCodec.decode(String(wfExecId))).toEqual({
        entityId: executionId,
        tag: executionId,
        primaryKey: executionId,
      });
    });
  });

  describe("single-separator fallback (2-segment id)", () => {
    test("tag takes the remainder; primaryKey falls back to the whole id", () => {
      // No second separator: tag = everything after the first sep, primaryKey =
      // the whole execId. Pins the legacy parseExecId behavior verbatim.
      const execId = "Order\x00Place";
      expect(ExecIdCodec.decode(execId)).toEqual({
        entityId: "Order",
        tag: "Place",
        primaryKey: execId,
      });
    });
  });
});
