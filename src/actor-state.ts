import { CurrentAddress } from "effect/unstable/cluster/Entity";
import type { EntityAddress } from "effect/unstable/cluster";
import { Context, Data, Effect, Layer, Option, Ref, Stream } from "effect";
import type { Scope } from "effect";
import * as State from "./state.js";

export class ActorStateUnavailable extends Data.TaggedError(
  "effect-encore/actor-state/ActorStateUnavailable",
)<{
  readonly entityType: string;
  readonly entityId: string;
}> {}

/**
 * What the registry keys on: entity type plus entity id. A full
 * `EntityAddress` satisfies it structurally, so callers that already hold one
 * pass it as-is; callers that only know the type and id need not invent a
 * `ShardId` to read state.
 */
export interface ActorStateKey {
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * Registry-internal read-only view of an entity's live state: a current-value
 * read plus a change stream. Derived from a {@link State.State} by
 * {@link registerState}; the public state vocabulary is `State<A>`. Not
 * exported — the package barrel surfaces `State<A>` (see `index.ts`), not this
 * handle.
 */
interface ActorStateHandle<StateValue, Error = never> {
  readonly get: Effect.Effect<StateValue, Error>;
  readonly watch: Stream.Stream<StateValue, Error>;
}

type AnyActorStateHandle = ActorStateHandle<unknown, unknown>;

function eraseActorStateHandle<StateValue, Error>(
  handle: ActorStateHandle<StateValue, Error>,
): AnyActorStateHandle;
function eraseActorStateHandle(handle: AnyActorStateHandle): AnyActorStateHandle {
  return handle;
}

function restoreActorStateHandle<StateValue, Error>(
  handle: AnyActorStateHandle,
): ActorStateHandle<StateValue, Error>;
function restoreActorStateHandle(handle: AnyActorStateHandle): AnyActorStateHandle {
  return handle;
}

export interface ActorStateRegistryService {
  readonly register: (
    address: EntityAddress.EntityAddress,
    handle: AnyActorStateHandle,
  ) => Effect.Effect<void>;
  readonly deregister: (
    address: EntityAddress.EntityAddress,
    handle: AnyActorStateHandle,
  ) => Effect.Effect<void>;
  readonly get: (key: ActorStateKey) => Effect.Effect<AnyActorStateHandle, ActorStateUnavailable>;
  readonly list: (entityType: string) => Effect.Effect<ReadonlyArray<string>>;
}

export class ActorStateRegistry extends Context.Service<
  ActorStateRegistry,
  ActorStateRegistryService
>()("effect-encore/actor-state/ActorStateRegistry") {
  static Live: Layer.Layer<ActorStateRegistry> = Layer.effect(
    ActorStateRegistry,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyMap<string, AnyActorStateHandle>>(new Map());

      return ActorStateRegistry.of({
        register: (address, handle) =>
          Ref.update(entries, (current) => {
            const next = new Map(current);
            next.set(addressKey(address), handle);
            return next;
          }),
        deregister: (address, handle) =>
          Ref.update(entries, (current) => {
            const key = addressKey(address);
            if (current.get(key) !== handle) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          }),
        get: (key) =>
          Ref.get(entries).pipe(
            Effect.flatMap((current) => {
              const handle = Option.fromNullishOr(current.get(addressKey(key)));
              if (Option.isNone(handle)) {
                return Effect.fail(
                  new ActorStateUnavailable({
                    entityType: String(key.entityType),
                    entityId: String(key.entityId),
                  }),
                );
              }
              return Effect.succeed(handle.value);
            }),
          ),
        list: (entityType) =>
          Ref.get(entries).pipe(
            Effect.map((current) =>
              Array.from(current.keys()).flatMap((key) => {
                const parsed = parseAddressKey(key);
                if (parsed.entityType !== entityType) return [];
                return [parsed.entityId];
              }),
            ),
          ),
      });
    }),
  );
}

