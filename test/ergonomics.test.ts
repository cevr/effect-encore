import { describe, expect, it, test } from "effect-bun-test";
import { Effect, Layer, Schema } from "effect";
import { ShardingConfig } from "effect/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

// ── Same-id ergonomics: execute / send / executionId all agree ─────────────

const SameIdActor = Actor.fromEntity("SameId", {
  Run: {
    payload: { key: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { key: string }) => p.key,
  },
});

const SameIdLayer = Layer.provide(
  Actor.toTestLayer(SameIdActor, {
    Run: ({ operation }) => Effect.succeed(`ran: ${operation.key}`),
  }),
  TestShardingConfig,
);

const sameTest = it.scopedLive.layer(SameIdLayer);

describe("ergonomics: execId derivation is consistent across surfaces", () => {
  sameTest("send(payload) and executionId(payload) produce identical execIds", () =>
    Effect.gen(function* () {
      const fromSend = yield* SameIdActor.Run.send({ key: "alpha" });
      const fromCompute = yield* SameIdActor.Run.executionId({ key: "alpha" });
      expect(String(fromSend)).toBe(String(fromCompute));
      expect(String(fromSend)).toBe("alpha\x00Run\x00alpha");
    }),
  );

  sameTest("different payloads produce different execIds for the same op", () =>
    Effect.gen(function* () {
      const a = yield* SameIdActor.Run.executionId({ key: "alpha" });
      const b = yield* SameIdActor.Run.executionId({ key: "beta" });
      expect(String(a)).not.toBe(String(b));
    }),
  );

  test("string-form id maps entityId === primaryKey for execId computation", () => {
    const a = Effect.runSync(SameIdActor.Run.executionId({ key: "k" }));
    expect(String(a)).toBe("k\x00Run\x00k");
  });
});

// ── Divergent id ergonomics: object-form id ────────────────────────────────

const DivergentActor = Actor.fromEntity("Divergent", {
  Trigger: {
    payload: { dedup: Schema.String, action: Schema.String },
    success: Schema.String,
    persisted: true,
    id: (p: { dedup: string; action: string }) => ({
      entityId: p.dedup,
      primaryKey: `${p.dedup}:${p.action}`,
    }),
  },
});

describe("ergonomics: divergent id (object-form) produces stable execIds", () => {
  test("same entityId + different primaryKey → different execIds", () => {
    const open = Effect.runSync(DivergentActor.Trigger.executionId({ dedup: "k", action: "open" }));
    const close = Effect.runSync(
      DivergentActor.Trigger.executionId({ dedup: "k", action: "close" }),
    );
    expect(String(open)).toBe("k\x00Trigger\x00k:open");
    expect(String(close)).toBe("k\x00Trigger\x00k:close");
    expect(String(open)).not.toBe(String(close));
  });

  test("same primaryKey + different entityId → different execIds (entity routing differs)", () => {
    const a = Effect.runSync(
      DivergentActor.Trigger.executionId({ dedup: "tenant-a", action: "open" }),
    );
    const b = Effect.runSync(
      DivergentActor.Trigger.executionId({ dedup: "tenant-b", action: "open" }),
    );
    expect(String(a)).toBe("tenant-a\x00Trigger\x00tenant-a:open");
    expect(String(b)).toBe("tenant-b\x00Trigger\x00tenant-b:open");
    expect(String(a)).not.toBe(String(b));
  });
});

// ── Per-op handle surface ──────────────────────────────────────────────────

describe("ergonomics: per-op handle surface", () => {
  test("handle exposes the full set of methods", () => {
    const h = SameIdActor.Run;
    expect(h._tag).toBe("OperationHandle");
    expect(h.name).toBe("Run");
    expect(h.execute).toBeTypeOf("function");
    expect(h.send).toBeTypeOf("function");
    expect(h.executionId).toBeTypeOf("function");
    expect(h.peek).toBeTypeOf("function");
    expect(h.watch).toBeTypeOf("function");
    expect(h.waitFor).toBeTypeOf("function");
    expect(h.rerun).toBeTypeOf("function");
    expect(h.make).toBeTypeOf("function");
  });

  test("make() is the escape hatch for raw OperationValue construction", () => {
    const op = SameIdActor.Run.make({ key: "abc" });
    expect(op._tag).toBe("Run");
    // Struct payload is spread onto the value
    expect(op.key).toBe("abc");
  });
});
