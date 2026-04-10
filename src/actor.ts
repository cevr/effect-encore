import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import type { Rpc } from "effect/unstable/rpc";
import { Rpc as RpcMod } from "effect/unstable/rpc";
import type { Schema } from "effect";

// ── Operation DSL ──────────────────────────────────────────────────────────

export interface OperationConfig {
  readonly payload?: Schema.Struct.Fields;
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
  readonly persisted?: boolean;
  readonly primaryKey?: (payload: never) => string;
}

export type OperationConfigs = Record<string, OperationConfig>;

// ── Type-level Rpc mirror ──────────────────────────────────────────────────
// Reconstructs the Rpc type from our config DSL at the type level.
// The runtime loop compiles configs to Rpcs dynamically — this mirror
// tells TypeScript what those Rpcs would be.

type PayloadOf<C extends OperationConfig> = C extends {
  readonly payload: infer P extends Schema.Struct.Fields;
}
  ? Schema.Struct<P>
  : typeof Schema.Void;

type SuccessOf<C extends OperationConfig> = C extends {
  readonly success: infer S extends Schema.Top;
}
  ? S
  : typeof Schema.Void;

type ErrorOf<C extends OperationConfig> = C extends {
  readonly error: infer E extends Schema.Top;
}
  ? E
  : typeof Schema.Never;

export type OperationRpc<Tag extends string, C extends OperationConfig> = Rpc.Rpc<
  Tag,
  PayloadOf<C>,
  SuccessOf<C>,
  ErrorOf<C>
>;

export type ActorRpcs<Ops extends OperationConfigs> = {
  readonly [Tag in keyof Ops & string]: OperationRpc<Tag, Ops[Tag]>;
}[keyof Ops & string];

// ── ActorDefinition ────────────────────────────────────────────────────────

export interface ActorDefinition<
  Name extends string = string,
  Ops extends OperationConfigs = OperationConfigs,
  Rpcs extends Rpc.Any = ActorRpcs<Ops>,
> {
  readonly _tag: "ActorDefinition";
  readonly name: Name;
  readonly operations: Ops;
  readonly entity: ClusterEntity.Entity<Name, Rpcs>;
}

export interface SingleActorDefinition<
  Name extends string = string,
  C extends OperationConfig = OperationConfig,
  R extends Rpc.Any = OperationRpc<Name, C>,
> {
  readonly _tag: "SingleActorDefinition";
  readonly name: Name;
  readonly operation: C;
  readonly operationTag: string;
  readonly entity: ClusterEntity.Entity<Name, R>;
}

// ── Compile runtime ────────────────────────────────────────────────────────

const compileRpc = (tag: string, config: OperationConfig): Rpc.Any => {
  const options: Record<string, unknown> = {};

  if (config["payload"]) options["payload"] = config["payload"];
  if (config["success"]) options["success"] = config["success"];
  if (config["error"]) options["error"] = config["error"];
  if (config["primaryKey"] && config["payload"]) {
    options["primaryKey"] = config["primaryKey"];
  }

  let rpc: Rpc.Any = (RpcMod.make as Function)(tag, options) as Rpc.Any;

  if (config["persisted"]) {
    rpc = (rpc as unknown as { annotate: Function }).annotate(
      ClusterSchema.Persisted,
      true,
    ) as Rpc.Any;
  }

  return rpc;
};

// ── Constructors ───────────────────────────────────────────────────────────

export const make = <const Name extends string, const Ops extends OperationConfigs>(
  name: Name,
  operations: Ops,
): ActorDefinition<Name, Ops> => {
  const rpcs = Object.entries(operations).map(([tag, config]) =>
    compileRpc(tag, config as OperationConfig),
  ) as unknown as ReadonlyArray<ActorRpcs<Ops>>;

  return {
    _tag: "ActorDefinition",
    name,
    operations,
    entity: Entity.make(name, rpcs as unknown as Array<ActorRpcs<Ops>>),
  };
};

export const single = <const Name extends string, const C extends OperationConfig>(
  name: Name,
  operation: C,
): SingleActorDefinition<Name, C> => {
  const rpc = compileRpc(name, operation);
  const entity = Entity.make(name, [rpc]) as unknown as ClusterEntity.Entity<
    Name,
    OperationRpc<Name, C>
  >;
  return { _tag: "SingleActorDefinition", name, operation, operationTag: name, entity };
};

// ── Escape hatch: raw Rpc definitions ──────────────────────────────────────

export const from = <const Name extends string, const Rpcs extends ReadonlyArray<Rpc.Any>>(
  name: Name,
  rpcs: Rpcs,
): {
  readonly _tag: "ActorDefinition";
  readonly name: Name;
  readonly entity: ClusterEntity.Entity<Name, Rpcs[number]>;
} => ({
  _tag: "ActorDefinition",
  name,
  entity: Entity.make(name, rpcs as unknown as Array<Rpcs[number]>),
});
