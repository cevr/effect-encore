import { describe, expect, it } from "effect-bun-test";
import { Context, Effect, Layer, Schema } from "effect";
import { EntityAddress, EntityId, EntityType, ShardId, ShardingConfig } from "effect/cluster";
import { CurrentAddress } from "effect/cluster/Entity";
import { Actor } from "../src/index.js";

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
});

class WorkspaceId extends Context.Service<WorkspaceId, string>()(
  "effect-encore/test/actor-with-scope.test/WorkspaceId",
) {}

class LayerToken extends Context.Service<LayerToken, string>()(
  "effect-encore/test/actor-with-scope.test/LayerToken",
) {}

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
  Layer.unwrap(
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

const Nested = Actor.fromEntity("Nested", {
  WhoAmI: {
    payload: { id: Schema.String },
    success: Schema.String,
    id: (p: { id: string }) => p.id,
  },
});

// Models an actor layer built inside another actor's handler: the fiber
// context at layer-build time already carries an outer `CurrentAddress`.
const outerAddress = EntityAddress.make({
  shardId: ShardId.make("default", 1),
  entityType: EntityType.make("Outer"),
  entityId: EntityId.make("outer-entity"),
});

const NestedLayer = Layer.provide(
  Layer.unwrap(
    Actor.provideLayerBuildContext(
      Effect.gen(function* () {
        const address = yield* CurrentAddress;
        return Nested.of({
          WhoAmI: () => Effect.succeed(address.entityId),
        });
      }),
    ).pipe(Effect.map((build) => Actor.toTestLayer(Nested, build))),
  ),
  Layer.merge(TestShardingConfig, Layer.succeed(CurrentAddress, outerAddress)),
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
const nestedTest = it.scopedLive.layer(NestedLayer);

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

  capturedTest("provideLayerBuildContext captures layer-built services", () =>
    Effect.gen(function* () {
      const makeRef = yield* Captured.Context;
      const ref = yield* makeRef("alpha");
      const value = yield* ref.execute(Captured.Read.make({ id: "alpha" }));
      expect(value).toBe("captured-layer-token");
    }),
  );

  nestedTest(
    "handler build keeps its own entity address when the layer is built inside another actor",
    () =>
      Effect.gen(function* () {
        const makeRef = yield* Nested.Context;
        const ref = yield* makeRef("inner-entity");
        const value = yield* ref.execute(Nested.WhoAmI.make({ id: "inner-entity" }));
        expect(value).toBe("inner-entity");
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