export const registerState = <A, Error = never, Requirements = never>(
  state: State.ReadableState<A, Error, Requirements>,
): Effect.Effect<void, never, ActorStateRegistry | CurrentAddress | Scope.Scope | Requirements> =>
  Effect.gen(function* () {
    const registry = yield* ActorStateRegistry;
    const address = yield* CurrentAddress;
    const context = yield* Effect.context<Requirements>();
    const handle = {
      get: Effect.provideContext(State.get(state), context),
      watch: Stream.provideContext(State.changes(state), context),
    } satisfies ActorStateHandle<A, Error>;
    const erased = eraseActorStateHandle(handle);
    yield* registry.register(address, erased);
    yield* Effect.addFinalizer(() => registry.deregister(address, erased));
  });

export const stateOf = <State, Error = never>(
  key: ActorStateKey,
): Effect.Effect<State, Error | ActorStateUnavailable, ActorStateRegistry> =>
  Effect.gen(function* () {
    const registry = yield* ActorStateRegistry;
    const erased = yield* registry.get(key);
    const handle = restoreActorStateHandle<State, Error>(erased);
    return yield* handle.get;
  });

export const watchStateOf = <State, Error = never>(
  key: ActorStateKey,
): Stream.Stream<State, Error | ActorStateUnavailable, ActorStateRegistry> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* ActorStateRegistry;
      const erased = yield* registry.get(key);
      const handle = restoreActorStateHandle<State, Error>(erased);
      return handle.watch;
    }),
  );

export const listStateEntityIds = (
  entityType: string,
): Effect.Effect<ReadonlyArray<string>, never, ActorStateRegistry> =>
  Effect.gen(function* () {
    const registry = yield* ActorStateRegistry;
    return yield* registry.list(entityType);
  });

export const waitForStateOf = <State, Error = never>(
  key: ActorStateKey,
  predicate: (state: State) => boolean,
): Effect.Effect<State, Error | ActorStateUnavailable, ActorStateRegistry> =>
  watchStateOf<State, Error>(key).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap((option) =>
      Option.match(option, {
        onNone: () =>
          Effect.die(
            new Error(
              `effect-encore/waitForStateOf: state stream ended before predicate matched for ${String(key.entityType)}:${String(key.entityId)}`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

export interface ActorStateObservation<State, Error, Requirements> {
  readonly get: (
    key: ActorStateKey,
  ) => Effect.Effect<State, Error | ActorStateUnavailable, ActorStateRegistry | Requirements>;
  readonly watch: (
    key: ActorStateKey,
  ) => Stream.Stream<State, Error | ActorStateUnavailable, ActorStateRegistry | Requirements>;
  readonly waitFor: (
    key: ActorStateKey,
    predicate: (state: State) => boolean,
  ) => Effect.Effect<State, Error | ActorStateUnavailable, ActorStateRegistry | Requirements>;
}

export const makeActorStateObservation = <Input, State, Error, Requirements>(options: {
  readonly decodeState: (value: Input) => Effect.Effect<State, Error, Requirements>;
  readonly decodeFailure: (cause: unknown) => Effect.Effect<never, Error, Requirements>;
}): ActorStateObservation<State, Error, Requirements> => {
  const watch = (key: ActorStateKey) =>
    watchStateOf<Input, Error>(key).pipe(
      Stream.catch((cause: Error | ActorStateUnavailable) =>
        Stream.fromEffect(options.decodeFailure(cause)),
      ),
      Stream.mapEffect(options.decodeState),
    );

  return {
    get: (key) =>
      stateOf<Input, Error>(key).pipe(
        Effect.catch(options.decodeFailure),
        Effect.flatMap(options.decodeState),
      ),
    watch,
    waitFor: (key, predicate) =>
      watch(key).pipe(
        Stream.filter(predicate),
        Stream.runHead,
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () =>
              Effect.die(
                new Error(
                  `effect-encore/waitForState: state stream ended before predicate matched for ${String(key.entityType)}:${String(key.entityId)}`,
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
  };
};

const addressKey = (key: ActorStateKey): string =>
  `${String(key.entityType)}\x00${String(key.entityId)}`;

interface AddressKeyParts {
  readonly entityType: string;
  readonly entityId: string;
}

const parseAddressKey = (key: string): AddressKeyParts => {
  const first = key.indexOf("\x00");
  if (first < 0) {
    return { entityType: key, entityId: "" };
  }
  return { entityType: key.slice(0, first), entityId: key.slice(first + 1) };
};
