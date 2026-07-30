import { describe, expect, it } from "effect-bun-test";
import { Effect, Exit, Layer, Schema } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import { Actor } from "../../src/index.js";

class OrderError extends Schema.TaggedErrorClass<OrderError>()("OrderError", {
  message: Schema.String,
}) {}

const OrderActor = Actor.fromEntity("Order", {
  Place: {
    payload: { item: Schema.String, qty: Schema.Number },
    success: Schema.String,
    persisted: true,
    // entityId === primaryKey === "${item}-${qty}"
    id: (p: { item: string; qty: number }) => `${p.item}-${p.qty}`,
  },
  Cancel: {
    payload: { reason: Schema.String },
    error: OrderError,
    persisted: true,
    id: (p: { reason: string }) => p.reason,
  },
  QuickCheck: {
    payload: { id: Schema.String },
    success: Schema.String,
    id: (p: { id: string }) => p.id,
  },
});

const orderHandlers = Actor.toLayer(OrderActor, {
  Place: ({ operation }) => Effect.succeed(`order: ${operation.item} x${operation.qty}`),
  Cancel: () => Effect.fail(OrderError.make({ message: "cannot cancel" })),
  QuickCheck: ({ operation }) => Effect.succeed(`ok: ${operation.id}`),
});

const TestCluster = TestRunner.layer;
const orderHandlersLayer = orderHandlers.pipe(Layer.provideMerge(TestCluster));
const test = it.scopedLive;

describe("cluster integration", () => {
  test("call round-trip through Entity", () =>
    Effect.gen(function* () {
      const result = yield* OrderActor.Place.execute({ item: "widget", qty: 3 });
      expect(result).toBe("order: widget x3");
    }).pipe(Effect.provide(orderHandlersLayer)));

  test("send -> peek round-trip with persistence", () =>
    Effect.gen(function* () {
      yield* OrderActor.Place.send({ item: "gadget", qty: 1 });
      yield* Effect.sleep("100 millis");

      const result = yield* OrderActor.Place.peek({ item: "gadget", qty: 1 });
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.value).toBe("order: gadget x1");
      }
    }).pipe(Effect.provide(orderHandlersLayer)));

  test("peek returns Pending then Success as handler completes", () =>
    Effect.gen(function* () {
      const before = yield* OrderActor.Place.peek({ item: "slow", qty: 1 });
      expect(before._tag).toBe("Pending");

      yield* OrderActor.Place.send({ item: "slow", qty: 1 });
      yield* Effect.sleep("100 millis");

      const result = yield* OrderActor.Place.peek({ item: "slow", qty: 1 });
      expect(result._tag).toBe("Success");
    }).pipe(Effect.provide(orderHandlersLayer)));

  test("failure/defect decode correctly from WithExit", () =>
    Effect.gen(function* () {
      yield* OrderActor.Cancel.execute({ reason: "test-fail" }).pipe(Effect.option);
      yield* Effect.sleep("100 millis");

      const result = yield* OrderActor.Cancel.peek({ reason: "test-fail" });
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(orderHandlersLayer)));

  test("duplicate primaryKey is idempotent", () =>
    Effect.gen(function* () {
      yield* OrderActor.Place.send({ item: "dup", qty: 1 });
      yield* OrderActor.Place.send({ item: "dup", qty: 1 });
      yield* Effect.sleep("100 millis");

      const result = yield* OrderActor.Place.peek({ item: "dup", qty: 1 });
      expect(result._tag).toBe("Success");
    }).pipe(Effect.provide(orderHandlersLayer)));

  test("concurrent duplicate sends are idempotent", () =>
    Effect.gen(function* () {
      const exits = yield* Effect.all(
        Array.from({ length: 20 }, () =>
          OrderActor.Place.send({ item: "herd", qty: 1 }).pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      );

      expect(exits.every(Exit.isSuccess)).toBe(true);
      yield* Effect.sleep("100 millis");

      const result = yield* OrderActor.Place.peek({ item: "herd", qty: 1 });
      expect(result._tag).toBe("Success");
    }).pipe(Effect.provide(orderHandlersLayer)));

  test("non-persisted call works without MessageStorage", () =>
    Effect.gen(function* () {
      const result = yield* OrderActor.QuickCheck.execute({ id: "fast" });
      expect(result).toBe("ok: fast");
    }).pipe(Effect.provide(orderHandlersLayer)));
});
