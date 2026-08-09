import type { DateTime } from "effect";
import { Schema } from "effect";
import type { Entity as ClusterEntity } from "effect/unstable/cluster";
import type { ExecId } from "./receipt.js";
import { ExecIdCodec } from "./receipt.js";

export type EntityIdReturn = string | { readonly entityId: string; readonly primaryKey?: string };

export interface OperationDef {
  readonly payload?: Schema.Top | Schema.Struct.Fields;
  readonly success?: Schema.Top;
  readonly error?: Schema.Top;
  readonly persisted?: boolean;
  readonly id: (payload: never) => EntityIdReturn;
  readonly deliverAt?: (payload: never) => DateTime.DateTime;
}

export type OperationDefs = Record<string, OperationDef>;

export interface OperationIdentity {
  readonly entityId: string;
  readonly primaryKey: string;
  readonly execId: ExecId;
}

export interface Invocation {
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity protocols are type-erased inside transport.
  readonly entity: ClusterEntity.Entity<string, any>;
  readonly tag: string;
  readonly definition: OperationDef;
  readonly payload: unknown;
  readonly operation: { readonly _tag: string; readonly [key: string]: unknown };
  readonly identity: OperationIdentity;
}

export const isOpaquePayload = (payload: unknown): boolean =>
  Schema.isSchema(payload) && !("fields" in (payload as object));

export const resolveId = (
  definition: OperationDef | undefined,
  payload: unknown,
  fallbackTag: string,
): { readonly entityId: string; readonly primaryKey: string } => {
  const id = definition?.id;
  if (id === undefined) {
    return { entityId: fallbackTag, primaryKey: fallbackTag };
  }
  const result = id(payload as never);
  if (typeof result === "string") {
    return { entityId: result, primaryKey: result };
  }
  return { entityId: result.entityId, primaryKey: result.primaryKey ?? result.entityId };
};

export const makeOperationValue = (
  definition: OperationDef | undefined,
  tag: string,
  payload: unknown,
): { readonly _tag: string; readonly [key: string]: unknown } => {
  if (definition?.payload !== undefined && isOpaquePayload(definition.payload)) {
    return { _tag: tag, _payload: payload };
  }
  if (payload !== null && typeof payload === "object") {
    return Object.assign(Object.create(Object.getPrototypeOf(payload)), payload, { _tag: tag });
  }
  return { _tag: tag };
};

export const payloadFromOperation = (
  definition: OperationDef | undefined,
  operation: { readonly _tag: string; readonly [key: string]: unknown },
): unknown => {
  if (definition?.payload !== undefined && isOpaquePayload(definition.payload)) {
    return operation["_payload"];
  }
  return operation;
};

export const compileInvocation = (
  // eslint-disable-next-line typescript-eslint/no-explicit-any -- Entity protocols are type-erased inside transport.
  entity: ClusterEntity.Entity<string, any>,
  tag: string,
  definition: OperationDef,
  payload: unknown,
): Invocation => {
  const operation = makeOperationValue(definition, tag, payload);
  const { entityId, primaryKey } = resolveId(definition, payload, tag);
  return {
    entity,
    tag,
    definition,
    payload,
    operation,
    identity: {
      entityId,
      primaryKey,
      execId: ExecIdCodec.encode({ entityId, tag, primaryKey }),
    },
  };
};
