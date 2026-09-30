import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ShardingConfig } from "effect/cluster";
import { Actor } from "../src/index.js";

const Messaging = Actor.fromEntity("MessagingBenchmark", {
  Execute: {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    id: (payload: { readonly id: string }) => payload.id,
  },
  Send: {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    persisted: true,
    id: (payload: { readonly id: string }) => payload.id,
  },
});

const ShardingConfigTest = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10_000,
  entityTerminationTimeout: 0,
});

const MessagingTest = Layer.provide(
  Actor.toTestLayer(Messaging, {
    Execute: ({ operation }) => Effect.succeed(operation.value + 1),
    Send: ({ operation }) => Effect.succeed(operation.value + 1),
  }),
  ShardingConfigTest,
);

const runtime = ManagedRuntime.make(MessagingTest);

const median = (samples: Array<number>): number => {
  samples.sort((left, right) => left - right);
  return samples[2];
};

const measureSync = (iterations: number, operation: (index: number) => unknown): number => {
  for (let index = 0; index < iterations; index++) operation(index);
  const samples: Array<number> = [];
  for (let sample = 0; sample < 5; sample++) {
    const startedAt = Bun.nanoseconds();
    for (let index = 0; index < iterations; index++) operation(index);
    samples.push((Bun.nanoseconds() - startedAt) / iterations);
  }
  return median(samples);
};

const measureEffect = <A, E>(
  iterations: number,
  operation: (index: number) => Effect.Effect<A, E, Messaging["Context"]>,
): Promise<number> =>
  runtime.runPromise(
    Effect.gen(function* () {
      for (let index = 0; index < iterations; index++) yield* operation(index);
      const samples: Array<number> = [];
      for (let sample = 0; sample < 5; sample++) {
        const startedAt = Bun.nanoseconds();
        for (let index = 0; index < iterations; index++) yield* operation(index);
        samples.push((Bun.nanoseconds() - startedAt) / iterations);
      }
      return median(samples);
    }),
  );

const payload = { id: "same-entity", value: 1 };
const actorRef = await runtime.runPromise(
  Effect.gen(function* () {
    const factory = yield* Messaging.Context;
    return yield* factory(payload.id);
  }),
);
const operationValue = Messaging.Execute.make(payload);
const rows: Array<readonly [string, number]> = [
  ["make", measureSync(1_000_000, () => Messaging.Execute.make(payload))],
  ["executionId effect", measureSync(1_000_000, () => Messaging.Execute.executionId(payload))],
  [
    "executionId runSync",
    measureSync(100_000, () => Effect.runSync(Messaging.Execute.executionId(payload))),
  ],
  ["execute, same entity", await measureEffect(10_000, () => Messaging.Execute.execute(payload))],
  [
    "actor ref factory, same entity",
    await measureEffect(10_000, () =>
      Effect.gen(function* () {
        const factory = yield* Messaging.Context;
        return yield* factory(payload.id);
      }),
    ),
  ],
  [
    "actor ref execute, prebuilt operation",
    await measureEffect(10_000, () => actorRef.execute(operationValue)),
  ],
  [
    "actor ref execute, new operation",
    await measureEffect(10_000, () => actorRef.execute(Messaging.Execute.make(payload))),
  ],
  [
    "execute, 100 entities",
    await measureEffect(10_000, (index) =>
      Messaging.Execute.execute({ id: `entity-${index % 100}`, value: index }),
    ),
  ],
  ["send, same entity", await measureEffect(10_000, () => Messaging.Send.send(payload))],
];

console.log("actor operation\tns/op\tops/s");
for (const [name, nanoseconds] of rows) {
  console.log(`${name}\t${nanoseconds.toFixed(0)}\t${(1_000_000_000 / nanoseconds).toFixed(0)}`);
}

await runtime.dispose();
