import { DurableStreamTestServer } from "@durable-streams/server";
import { Effect, Layer, type Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  all,
  client,
  race,
  run,
  service,
  type ServiceDefinition,
  serviceLayer,
  workflowEngineLayer,
} from "../src/fluent/index.ts";

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

const runScoped = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(eff));

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
          return yield* run(() => {
            calls += 1;
            return `Hello, ${name}!`;
          }, { name: "compose" });
        },
      },
    });

    const out = await runScoped(client(greeter).hello("world").pipe(Effect.provide(wire(greeter))));

    expect(out).toBe("Hello, world!");
    expect(calls).toBe(1);
  });

  it("SERVICE-MEMOIZE: yielding the same durable step twice runs the action once", async () => {
    let calls = 0;
    const svc = service({
      name: "memo",
      handlers: {
        *twice(_input: string) {
          const step = run(() => {
            calls += 1;
            return calls;
          }, { name: "s" });
          const a = yield* step;
          const b = yield* step;
          return { a, b };
        },
      },
    });

    const out = (await runScoped(client(svc).twice("x").pipe(Effect.provide(wire(svc))))) as {
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

    const out = await runScoped(client(svc).pipeline("inc").pipe(Effect.provide(wire(svc))));
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
            run(() => {
              aCalls += 1;
              return `${input}:a`;
            }, { name: "a" }),
            run(() => {
              bCalls += 1;
              return `${input}:b`;
            }, { name: "b" }),
          ]);
          return `${a}+${b}`;
        },
      },
    });

    const out = await runScoped(client(svc).parallel("inc").pipe(Effect.provide(wire(svc))));
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

    const out = await runScoped(client(svc).fastest("inc").pipe(Effect.provide(wire(svc))));
    expect(out).toBe("primary:inc");
  });
});
