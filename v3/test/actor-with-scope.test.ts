import { describe, expect, it } from "effect-bun-test/v3";
import { Context, Effect, Layer, Schema } from "effect";
import { ShardingConfig } from "@effect/cluster";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

class WorkspaceId extends Context.Tag("effect-encore/v3/test/actor-with-scope.test/WorkspaceId")<
  WorkspaceId,
  string
>() {}

class LayerToken extends Context.Tag("effect-encore/v3/test/actor-with-scope.test/LayerToken")<
  LayerToken,
  string
>() {}

const Scoped = Actor.fromEntity("Scoped", {
  Inspect: {
    payload: { id: Schema.String },
    success: Schema.String,
    id: (p: { id: string }) => p.id,
  },
});

const Captured = Actor.fromEntity("Captured", {
  Read: {
    payload: { id: Schema.String },
    success: Schema.String,
    id: (p: { id: string }) => p.id,
  },
});

const Dynamic = Actor.fromEntity("Dynamic", {
  Read: {
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
        Inspect: () => WorkspaceId,
      }),
    ),
    {
      withScope: (address) =>
        Effect.succeed(Context.make(WorkspaceId, `workspace-for:${address.entityId}`)),
    },
  ),
  TestShardingConfig,
);

const CapturedLayer = Layer.provide(
  Layer.unwrapEffect(
    Actor.provideLayerBuildContext(
      Effect.gen(function* () {
        const layerToken = yield* LayerToken;
        return Captured.of({
          Read: () => Effect.succeed(layerToken),
        });
      }),
    ).pipe(Effect.map((build) => Actor.toTestLayer(Captured, build))),
  ),
  Layer.merge(TestShardingConfig, Layer.succeed(LayerToken, "captured-layer-token")),
);

const DynamicLayer = Layer.provide(
  Actor.toTestLayer(
    Dynamic,
    Dynamic.of({
      Read: () => LayerToken,
    }),
  ),
  Layer.merge(TestShardingConfig, Layer.succeed(LayerToken, "actor-layer-token")),
);

const scopedTest = it.scopedLive.layer(ScopedLayer);
const capturedTest = it.scopedLive.layer(CapturedLayer);
const dynamicTest = it.scopedLive.layer(DynamicLayer);

describe("Actor.toLayer({ withScope }) (v3)", () => {
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

  capturedTest("provideLayerBuildContext captures layer-built services", () =>
    Effect.gen(function* () {
      const makeRef = yield* Captured.Context;
      const ref = yield* makeRef("alpha");
      const value = yield* ref.execute(Captured.Read.make({ id: "alpha" }));
      expect(value).toBe("captured-layer-token");
    }),
  );

  dynamicTest("caller-provided services override actor layer services", () =>
    Effect.gen(function* () {
      const makeRef = yield* Dynamic.Context;
      const ref = yield* makeRef("alpha");
      const value = yield* ref
        .execute(Dynamic.Read.make({ id: "alpha" }))
        .pipe(Effect.provideService(LayerToken, "caller-token"));
      expect(value).toBe("caller-token");
    }),
  );
});
