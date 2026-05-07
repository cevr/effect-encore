/**
 * EncoreMessageStorage — encore-internal extension of upstream MessageStorage.
 *
 * Adds `deleteEnvelope(requestId)`: surgical removal of a single message
 * envelope (and its replies) by Snowflake id. Required by `<Op>.rerun(payload)`
 * to clear exactly one execId's persisted state without nuking the entire
 * entity address.
 *
 * Adapters provide BOTH tags:
 * - upstream `MessageStorage.MessageStorage` is still required by the runner
 *   (effect-cluster owns it for normal entity routing).
 * - `EncoreMessageStorage` is required by encore actor methods that need
 *   surgical delete (`.rerun`).
 *
 * Use `fromMessageStorage(storage, ext)` to build an `EncoreMessageStorage`
 * value from an upstream storage plus the extension method, or `layer(ext)`
 * to compose an effect Layer providing both tags.
 */
import { MessageStorage } from "effect/unstable/cluster";
import type { PersistenceError } from "effect/unstable/cluster/ClusterError";
import type * as Snowflake from "effect/unstable/cluster/Snowflake";
import { Context, Effect, Layer } from "effect";

// ─── Shape ──────────────────────────────────────────────────────────────────

export type EncoreMessageStorageShape = MessageStorage.MessageStorage["Service"] & {
  readonly deleteEnvelope: (
    requestId: Snowflake.Snowflake,
  ) => Effect.Effect<void, PersistenceError>;
};

// ─── Tag ────────────────────────────────────────────────────────────────────

export class EncoreMessageStorage extends Context.Service<
  EncoreMessageStorage,
  EncoreMessageStorageShape
>()("effect-encore/storage/EncoreMessageStorage") {}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build an `EncoreMessageStorage` value from an upstream `MessageStorage`
 * shape plus the encore-specific extension. Adapters use this when their
 * underlying client (Mongo, Redis, in-memory) implements both the upstream
 * methods and `deleteEnvelope`.
 */
export const fromMessageStorage = (
  storage: MessageStorage.MessageStorage["Service"],
  ext: {
    readonly deleteEnvelope: (
      requestId: Snowflake.Snowflake,
    ) => Effect.Effect<void, PersistenceError>;
  },
): EncoreMessageStorageShape => ({
  ...storage,
  deleteEnvelope: ext.deleteEnvelope,
});

/**
 * Layer composer: takes a Layer providing upstream `MessageStorage` and the
 * encore-specific extension, and produces a Layer providing BOTH the upstream
 * tag and `EncoreMessageStorage`.
 *
 * Adapters that haven't implemented `deleteEnvelope` should pass an `ext`
 * that fails loud (e.g. `Effect.die("not implemented")`) rather than silently
 * coarsening to `flush` — the goal is to surface unimplemented capability
 * immediately, not paper over it.
 */
export const layer = <RIn, E>(
  upstream: Layer.Layer<MessageStorage.MessageStorage, E, RIn>,
  ext: {
    readonly deleteEnvelope: (
      requestId: Snowflake.Snowflake,
    ) => Effect.Effect<void, PersistenceError>;
  },
): Layer.Layer<MessageStorage.MessageStorage | EncoreMessageStorage, E, RIn> =>
  Layer.merge(
    upstream,
    Layer.effect(
      EncoreMessageStorage,
      Effect.gen(function* () {
        const storage = yield* MessageStorage.MessageStorage;
        return fromMessageStorage(storage, ext);
      }),
    ).pipe(Layer.provide(upstream)),
  );
