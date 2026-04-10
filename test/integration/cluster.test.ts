import { describe, expect, it } from "effect-bun-test";
import type { Layer } from "effect";
import { Effect, Schema } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import { Actor, makeCastReceipt, peek } from "../../src/index.js";

class OrderError extends Schema.TaggedErrorClass<OrderError>()("OrderError", {
  message: Schema.String,
}) {}

const OrderActor = Actor("Order", {
  Place: {
    input: { item: Schema.String, qty: Schema.Number },
    output: Schema.String,
    persisted: true,
    primaryKey: (p: { item: string; qty: number }) => `${p.item}-${p.qty}`,
  },
  Cancel: {
    input: { reason: Schema.String },
    error: OrderError,
    persisted: true,
    primaryKey: (p: { reason: string }) => p.reason,
  },
  QuickCheck: {
    input: { id: Schema.String },
    output: Schema.String,
  },
});

const orderHandlers = OrderActor.handlers({
  Place: ({ operation }) => Effect.succeed(`order: ${operation.item} x${operation.qty}`),
  Cancel: () => Effect.fail(new OrderError({ message: "cannot cancel" })),
  QuickCheck: ({ operation }) => Effect.succeed(`ok: ${operation.id}`),
});

const TestCluster = TestRunner.layer;

const test = it.scopedLive;

describe("cluster integration", () => {
  test("call round-trip through Entity", () =>
    Effect.gen(function* () {
      const makeClient = yield* OrderActor.entity.client;
      const client = makeClient("ord-1");
      const result = yield* client.Place({ item: "widget", qty: 3 });
      expect(result).toBe("order: widget x3");
    }).pipe(
      Effect.provide(orderHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ));

  test("cast -> peek round-trip with persistence", () =>
    Effect.gen(function* () {
      const makeClient = yield* OrderActor.entity.client;
      const client = makeClient("ord-2");

      yield* client.Place({ item: "gadget", qty: 1 }, { discard: true });
      yield* Effect.sleep("100 millis");

      const receipt = makeCastReceipt({
        actorType: "Order",
        entityId: "ord-2",
        operation: "Place",
        primaryKey: "gadget-1",
      });

      const result = yield* peek(OrderActor, receipt);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.value).toBe("order: gadget x1");
      }
    }).pipe(
      Effect.provide(orderHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ));

  test("peek returns Pending then Success as handler completes", () =>
    Effect.gen(function* () {
      const makeClient = yield* OrderActor.entity.client;
      const client = makeClient("ord-3");

      const receipt = makeCastReceipt({
        actorType: "Order",
        entityId: "ord-3",
        operation: "Place",
        primaryKey: "slow-1",
      });

      const before = yield* peek(OrderActor, receipt);
      expect(before._tag).toBe("Pending");

      yield* client.Place({ item: "slow", qty: 1 }, { discard: true });
      yield* Effect.sleep("100 millis");

      const result = yield* peek(OrderActor, receipt);
      expect(result._tag).toBe("Success");
    }).pipe(
      Effect.provide(orderHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ));

  test("failure/defect decode correctly from WithExit", () =>
    Effect.gen(function* () {
      const makeClient = yield* OrderActor.entity.client;
      const client = makeClient("ord-4");

      yield* client.Cancel({ reason: "test-fail" }).pipe(Effect.option);

      const receipt = makeCastReceipt({
        actorType: "Order",
        entityId: "ord-4",
        operation: "Cancel",
        primaryKey: "test-fail",
      });

      const result = yield* peek(OrderActor, receipt);
      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(orderHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ));

  test("duplicate primaryKey is idempotent", () =>
    Effect.gen(function* () {
      const makeClient = yield* OrderActor.entity.client;
      const client = makeClient("ord-5");

      yield* client.Place({ item: "dup", qty: 1 }, { discard: true });
      yield* client.Place({ item: "dup", qty: 1 }, { discard: true });
      yield* Effect.sleep("100 millis");

      const receipt = makeCastReceipt({
        actorType: "Order",
        entityId: "ord-5",
        operation: "Place",
        primaryKey: "dup-1",
      });

      const result = yield* peek(OrderActor, receipt);
      expect(result._tag).toBe("Success");
    }).pipe(
      Effect.provide(orderHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ));

  test("non-persisted call works without MessageStorage", () =>
    Effect.gen(function* () {
      const makeClient = yield* OrderActor.entity.client;
      const client = makeClient("ord-6");
      const result = yield* client.QuickCheck({ id: "fast" });
      expect(result).toBe("ok: fast");
    }).pipe(
      Effect.provide(orderHandlers as unknown as Layer.Layer<never>),
      Effect.provide(TestCluster),
    ));
});
