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

export const get = <A, E, R>(self: ReadableState<A, E, R>): Effect.Effect<A, E, R> => self[Read];

export const set: {
  <A>(value: A): <E, R>(self: State<A, E, R>) => Effect.Effect<void, E, R>;
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R>;
} = dual(2, <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R> =>
  Semaphore.withPermit(self[Lock], commit(self, value)),
);

export const update: {
  <A>(fn: (a: A) => A): <E, R>(self: State<A, E, R>) => Effect.Effect<void, E, R>;
  <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<void, E, R>;
} = dual(2, <A, E, R>(self: State<A, E, R>, fn: (a: A) => A): Effect.Effect<void, E, R> =>
  Semaphore.withPermit(
    self[Lock],
    Effect.flatMap(self[Read], (a) => commit(self, fn(a))),
  ),
);

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

export const changes = <A, E, R>(self: ReadableState<A, E, R>): Stream.Stream<A, E, R> =>
  self[Changes];

export const publish: {
  <A>(value: A): <E, R>(self: State<A, E, R>) => Effect.Effect<boolean>;
  <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean>;
} = dual(2, <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean> =>
  Semaphore.withPermit(self[Lock], publishDirect(self, value)),
);

export const publishUnsafe = <A, E, R>(self: State<A, E, R>, value: A): boolean =>
  PubSub.publishUnsafe(self[ChangesPubSub], value);

const publishDirect = <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<boolean> =>
  PubSub.publish(self[ChangesPubSub], value);

const commit = <A, E, R>(self: State<A, E, R>, value: A): Effect.Effect<void, E, R> =>
  Effect.flatMap(self[Write](value), () => Effect.asVoid(publishDirect(self, value)));
