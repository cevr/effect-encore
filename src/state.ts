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
 * Modeled on rivet's `rivetkit-typescript/packages/effect/src/State.ts`.
 * Rivet's API is a DX target. Its runtime is not part of this module.
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
const Read = Symbol.for("effect-encore/state/State/read");
const Write = Symbol.for("effect-encore/state/State/write");
const Changes = Symbol.for("effect-encore/state/State/changes");
const ChangesPubSub = Symbol.for("effect-encore/state/State/changesPubSub");
const Lock = Symbol.for("effect-encore/state/State/lock");

/**
 * A view over a state cell with a subscribable change stream.
 *
 * - `A` — the value type
 * - `E` — the read/write closures' failure type (e.g. a schema's
 *         `SchemaError` when read/write decode/encode against a schema)
 * - `R` — the read/write closures' service requirements
 */
export interface ReadableState<A, E = never, R = never>
  extends Pipeable.Pipeable, InspectableInterface {
  readonly [Read]: Effect.Effect<A, E, R>;
  readonly [Changes]: Stream.Stream<A, E, R>;
}

export interface State<A, E = never, R = never> extends ReadableState<A, E, R>, Variance<A, E, R> {
  readonly [Write]: (value: A) => Effect.Effect<void, E, R>;
  readonly [ChangesPubSub]: PubSub.PubSub<A>;
  readonly [Lock]: Semaphore.Semaphore;
}

export const isState = <Input>(value: Input): value is Input & State<unknown, unknown> =>
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

const ReadableProto = {
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: ReadableState<unknown, unknown, unknown>) {
    return { _id: "ReadableState" };
  },
};

function makeStateObject<A, E, R>(): State<A, E, R>;
function makeStateObject(): object {
  return Object.create(Proto);
}

function makeReadableStateObject<A, E, R>(): ReadableState<A, E, R>;
function makeReadableStateObject(): object {
  return Object.create(ReadableProto);
}

/**
 * Creates a read-only state view over an existing source of truth.
 *
 * The constructor does not read or copy the current value. It preserves the
 * supplied read and change stream, including their error and requirement
 * channels. Use it when another service owns state mutation.
 */
export const makeReadable = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  changes: Stream.Stream<A, E, R>,
): ReadableState<A, E, R> => {
  const self = makeReadableStateObject<A, E, R>();
  Object.assign(self, {
    [Read]: read,
    [Changes]: changes,
  });
  return self;
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
  const self = makeStateObject<A, E, R>();
  Object.assign(self, {
    [Read]: read,
    [Write]: write,
    [Changes]: Stream.fromPubSub(pubsub),
    [ChangesPubSub]: pubsub,
    [Lock]: Semaphore.makeUnsafe(1),
  });
  return self;
});

/**
 * Reads the current value.
 */
export const get = <A, E, R>(self: ReadableState<A, E, R>): Effect.Effect<A, E, R> => self[Read];

/**
 * Replaces the value, then publishes it to {@link changes}. Serialized
 * with `update` / `modify` so writes happen in invocation order.
 */
export const set: {
  <A>(value: A): <E, R>(self: State<A, E, R>) => Effect.Effect<void, E, R>;
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R>;
} = dual(2, <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R> =>
  Semaphore.withPermit(self[Lock], commit(self, value)),
);

/**
 * Updates the value by applying `f` to the current value, then
 * publishes the new value to {@link changes}. The read/apply/write
 * triple is atomic across fibers.
 */
export const update: {
  <A>(fn: (a: A) => A): <E, R>(self: State<A, E, R>) => Effect.Effect<void, E, R>;
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<void, E, R>;
} = dual(2, <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<void, E, R> =>
  Semaphore.withPermit(
    self[Lock],
    Effect.flatMap(self[Read], (a) => commit(self, fn(a))),
  ),
);

/**
 * Updates the value by applying `f`, publishes it, and returns the new
 * value. The read/apply/write triple is atomic across fibers.
 */
export const updateAndGet: {
  <A>(fn: (a: A) => A): <E, R>(self: State<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<A, E, R>;
} = dual(2, <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<A, E, R> =>
  Semaphore.withPermit(
    self[Lock],
    Effect.flatMap(self[Read], (a) => {
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
      self[Lock],
      Effect.flatMap(self[Read], (a) => {
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
export const changes = <A, E, R>(self: ReadableState<A, E, R>): Stream.Stream<A, E, R> =>
  self[Changes];

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
} = dual(2, <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean> =>
  Semaphore.withPermit(self[Lock], publishDirect(self, value)),
);

/**
 * Synchronous, UN-serialized variant of {@link publish}. Returns `true`
 * when the publish succeeded, `false` if the pubsub is shut down. Does
 * not acquire the semaphore — callers are responsible for ordering.
 */
export const publishUnsafe = <A, E, R>(self: State<A, E, R>, value: A): boolean =>
  PubSub.publishUnsafe(self[ChangesPubSub], value);

/**
 * Publishes to the change stream WITHOUT acquiring the semaphore.
 * Internal — every caller already holds the permit (`commit` holds it
 * for the whole write/apply/write/publish sequence; `publish` acquires
 * it before delegating here), so the change-stream order is consistent
 * with the write order.
 */
const publishDirect = <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean> =>
  PubSub.publish(self[ChangesPubSub], value);

/**
 * Writes the value to the backing store and, on success, publishes it
 * to the change stream so {@link changes} observes every committed
 * write. A failed `write` does not publish. Internal — callers hold the
 * semaphore, so the write/publish pair is ordered with respect to other
 * mutators (and to {@link publish}, which acquires the same lock).
 */
const commit = <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R> =>
  Effect.flatMap(self[Write](value), () => Effect.asVoid(publishDirect(self, value)));
