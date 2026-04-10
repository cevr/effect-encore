import type { Entity as ClusterEntity, ShardingConfig, Sharding } from "effect/unstable/cluster";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import * as DeliverAt from "effect/unstable/cluster/DeliverAt";
import type { Rpc, RpcClient } from "effect/unstable/rpc";
import { Rpc as RpcMod } from "effect/unstable/rpc";
import { Effect, PrimaryKey, Schema } from "effect";
import type { DateTime, Layer, Scope } from "effect";
import type { CastReceipt } from "./receipt.js";
import { makeCastReceipt } from "./receipt.js";

// ── Operation DSL ──────────────────────────────────────────────────────────

export interface OperationDef {
  readonly input?: Schema.Top | Schema.Struct.Fields;
  readonly output?: Schema.Top;
  readonly error?: Schema.Top;
  readonly persisted?: boolean;
  readonly primaryKey?: (input: never) => string;
  readonly deliverAt?: (input: never) => DateTime.DateTime;
}

export type OperationDefs = Record<string, OperationDef>;

// ── Type-level Rpc mirror ──────────────────────────────────────────────────

type InputOf<C extends OperationDef> = C extends {
  readonly input: infer P extends Schema.Top;
}
  ? P
  : C extends { readonly input: infer F extends Schema.Struct.Fields }
    ? Schema.Struct<F>
    : typeof Schema.Void;

type OutputOf<C extends OperationDef> = C extends {
  readonly output: infer S extends Schema.Top;
}
  ? S
  : typeof Schema.Void;

type ErrorOf<C extends OperationDef> = C extends {
  readonly error: infer E extends Schema.Top;
}
  ? E
  : typeof Schema.Never;

type DefRpc<Tag extends string, C extends OperationDef> = Rpc.Rpc<
  Tag,
  InputOf<C>,
  OutputOf<C>,
  ErrorOf<C>
>;

type DefRpcs<Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: DefRpc<Tag, Defs[Tag]>;
}[keyof Defs & string];

// ── OperationValue brand ───────────────────────────────────────────────────

declare const OperationBrandId: unique symbol;

export interface OperationBrand<Name extends string, Tag extends string, Output, Error> {
  readonly [OperationBrandId]: {
    readonly name: Name;
    readonly tag: Tag;
    readonly output: Output;
    readonly error: Error;
  };
}

export type OperationOutput<V> = V extends {
  readonly [OperationBrandId]: { readonly output: infer A };
}
  ? A
  : never;

export type OperationError<V> = V extends {
  readonly [OperationBrandId]: { readonly error: infer E };
}
  ? E
  : never;

// ── OperationValue types ───────────────────────────────────────────────────

type OperationValue<Name extends string, Tag extends string, C extends OperationDef> = {
  readonly _tag: Tag;
} & InputFieldsType<C> &
  OperationBrand<Name, Tag, Schema.Schema.Type<OutputOf<C>>, Schema.Schema.Type<ErrorOf<C>>>;

