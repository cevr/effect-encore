import { DurableStreamTestServer } from "@durable-streams/server";
import { Effect, Fiber, Ref, type Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Actor from "../src/actor.ts";
import type { OperationDef } from "../src/actor.ts";
import { withActor } from "../src/actor-table.ts";
import { EncoreConfig } from "../src/config.ts";
import { CANCEL_TAG, enqueue } from "../src/mailbox.ts";
import type { ExecId } from "../src/receipt.ts";

// ── test server ────────────────────────────────────────────────────────────

let server: DurableStreamTestServer;
let streamRoot: string;

beforeAll(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" });
  const base = await server.start();
  // Streams are served under /v1/stream; addressing appends /encore/<type>/<id>.
  streamRoot = `${base}/v1/stream`;
});

afterAll(async () => {
  if (server !== undefined) await server.stop();
});

const run = <A, E>(eff: Effect.Effect<A, E, EncoreConfig | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.provideService(eff, EncoreConfig, { baseUrl: streamRoot })),
  );

const freshId = () => `loc-${crypto.randomUUID()}`;

// ── entity under test ──────────────────────────────────────────────────────

interface IncPayload {
  readonly id: string;
  readonly amount: number;
}

const Counter = Actor.fromEntity("Counter", {
  Increment: { id: (p: IncPayload) => p.id } as OperationDef<IncPayload, number, never>,
});

// ── conformance ────────────────────────────────────────────────────────────

describe("tiny-encore entity slice", () => {
  it("REPLY: execute round-trips and correlates the reply by ExecId", async () => {
    const id = freshId();
    const result = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          Counter.activate(
            id,
            { Increment: (p) => Effect.succeed(p.amount + 1) },
            {
              workerId: "w1",
            },
          ),
        );
        const value = yield* Counter.Increment.execute({ id, amount: 5 });
        yield* Fiber.interrupt(fiber);
        return value;
      }),
    );
    expect(result).toBe(6);
  });

  it("SEND: producer-only send works with no handler registered in this process", async () => {
    const id = freshId();
    const out = await run(
      Effect.gen(function* () {
        const execId = yield* Counter.Increment.send({ id, amount: 5 });
        const peeked = yield* Counter.Increment.peek({ id, amount: 5 });
        return { execId, peekedTag: peeked._tag };
      }),
    );
    expect(typeof out.execId).toBe("string");
    expect(out.peekedTag).toBe("Pending"); // enqueued, no drainer => Pending
  });

  it("SEND: idempotent send — duplicate payload == enqueued, same ExecId, handler runs once", async () => {
    const id = freshId();
    const out = await run(
      Effect.gen(function* () {
        const ran = yield* Ref.make(0);
        const e1 = yield* Counter.Increment.send({ id, amount: 5 });
        const e2 = yield* Counter.Increment.send({ id, amount: 5 });
        const fiber = yield* Effect.forkScoped(
          Counter.activate(
            id,
            {
              Increment: (p) =>
                Effect.as(
                  Ref.update(ran, (n) => n + 1),
                  p.amount,
                ),
            },
            { workerId: "w1" },
          ),
        );
        yield* Counter.Increment.waitFor({ id, amount: 5 });
        // give any erroneous second execution a chance to land
        yield* Effect.sleep("250 millis");
        const count = yield* Ref.get(ran);
        yield* Fiber.interrupt(fiber);
        return { e1, e2, count };
      }),
    );
    expect(out.e1).toBe(out.e2);
    expect(out.count).toBe(1);
  });

  it("ACTIVATION: single-owner drain under concurrent claim (two workers, one drains)", async () => {
    const id = freshId();
    const count = await run(
      Effect.gen(function* () {
        const ran = yield* Ref.make(0);
        const handlers = {
          Increment: (p: IncPayload) =>
            Effect.as(
              Ref.update(ran, (n) => n + 1),
              p.amount,
            ),
        };
        const f1 = yield* Effect.forkScoped(Counter.activate(id, handlers, { workerId: "A" }));
        const f2 = yield* Effect.forkScoped(Counter.activate(id, handlers, { workerId: "B" }));
        yield* Counter.Increment.execute({ id, amount: 1 });
        yield* Effect.sleep("250 millis");
        const c = yield* Ref.get(ran);
        yield* Fiber.interrupt(f1);
        yield* Fiber.interrupt(f2);
        return c;
      }),
    );
    expect(count).toBe(1); // exactly one owner executed the message
  });

  it("IDEMPOTENCY: replay after restart returns recorded outcome, no double-execute", async () => {
    const id = freshId();
    const count = await run(
      Effect.gen(function* () {
        const ran = yield* Ref.make(0);
        const handlers = {
          Increment: (p: IncPayload) =>
            Effect.as(
              Ref.update(ran, (n) => n + 1),
              p.amount,
            ),
        };
        // activation #1: process the message, record the reply, then "crash"
        const f1 = yield* Effect.forkScoped(Counter.activate(id, handlers, { workerId: "w1" }));
        yield* Counter.Increment.execute({ id, amount: 7 });
        yield* Fiber.interrupt(f1);
        // activation #2 (restart): replays the message but the reply row exists
        const f2 = yield* Effect.forkScoped(Counter.activate(id, handlers, { workerId: "w1" }));
        yield* Effect.sleep("400 millis");
        const c = yield* Ref.get(ran);
        yield* Fiber.interrupt(f2);
        return c;
      }),
    );
    expect(count).toBe(1); // replay did not re-run the handler
  });

  it("DRIVER: a cancel delivered mid-activation is observable (step interrupted)", async () => {
    const id = freshId();
    const peeked = await run(
      Effect.gen(function* () {
        const execId: ExecId = Counter.Increment.executionId({ id, amount: 9 });
        // handler blocks forever until cancelled
        const fiber = yield* Effect.forkScoped(
          Counter.activate(id, { Increment: () => Effect.never }, { workerId: "w1" }),
        );
        yield* Counter.Increment.send({ id, amount: 9 });
        yield* Effect.sleep("150 millis");
        // deliver a cancel for this ExecId as a control message on the inbox
        yield* withActor("Counter", id, (table) =>
          enqueue(table, { msgId: `cancel/${execId}`, tag: CANCEL_TAG, payload: execId }),
        );
        const result = yield* Counter.Increment.waitFor({ id, amount: 9 });
        yield* Fiber.interrupt(fiber);
        return result._tag;
      }),
    );
    expect(peeked).toBe("Interrupted");
  });
});
