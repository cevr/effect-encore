import { DurableStreamTestServer } from "@durable-streams/server";
import { Effect, Layer, type Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  all,
  client,
  makeRuntime,
  race,
  run,
  schemas,
  select,
  sendClient,
  service,
  type ServiceDefinition,
  serviceLayer,
  spawn,
  workflow,
  workflowEngineLayer,
} from "../src/fluent/index.ts";
import { Fiber, Schema } from "effect";

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

const runScoped = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(eff));

// Build the wiring exactly like tiny-workflow.test.ts: registered handler
// bodies + the durable-streams engine, merged into one provided layer.
const wire = (def: ServiceDefinition<string, any>) =>
  serviceLayer(def).pipe(Layer.provideMerge(workflowEngineLayer({ streamUrl: engineUrl() })));

describe("fluent service slice — run / all / race", () => {
  it("SERVICE-RUN-ONCE: a handler's durable step executes exactly once", async () => {
    let calls = 0;
    const greeter = service({
      name: "greeter",
      handlers: {
        *hello(name: string) {
          return yield* run(
            () => {
              calls += 1;
              return `Hello, ${name}!`;
            },
            { name: "compose" },
          );
        },
      },
    });

    const out = await runScoped(
      client(greeter)
        .hello("world")
        .pipe(Effect.provide(wire(greeter))),
    );

    expect(out).toBe("Hello, world!");
    expect(calls).toBe(1);
  });

  it("SERVICE-MEMOIZE: yielding the same durable step twice runs the action once", async () => {
    let calls = 0;
    const svc = service({
      name: "memo",
      handlers: {
        *twice(_input: string) {
          const step = run(
            () => {
              calls += 1;
              return calls;
            },
            { name: "s" },
          );
          const a = yield* step;
          const b = yield* step;
          return { a, b };
        },
      },
    });

    const out = (await runScoped(
      client(svc)
        .twice("x")
        .pipe(Effect.provide(wire(svc))),
    )) as {
      a: number;
      b: number;
    };

    expect(out.a).toBe(1);
    expect(out.b).toBe(1); // memoized — recorded terminal fact, not re-run
    expect(calls).toBe(1);
  });

  it("SERVICE-SEQUENTIAL: two sequential durable steps compose", async () => {
    const svc = service({
      name: "seq",
      handlers: {
        *pipeline(input: string) {
          const a = yield* run(() => `${input}-triage`, { name: "classify" });
          const b = yield* run(() => `${a}+context`, { name: "collect" });
          return b;
        },
      },
    });

    const out = await runScoped(
      client(svc)
        .pipeline("inc")
        .pipe(Effect.provide(wire(svc))),
    );
    expect(out).toBe("inc-triage+context");
  });

  it("SERVICE-ALL: durable steps run concurrently and all results collect", async () => {
    let aCalls = 0;
    let bCalls = 0;
    const svc = service({
      name: "fanout",
      handlers: {
        *parallel(input: string) {
          const [a, b] = yield* all([
            run(
              () => {
                aCalls += 1;
                return `${input}:a`;
              },
              { name: "a" },
            ),
            run(
              () => {
                bCalls += 1;
                return `${input}:b`;
              },
              { name: "b" },
            ),
          ]);
          return `${a}+${b}`;
        },
      },
    });

    const out = await runScoped(
      client(svc)
        .parallel("inc")
        .pipe(Effect.provide(wire(svc))),
    );
    expect(out).toBe("inc:a+inc:b");
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it("SERVICE-RACE: the first durable step to settle wins", async () => {
    const svc = service({
      name: "racer",
      handlers: {
        *fastest(id: string) {
          return yield* race([
            run(() => `primary:${id}`, { name: "primary" }),
            run(() => new Promise<string>((r) => setTimeout(() => r(`secondary:${id}`), 200)), {
              name: "secondary",
            }),
          ]);
        },
      },
    });

    const out = await runScoped(
      client(svc)
        .fastest("inc")
        .pipe(Effect.provide(wire(svc))),
    );
    expect(out).toBe("primary:inc");
  });

  it("SERVICE-SELECT: tagged race resolves { tag, future } for the winning arm", async () => {
    const svc = service({
      name: "selector",
      handlers: {
        *decide(id: string) {
          const r = yield* select({
            fast: run(() => `fast:${id}`, { name: "fast" }),
            slow: run(() => new Promise<string>((res) => setTimeout(() => res(`slow:${id}`), 200)), {
              name: "slow",
            }),
          });
          const value = yield* r.future;
          return { tag: r.tag, value };
        },
      },
    });

    const out = (await runScoped(
      client(svc)
        .decide("inc")
        .pipe(Effect.provide(wire(svc))),
    )) as { tag: string; value: string };
    expect(out.tag).toBe("fast");
    expect(out.value).toBe("fast:inc");
  });

  it("SERVICE-SPAWN: a local fiber runs concurrently and is joined", async () => {
    const svc = service({
      name: "spawner",
      handlers: {
        *background(input: string) {
          const fiber = yield* spawn(run(() => `${input}:bg`, { name: "bg" }));
          const main = yield* run(() => `${input}:main`, { name: "main" });
          const bg = yield* Fiber.join(fiber);
          return `${main}+${bg}`;
        },
      },
    });

    const out = await runScoped(
      client(svc)
        .background("inc")
        .pipe(Effect.provide(wire(svc))),
    );
    expect(out).toBe("inc:main+inc:bg");
  });

  it("SERVICE-DEDUP: same idempotencyKey shares one durable execution across calls", async () => {
    let calls = 0;
    const svc = service({
      name: "dedup",
      handlers: {
        *work(input: string) {
          return yield* run(() => {
            calls += 1;
            return `${input}:${calls}`;
          }, { name: "w" });
        },
      },
    });

    // One engine layer shared across both calls — durable dedup needs it.
    const layer = wire(svc);
    const out = (await runScoped(
      Effect.gen(function* () {
        const c = client(svc);
        const a = yield* c.work("x", { idempotencyKey: "k" });
        const b = yield* c.work("x", { idempotencyKey: "k" });
        return { a, b };
      }).pipe(Effect.provide(layer)),
    )) as { a: string; b: string };

    expect(calls).toBe(1); // second call returns the recorded execution
    expect(out.a).toBe(out.b);
    expect(out.a).toBe("x:1");
  });

  it("SERVICE-SCHEMAS: typed descriptor drives the durable I/O boundary", async () => {
    // Proves a non-Unknown descriptor compiles and runs end to end (typed input
    // + typed struct output through the workflow payload/success schemas). The
    // transform-round-trip proof (e.g. Schema.Date string<->Date) is deferred.
    const svc = service({
      name: "typed",
      handlers: {
        *square(n: number) {
          const value = yield* run(() => n * n, { name: "sq" });
          return { input: n, value };
        },
      },
      descriptors: {
        square: schemas({
          input: Schema.Number,
          output: Schema.Struct({ input: Schema.Number, value: Schema.Number }),
        }),
      },
    });

    const out = (await runScoped(
      client(svc)
        .square(7)
        .pipe(Effect.provide(wire(svc))),
    )) as { input: number; value: number };

    expect(out).toEqual({ input: 7, value: 49 });
  });

  it("INGRESS: makeRuntime + client(ingress, def) returns Promises with no Effect.provide", async () => {
    const svc = service({
      name: "ingress",
      handlers: {
        *hello(name: string) {
          return yield* run(() => `Hi, ${name}`, { name: "compose" });
        },
      },
    });

    const ingress = makeRuntime({ services: [svc], engine: { streamUrl: engineUrl() } });
    try {
      const calls = client(ingress, svc);
      const out = await calls.hello("ada");
      expect(out).toBe("Hi, ada");
    } finally {
      await ingress.dispose();
    }
  });

  it("INGRESS-SEND: sendClient dispatches; result correlated by shared idempotencyKey", async () => {
    let calls = 0;
    const svc = service({
      name: "ingressSend",
      handlers: {
        *work(input: string) {
          return yield* run(() => {
            calls += 1;
            return `${input}!`;
          }, { name: "w" });
        },
      },
    });

    const ingress = makeRuntime({ services: [svc], engine: { streamUrl: engineUrl() } });
    try {
      const send = sendClient(ingress, svc);
      const call = client(ingress, svc);
      const execId = await send.work("go", { idempotencyKey: "k" });
      const result = await call.work("go", { idempotencyKey: "k" });
      expect(typeof execId).toBe("string");
      expect(result).toBe("go!");
      expect(calls).toBe(1); // send + call hit the same durable execution
    } finally {
      await ingress.dispose();
    }
  });

  it("WORKFLOW: keyed — same input is one durable run by default (no idempotencyKey)", async () => {
    let calls = 0;
    const order = workflow({
      name: "order",
      handlers: {
        *process(orderId: string) {
          return yield* run(() => {
            calls += 1;
            return `processed:${orderId}`;
          }, { name: "p" });
        },
      },
      // default key = the string input
    });

    const layer = wire(order);
    const out = (await runScoped(
      Effect.gen(function* () {
        const c = client(order);
        const a = yield* c.process("o-1");
        const b = yield* c.process("o-1"); // same key, no idempotencyKey passed
        return { a, b };
      }).pipe(Effect.provide(layer)),
    )) as { a: string; b: string };

    expect(calls).toBe(1); // workflow dedups by key by default (service would not)
    expect(out.a).toBe("processed:o-1");
    expect(out.b).toBe(out.a);
  });

  it("WORKFLOW: custom key fn derives the run key from a struct input", async () => {
    let calls = 0;
    const wf = workflow({
      name: "keyed",
      handlers: {
        *compute(input: { id: string; n: number }) {
          return yield* run(() => {
            calls += 1;
            return input.n;
          }, { name: "k" });
        },
      },
      key: (input) => input.id,
    });

    const layer = wire(wf);
    const out = (await runScoped(
      Effect.gen(function* () {
        const c = client(wf);
        const first = yield* c.compute({ id: "same", n: 1 });
        const second = yield* c.compute({ id: "same", n: 2 }); // same key → same run
        return { first, second };
      }).pipe(Effect.provide(layer)),
    )) as { first: number; second: number };

    expect(calls).toBe(1);
    expect(out.first).toBe(1);
    expect(out.second).toBe(1); // returns the first run's recorded result
  });
});
