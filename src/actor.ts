import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import type { Rpc } from "effect/unstable/rpc";
import { Rpc as RpcMod } from "effect/unstable/rpc";

export interface OperationDefinition {
  readonly payload?: Record<string, unknown>;
  readonly success?: unknown;
  readonly error?: unknown;
  readonly persisted?: boolean;
  readonly primaryKey?: (payload: never) => string;
}

export type OperationDefinitions = Record<string, OperationDefinition>;

export interface ActorDefinition<
  Name extends string = string,
  Ops extends OperationDefinitions = OperationDefinitions,
> {
  readonly _tag: "ActorDefinition";
  readonly name: Name;
  readonly operations: Ops;
  readonly entity: ClusterEntity.Entity<Name, Rpc.Any>;
  readonly rpcs: ReadonlyMap<string, Rpc.Any>;
}

const compileRpc = (tag: string, def: OperationDefinition): Rpc.Any => {
  const options: Record<string, unknown> = {};

  if (def["payload"]) {
    options["payload"] = def["payload"];
  }
  if (def["success"]) {
    options["success"] = def["success"];
  }
  if (def["error"]) {
    options["error"] = def["error"];
  }
  if (def["primaryKey"] && def["payload"]) {
    options["primaryKey"] = def["primaryKey"];
  }

  let rpc: Rpc.Any = (RpcMod.make as Function)(tag, options) as Rpc.Any;

  if (def["persisted"]) {
    rpc = (rpc as unknown as { annotate: Function }).annotate(
      ClusterSchema.Persisted,
      true,
    ) as Rpc.Any;
  }

  return rpc;
};

export const make = <const Name extends string, const Ops extends OperationDefinitions>(
  name: Name,
  operations: Ops,
): ActorDefinition<Name, Ops> => {
  const rpcs = new Map<string, Rpc.Any>();
  const rpcArray: Array<Rpc.Any> = [];

  for (const [tag, def] of Object.entries(operations)) {
    const rpc = compileRpc(tag, def);
    rpcs.set(tag, rpc);
    rpcArray.push(rpc);
  }

  const entity = Entity.make(name, rpcArray);

  return {
    _tag: "ActorDefinition",
    name,
    operations,
    entity,
    rpcs,
  };
};