type InputFieldsType<C extends OperationDef> = C extends {
  readonly input: infer F extends Schema.Struct.Fields;
}
  ? { readonly [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never> }
  : C extends { readonly input: infer P extends Schema.Top }
    ? Schema.Schema.Type<P>
    : {};

type OperationConstructorInput<C extends OperationDef> = C extends {
  readonly input: infer F extends Schema.Struct.Fields;
}
  ? {} extends { [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never> }
    ? []
    : [
        input: {
          readonly [K in keyof F]: Schema.Schema.Type<F[K] extends Schema.Top ? F[K] : never>;
        },
      ]
  : C extends { readonly input: infer _P extends Schema.Top }
    ? [input: unknown]
    : [];

type OperationConstructor<Name extends string, Tag extends string, C extends OperationDef> = (
  ...args: OperationConstructorInput<C>
) => OperationValue<Name, Tag, C>;

// ── Union of all OperationValues for an actor ──────────────────────────────

type OperationUnion<Name extends string, Defs extends OperationDefs> = {
  [Tag in keyof Defs & string]: OperationValue<Name, Tag, Defs[Tag]>;
}[keyof Defs & string];

// ── ActorRef — value-dispatch ref ──────────────────────────────────────────

export interface ActorRef<Name extends string, Defs extends OperationDefs> {
  readonly call: <V extends OperationUnion<Name, Defs>>(
    op: V,
  ) => Effect.Effect<OperationOutput<V>, OperationError<V>>;
  readonly cast: <V extends OperationUnion<Name, Defs>>(op: V) => Effect.Effect<CastReceipt>;
}

// ── Handler types ──────────────────────────────────────────────────────────

type HandlerRequest<Tag extends string, C extends OperationDef> = {
  readonly operation: { readonly _tag: Tag } & InputFieldsType<C>;
  readonly request: unknown;
};

type Handlers<Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: (req: HandlerRequest<Tag, Defs[Tag]>) => Effect.Effect<
    Schema.Schema.Type<OutputOf<Defs[Tag]>>,
    Schema.Schema.Type<ErrorOf<Defs[Tag]>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler requirements must be open
    any
  >;
};

export interface HandlerOptions {
  readonly spanAttributes?: Record<string, string>;
  readonly maxIdleTime?: number;
  readonly concurrency?: number | "unbounded";
  readonly mailboxCapacity?: number | "unbounded";
}

// ── ActorObject — the unified return type ──────────────────────────────────

type ActorConstructors<Name extends string, Defs extends OperationDefs> = {
  readonly [Tag in keyof Defs & string]: OperationConstructor<Name, Tag, Defs[Tag]>;
};

export type ActorObject<
  Name extends string,
  Defs extends OperationDefs,
  Rpcs extends Rpc.Any = DefRpcs<Defs>,
> = ActorConstructors<Name, Defs> & {
  readonly _tag: "ActorObject";
  readonly name: Name;
  readonly definitions: Defs;
  readonly entity: ClusterEntity.Entity<Name, Rpcs>;

  readonly handlers: <RX = never>(
    build: Handlers<Defs> | Effect.Effect<Handlers<Defs>, never, RX>,
    options?: HandlerOptions,
  ) => ReturnType<ClusterEntity.Entity<Name, Rpcs>["toLayer"]>;

  readonly client: Effect.Effect<
    (entityId: string) => ActorRef<Name, Defs>,
    never,
    Scope.Scope | Rpc.MiddlewareClient<Rpcs>
  >;

  readonly testClient: <LA = never, LE = never, LR = never>(
    handlerLayer: Layer.Layer<LA, LE, LR>,
  ) => Effect.Effect<
    (entityId: string) => Effect.Effect<ActorRef<Name, Defs>>,
    LE,
    | Scope.Scope
    | ShardingConfig.ShardingConfig
    | Exclude<LR, Sharding.Sharding>
    | Rpc.MiddlewareClient<Rpcs>
  >;

  readonly $is: <Tag extends keyof Defs & string>(
    tag: Tag,
  ) => (value: unknown) => value is OperationValue<Name, Tag, Defs[Tag]>;
};

// ── Compile runtime ────────────────────────────────────────────────────────

const compileRpc = (actorName: string, tag: string, def: OperationDef): Rpc.Any => {
  const options: Record<string, unknown> = {};
  const input = def["input"];
  const pkFn = def["primaryKey"];
  const daFn = def["deliverAt"];

  if (input) {
    if (Schema.isSchema(input)) {
      options["payload"] = input;
    } else {
      const fields = input as Schema.Struct.Fields;

      const Base = Schema.Class<Record<string, unknown>>(
        `effect-actor/${actorName}/${tag}/Payload`,
      )(fields);

      class PayloadClass extends Base {}

      const proto = PayloadClass.prototype as Record<string | symbol, unknown>;

      if (pkFn) {
        proto[PrimaryKey.symbol] = function (this: unknown) {
          return (pkFn as Function)(this) as string;
        };
      }

      if (daFn) {
        proto[DeliverAt.symbol] = function (this: unknown) {
          return (daFn as Function)(this) as DateTime.DateTime;
        };
      }

      options["payload"] = PayloadClass;
    }
  }

  if (def["output"]) options["success"] = def["output"];
  if (def["error"]) options["error"] = def["error"];

  let rpc: Rpc.Any = (RpcMod.make as Function)(tag, options) as Rpc.Any;

  if (def["persisted"]) {
    rpc = (rpc as unknown as { annotate: Function }).annotate(
      ClusterSchema.Persisted,
      true,
    ) as Rpc.Any;
  }

  return rpc;
};

// ── Actor() — unified constructor ──────────────────────────────────────────

export const Actor = <const Name extends string, const Defs extends OperationDefs>(
  name: Name,
  definitions: Defs,
): ActorObject<Name, Defs> => {
  const rpcs = Object.entries(definitions).map(([tag, def]) =>
    compileRpc(name, tag, def as OperationDef),
  );

  const entity = Entity.make(name, rpcs as Array<DefRpcs<Defs>>);

  // Build constructors
  const constructors: Record<string, Function> = {};
  for (const tag of Object.keys(definitions)) {
    constructors[tag] = (input?: unknown) => ({
      _tag: tag,
      ...(input != null && typeof input === "object" ? input : {}),
    });
  }

  // Handlers wrapper: transforms { Tag: ({operation}) => ... } to { Tag: (request) => ... }
  const handlersMethod = (build: unknown, options?: HandlerOptions) => {
    const transformed = transformHandlers(build);
    return entity.toLayer(transformed as never, {
      spanAttributes: options?.spanAttributes,
      maxIdleTime: options?.maxIdleTime,
      concurrency: options?.concurrency,
      mailboxCapacity: options?.mailboxCapacity,
    });
  };

  // Client
  const clientEffect = Effect.map(
    entity.client,
    (makeClient: Function) =>
      (entityId: string): ActorRef<Name, Defs> =>
        buildActorRef(
          name,
          entityId,
          definitions,
          makeClient(entityId) as RpcClient.RpcClient<Rpc.Any, never>,
        ),
  );

  // Test client
  const testClientMethod = <LA, LE, LR>(handlerLayer: Layer.Layer<LA, LE, LR>) =>
    Effect.map(
      Entity.makeTestClient(entity, handlerLayer as never),
      (makeClient: Function) =>
        (entityId: string): Effect.Effect<ActorRef<Name, Defs>> =>
          Effect.map(
            makeClient(entityId) as Effect.Effect<RpcClient.RpcClient<Rpc.Any, never>>,
            (rpcClient) => buildActorRef(name, entityId, definitions, rpcClient),
          ),
    );

  // $is type guard
  const $is =
    (tag: string) =>
    (value: unknown): boolean =>
      value != null &&
      typeof value === "object" &&
      "_tag" in value &&
      (value as Record<string, unknown>)["_tag"] === tag;

  const actor = {
    _tag: "ActorObject" as const,
    name,
    definitions,
    entity,
    handlers: handlersMethod,
    client: clientEffect,
    testClient: testClientMethod,
    $is,
    ...constructors,
  };

  return actor as unknown as ActorObject<Name, Defs>;
};

// ── Transform handlers from operation-first to request-first ───────────────

const transformHandlers = (build: unknown): unknown => {
  if (build != null && typeof build === "object" && !Effect.isEffect(build)) {
    const handlers = build as Record<string, Function>;
    const transformed: Record<string, Function> = {};
    for (const tag of Object.keys(handlers)) {
      const handler = handlers[tag];
      if (!handler) continue;
      transformed[tag] = (request: Record<string, unknown>) => {
        const operation = { _tag: tag, ...((request["payload"] ?? {}) as object) };
        return handler({ operation, request });
      };
    }
    return transformed;
  }
  return Effect.map(build as Effect.Effect<unknown>, transformHandlers);
};

// ── buildActorRef — value-dispatch ref ─────────────────────────────────────

const buildActorRef = <Name extends string, Defs extends OperationDefs>(
  actorName: Name,
  entityId: string,
  definitions: Defs,
  rpcClient: RpcClient.RpcClient<Rpc.Any, never>,
): ActorRef<Name, Defs> => {
  const client = rpcClient as unknown as Record<string, Function>;

  return {
    call: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const tag = op["_tag"];
      const fn = client[tag];
      const def = definitions[tag] as OperationDef | undefined;
      const hasInput = def?.["input"] !== undefined;
      return hasInput ? fn?.(op) : fn?.();
    },
    cast: (op: { readonly _tag: string; readonly [key: string]: unknown }) => {
      const tag = op["_tag"];
      const fn = client[tag];
      const def = definitions[tag] as OperationDef | undefined;
      const hasInput = def?.["input"] !== undefined;
      const discardCall = hasInput
        ? fn?.(op, { discard: true })
        : fn?.(undefined, { discard: true });
      return Effect.map(discardCall ?? Effect.void, () =>
        makeCastReceipt({
          actorType: actorName,
          entityId,
          operation: tag,
          primaryKey: def?.["primaryKey"]
            ? ((def["primaryKey"] as Function)(op) as string)
            : undefined,
        }),
      );
    },
  } as ActorRef<Name, Defs>;
};

// ── Escape hatch: raw Rpc definitions ──────────────────────────────────────

export const fromRpcs = <const Name extends string, const Rpcs extends ReadonlyArray<Rpc.Any>>(
  name: Name,
  rpcs: Rpcs,
): {
  readonly _tag: "RawActorDefinition";
  readonly name: Name;
  readonly entity: ClusterEntity.Entity<Name, Rpcs[number]>;
} => ({
  _tag: "RawActorDefinition",
  name,
  entity: Entity.make(name, rpcs as unknown as Array<Rpcs[number]>),
});
