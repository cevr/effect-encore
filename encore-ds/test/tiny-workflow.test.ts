import { DurableStreamTestServer } from "@durable-streams/server";
import { Effect, Fiber, Layer, Schema, type Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSuccess } from "../src/receipt.ts";
import { fromWorkflow, workflowEngineLayer } from "../src/workflow.ts";

let server: DurableStreamTestServer;
let baseUrl: string;

beforeAll(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" });
  baseUrl = await server.start();
});
afterAll(async () => {
  if (server !== undefined) await server.stop();
});

const engineUrl = () => `${baseUrl}/v1/stream/wf-${crypto.randomUUID()}`;

const run = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(eff));

describe("tiny-encore workflow slice", () => {
  it("WORKFLOW: a durable step runs once and the execution is memoized on re-execute", async () => {
    let runs = 0;
    const Geocode = fromWorkflow("Geocode", {
      payload: { locationId: Schema.String },
      id: (p) => p.locationId,
      success: Schema.Number,
    });
    const handler = Geocode.toLayer((_payload, ctx) =>
      ctx.run(
        "lookup",
        Effect.sync(() => {
          runs += 1;
          return 42;
        }),
      ),
    );
    const layer = handler.pipe(Layer.provideMerge(workflowEngineLayer({ streamUrl: engineUrl() })));

    const out = await run(
      Effect.gen(function* () {
        const first = yield* Geocode.execute({ locationId: "loc-A" });
        // re-execute with the same id: the engine returns the durable result,
        // the body/activity is NOT re-run.
        const second = yield* Geocode.execute({ locationId: "loc-A" });
        return { first, second };
      }).pipe(Effect.provide(layer)),
    );

    expect(out.first).toBe(42);
    expect(out.second).toBe(42);
    expect(runs).toBe(1); // memoized — single durable execution
  });

  it("WORKFLOW: a signal resolves a DurableDeferred and wakes the workflow", async () => {
    const Approval = fromWorkflow("Approval", {
      payload: { id: Schema.String },
      id: (p) => p.id,
      success: Schema.String,
      signals: { approve: { success: Schema.String } },
    });
    const handler = Approval.toLayer((_payload, _ctx) =>
      Effect.map(Approval.approve.await, (decision) => `decided:${decision}`),
    );
    const layer = handler.pipe(Layer.provideMerge(workflowEngineLayer({ streamUrl: engineUrl() })));

    const out = await run(
      Effect.gen(function* () {
        // start the workflow (suspends awaiting the signal)
        const fiber = yield* Effect.forkScoped(Approval.execute({ id: "req-1" }));
        yield* Effect.sleep("200 millis");
        // resolve the signal from outside
        const token = yield* Approval.approve.tokenFromPayload({ id: "req-1" });
        yield* Approval.approve.succeed({ token, value: "yes" });
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(layer)),
    );

    expect(out._tag).toBe("Success");
    if (out._tag === "Success") expect(out.value).toBe("decided:yes");
  });
});
