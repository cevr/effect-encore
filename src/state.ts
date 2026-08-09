/**
 * `State` is a typed view over an entity's state cell, plus a
 * subscribable stream of every change.
 *
 * Unlike a `Ref`, `State` has no in-memory cell of its own — the
 * backing store the `read`/`write` closures close over is the source
 * of truth. Reads decode the live store on demand; writes encode and
 * overwrite it. A `PubSub<A>` backs {@link changes} and is fed by every
 * write routed through `State` (and may be fed externally via
 * {@link publish}, which serializes through the same lock, so
 * subscribers see committed changes initiated outside `State` in
 * write order).
 *
 * Read and write are Effect-typed so schemas with asynchronous
 * transforms (or service requirements) are supported. `update` and
 * `modify` serialize through a per-`State` semaphore so read/apply/
 * write triples are atomic across fibers; `set` shares the same lock
 * so all writes are linearized.
 *
 * The PubSub uses replay = 1, matching `SubscriptionRef`: a new
 * subscriber immediately sees the most recent value.
 *
 * Modeled on rivet's `rivetkit-typescript/packages/effect/src/State.ts`
 * (see docs/adr/0001 — Rivet's API is a DX target, not its runtime). The
 * 0d.3 reshape ships this as a standalone value type backed by an
 * in-process observable cell (a `SubscriptionRef`-closure); a durable
 * per-entity backing is deferred to Phase 3, where the storage
 * subsystem that does not exist in the vendored runtime today gets
 * built (see docs/adr/0001 §RESOLUTION).
 */
import {
  Effect,
  Inspectable,
  identity,
  Pipeable,
  Predicate,
  PubSub,
  Semaphore,
  Stream,
} from "effect";
import type { Types } from "effect";
import { dual } from "effect/Function";
import type { Inspectable as InspectableInterface } from "effect/Inspectable";

const TypeId = "effect-encore/state/State";

/**
 * A view over a state cell with a subscribable change stream.
 *
 * - `A` — the value type
 * - `E` — the read/write closures' failure type (e.g. a schema's
 *         `SchemaError` when read/write decode/encode against a schema)
 * - `R` — the read/write closures' service requirements
 */
export interface State<A, E = never, R = never>
  extends Variance<A, E, R>, Pipeable.Pipeable, InspectableInterface {
  readonly read: Effect.Effect<A, E, R>;
  readonly write: (value: A) => Effect.Effect<void, E, R>;
  readonly pubsub: PubSub.PubSub<A>;
  /**
   * Serializes writes (`set`, `update`, `modify`) so the read/apply/
   * write triple is atomic.
   */
  readonly semaphore: Semaphore.Semaphore;
}

export const isState = (value: unknown): value is State<unknown, unknown> =>
  Predicate.hasProperty(value, TypeId);

export interface Variance<A, E, R> {
  readonly [TypeId]: {
    readonly _A: Types.Invariant<A>;
    readonly _E: Types.Covariant<E>;
    readonly _R: Types.Covariant<R>;
  };
}

const Proto = {
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  [TypeId]: { _A: identity, _E: identity, _R: identity },
  toJSON(this: State<unknown, unknown, unknown>) {
    return { _id: "State" };
  },
};

/**
 * Creates a `State` from `read` and `write` closures over the
 * underlying store. The closures are responsible for any
 * encoding/decoding; `State` itself is schema-agnostic.
 *
 * The current value (per `read()`) is published to the pubsub on
 * construction so any subscription obtained later replays it.
 *
 * The PubSub is not explicitly shut down — it's reclaimed by GC when
 * the `State` and any subscribers become unreachable.
 */
export const make = Effect.fnUntraced(function* <A, E, R>(
  read: Effect.Effect<A, E, R>,
  write: (value: A) => Effect.Effect<void, E, R>,
): Effect.fn.Return<State<A, E, R>, E, R> {
  const pubsub = yield* PubSub.unbounded<A>({ replay: 1 });
  const initial = yield* read;
  PubSub.publishUnsafe(pubsub, initial);
  const self: State<A, E, R> = Object.create(Proto);
  Object.assign(self, { read, write, pubsub, semaphore: Semaphore.makeUnsafe(1) });
  return self;
});

/**
 * Reads the current value.
 */
export const get = <A, E, R>(self: State<A, E, R>): Effect.Effect<A, E, R> => self.read;

/**
 * Replaces the value, then publishes it to {@link changes}. Serialized
 * with `update` / `modify` so writes happen in invocation order.
 */
export const set: {
  <A>(value: A): <E, R>(self: State<A, E, R>) => Effect.Effect<void, E, R>;
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R>;
} = dual(
  2,
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R> =>
    Semaphore.withPermit(self.semaphore, commit(self, value)),
);

/**
 * Updates the value by applying `f` to the current value, then
 * publishes the new value to {@link changes}. The read/apply/write
 * triple is atomic across fibers.
 */
