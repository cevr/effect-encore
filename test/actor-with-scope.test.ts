import { describe, expect, it } from "effect-bun-test";
import { Context, Effect, Layer, Schema } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

class WorkspaceId extends Context.Service<WorkspaceId, string>()(
  "effect-encore/test/actor-with-scope.test/WorkspaceId",
) {}

const Scoped = Actor.fromEntity("Scoped", {
  Inspect: {
    payload: { id: Schema.String },
    success: Schema.String,
    id: (p: { id: string }) => p.id,
  },
});

const ScopedLayer = Layer.provide(
  Actor.toTestLayer(
    Scoped,
    Effect.succeed(
      Scoped.of({
        Inspect: () => Effect.map(WorkspaceId.asEffect(), (id) => id),
      }),
    ),
    {
      withScope: (address) =>
        Effect.succeed(Context.make(WorkspaceId, `workspace-for:${address.entityId}`)),
    },
  ),
  TestShardingConfig,
);

const scopedTest = it.scopedLive.layer(ScopedLayer);

describe("Actor.toLayer({ withScope })", () => {
  scopedTest("handler reads a Tag built per-call from the entity address", () =>
    Effect.gen(function* () {
      const makeRef = yield* Scoped.Context;
      const ref = yield* makeRef("alpha");
      const value = yield* ref.execute(Scoped.Inspect.make({ id: "alpha" }));
      expect(value).toBe("workspace-for:alpha");
    }),
  );

  scopedTest("withScope re-runs for each address (different entities get distinct scopes)", () =>
    Effect.gen(function* () {
      const makeRef = yield* Scoped.Context;
      const refOne = yield* makeRef("one");
      const refTwo = yield* makeRef("two");
      const a = yield* refOne.execute(Scoped.Inspect.make({ id: "one" }));
      const b = yield* refTwo.execute(Scoped.Inspect.make({ id: "two" }));
      expect(a).toBe("workspace-for:one");
      expect(b).toBe("workspace-for:two");
    }),
  );
});
