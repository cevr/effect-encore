import { CurrentAddress } from "effect/unstable/cluster/Entity";
import type { EntityAddress } from "effect/unstable/cluster";
import { Context, Data, Effect, Layer, Ref, Stream } from "effect";
import type { Scope } from "effect";

export class ActorStateUnavailable extends Data.TaggedError(
  "effect-encore/actor-state/ActorStateUnavailable",
)<{
  readonly entityType: string;
  readonly entityId: string;
}> {}

export interface ActorStateHandle<State, Error = never, Requirements = never> {
  readonly get: Effect.Effect<State, Error, Requirements>;
  readonly watch: Stream.Stream<State, Error, Requirements>;
}

type AnyActorStateHandle = ActorStateHandle<unknown, unknown, unknown>;

export interface ActorStateRegistryShape {
  readonly register: (
    address: EntityAddress.EntityAddress,
    handle: AnyActorStateHandle,
  ) => Effect.Effect<void>;
  readonly deregister: (
    address: EntityAddress.EntityAddress,
    handle: AnyActorStateHandle,
  ) => Effect.Effect<void>;
  readonly get: (
    address: EntityAddress.EntityAddress,
  ) => Effect.Effect<AnyActorStateHandle, ActorStateUnavailable>;
  readonly list: (entityType: string) => Effect.Effect<ReadonlyArray<string>>;
}

export class ActorStateRegistry extends Context.Service<
  ActorStateRegistry,
  ActorStateRegistryShape
>()("effect-encore/actor-state/ActorStateRegistry") {
  static Live: Layer.Layer<ActorStateRegistry> = Layer.effect(
    ActorStateRegistry,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyMap<string, AnyActorStateHandle>>(new Map());

      return {
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
        get: (address) =>
          Ref.get(entries).pipe(
            Effect.flatMap((current) => {
              const handle = current.get(addressKey(address));
              return handle === undefined
                ? Effect.fail(
                    new ActorStateUnavailable({
                      entityType: String(address.entityType),
                      entityId: String(address.entityId),
                    }),
                  )
                : Effect.succeed(handle);
            }),
          ),
        list: (entityType) =>
          Ref.get(entries).pipe(
            Effect.map((current) =>
              Array.from(current.keys()).flatMap((key) => {
                const parsed = parseAddressKey(key);
                return parsed.entityType === entityType ? [parsed.entityId] : [];
              }),
            ),
          ),
      };
    }),
  );
}

export const registerState = <State, Error = never, Requirements = never>(
  handle: ActorStateHandle<State, Error, Requirements>,
): Effect.Effect<void, never, ActorStateRegistry | CurrentAddress | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* ActorStateRegistry;
    const address = yield* CurrentAddress;
    const erased = handle as AnyActorStateHandle;
    yield* registry.register(address, erased);
    yield* Effect.addFinalizer(() => registry.deregister(address, erased));
  });

export const stateOf = <State, Error = never, Requirements = never>(
  address: EntityAddress.EntityAddress,
): Effect.Effect<State, Error | ActorStateUnavailable, ActorStateRegistry | Requirements> =>
  Effect.gen(function* () {
    const registry = yield* ActorStateRegistry;
    const handle = yield* registry.get(address);
    return yield* handle.get as Effect.Effect<State, Error, Requirements>;
  });

export const watchStateOf = <State, Error = never, Requirements = never>(
  address: EntityAddress.EntityAddress,
): Stream.Stream<State, Error | ActorStateUnavailable, ActorStateRegistry | Requirements> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* ActorStateRegistry;
      const handle = yield* registry.get(address);
      return handle.watch as Stream.Stream<State, Error, Requirements>;
    }),
  );

export const listStateEntityIds = (
  entityType: string,
): Effect.Effect<ReadonlyArray<string>, never, ActorStateRegistry> =>
  Effect.gen(function* () {
    const registry = yield* ActorStateRegistry;
    return yield* registry.list(entityType);
  });

const addressKey = (address: EntityAddress.EntityAddress): string =>
  `${String(address.entityType)}\x00${String(address.entityId)}`;

const parseAddressKey = (
  key: string,
): { readonly entityType: string; readonly entityId: string } => {
  const first = key.indexOf("\x00");
  return {
    entityType: first < 0 ? key : key.slice(0, first),
    entityId: first < 0 ? "" : key.slice(first + 1),
  };
};