export const update: {
  <A>(fn: (a: A) => A): <E, R>(self: State<A, E, R>) => Effect.Effect<void, E, R>;
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<void, E, R>;
} = dual(
  2,
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<void, E, R> =>
    Semaphore.withPermit(
      self.semaphore,
      Effect.flatMap(self.read, (a) => commit(self, fn(a))),
    ),
);

/**
 * Updates the value by applying `f`, publishes it, and returns the new
 * value. The read/apply/write triple is atomic across fibers.
 */
export const updateAndGet: {
  <A>(fn: (a: A) => A): <E, R>(self: State<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<A, E, R>;
} = dual(
  2,
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<A, E, R> =>
    Semaphore.withPermit(
      self.semaphore,
      Effect.flatMap(self.read, (a) => {
        const next = fn(a);
        return Effect.as(commit(self, next), next);
      }),
    ),
);

/**
 * Atomically replaces the value with the second element of `f(prev)`,
 * publishes it, and returns the first. The read/apply/write triple is
 * atomic across fibers.
 */
export const modify: {
  <A, Output>(
    fn: (a: A) => readonly [Output, A],
  ): <E, R>(self: State<A, E, R>) => Effect.Effect<Output, E, R>;
  <A, E, R, Output>(
    self: State<A, E, R>,
    fn: (a: A) => readonly [Output, A],
  ): Effect.Effect<Output, E, R>;
} = dual(
  2,
  <A, E, R, Output>(
    self: State<A, E, R>,
    fn: (a: A) => readonly [Output, A],
  ): Effect.Effect<Output, E, R> =>
    Semaphore.withPermit(
      self.semaphore,
      Effect.flatMap(self.read, (a) => {
        const [output, next] = fn(a);
        return Effect.as(commit(self, next), output);
      }),
    ),
);

/**
 * Stream of every value published to this `State`. New subscribers
 * immediately see the most recent value (replay = 1), then every
 * subsequent publish.
 */
export const changes = <A, E, R>(self: State<A, E, R>): Stream.Stream<A> =>
  Stream.fromPubSub(self.pubsub);

/**
 * Publish a value to the change stream as an `Effect`. Does not write
 * the underlying store. Acquires the per-`State` semaphore so an
 * external feed (e.g. a future durable-store change callback) can
 * publish committed changes WITHOUT interleaving with an in-flight
 * `set`/`update`/`modify` — the change-stream order then matches the
 * write order. Mirrors Rivet's adapter, which serializes its
 * `onStateChange` publication under the same lock
 * (`ActorStateAdapter.ts`). Use {@link publishUnsafe} for the
 * un-serialized fast path.
 */
export const publish: {
  <A>(value: A): <E, R>(self: State<A, E, R>) => Effect.Effect<boolean>;
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean>;
} = dual(
  2,
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean> =>
    Semaphore.withPermit(self.semaphore, publishDirect(self, value)),
);

/**
 * Synchronous, UN-serialized variant of {@link publish}. Returns `true`
 * when the publish succeeded, `false` if the pubsub is shut down. Does
 * not acquire the semaphore — callers are responsible for ordering.
 */
export const publishUnsafe = <A, E, R>(self: State<A, E, R>, value: A): boolean =>
  PubSub.publishUnsafe(self.pubsub, value);

/**
 * Publishes to the change stream WITHOUT acquiring the semaphore.
 * Internal — every caller already holds the permit (`commit` holds it
 * for the whole write/apply/write/publish sequence; `publish` acquires
 * it before delegating here), so the change-stream order is consistent
 * with the write order.
 */
const publishDirect = <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean> =>
  PubSub.publish(self.pubsub, value);

/**
 * Writes the value to the backing store and, on success, publishes it
 * to the change stream so {@link changes} observes every committed
 * write. A failed `write` does not publish. Internal — callers hold the
 * semaphore, so the write/publish pair is ordered with respect to other
 * mutators (and to {@link publish}, which acquires the same lock).
 *
 * This is the one deliberate divergence from Rivet's `State` (whose
 * mutators only `write` — the change stream is fed externally by
 * rivetkit's `onStateChange` store callback). The vendored runtime has
 * no such store callback for the in-process `SubscriptionRef`-backed
 * cell this module ships, so `State` self-feeds its stream here.
 *
 * Phase 3 NOTE: when a durable backing with its OWN change callback is
 * wired (see docs/adr/0001 §RESOLUTION + Phase 3 task), this
 * self-publish must be reconciled to avoid double-emitting — either
 * route durable writes through a `write` that does not publish, or
 * dedupe the store callback against this publish. The external callback
 * should publish via {@link publish} (serialized), not `publishUnsafe`.
 */
const commit = <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R> =>
  Effect.flatMap(self.write(value), () => Effect.asVoid(publishDirect(self, value)));
