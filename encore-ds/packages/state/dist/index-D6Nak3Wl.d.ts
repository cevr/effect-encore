import { StandardSchemaV1 } from "@standard-schema/spec";

//#region src/types.d.ts
/**
* Operation types for change events
*/
/**
* Operation types for change events
*/
type Operation = `insert` | `update` | `delete` | `upsert`;
/**
* A generic value type supporting primitives, arrays, and objects
*/
type Value<Extensions = never> = string | number | boolean | bigint | null | Array<Value<Extensions>> | {
  [key: string]: Value<Extensions>;
} | Extensions;
/**
* A row is a record of values
*/
type Row<Extensions = never> = Record<string, Value<Extensions>>;
/**
* Headers for change messages
*/
type ChangeHeaders = {
  operation: Operation;
  txid?: string;
  timestamp?: string;
  from?: string;
  offset?: string;
};
/**
* A change event represents a state change event (insert/update/delete)
*/
type ChangeEvent<T = unknown> = {
  type: string;
  key: string;
  value?: T;
  old_value?: T;
  headers: ChangeHeaders;
};
/**
* Control event types for stream management
*/
type ControlEvent = {
  headers: {
    control: `snapshot-start` | `snapshot-end` | `reset`;
    offset?: string;
  };
};
/**
* A state event is either a change event or a control event
*/
type StateEvent<T = unknown> = ChangeEvent<T> | ControlEvent;
/**
* Type guard to check if an event is a change event
*/
declare function isChangeEvent<T = unknown>(event: StateEvent<T>): event is ChangeEvent<T>;
/**
* Type guard to check if an event is a control event
*/
declare function isControlEvent<T = unknown>(event: StateEvent<T>): event is ControlEvent;

//#endregion
//#region src/materialized-state.d.ts
/**
* MaterializedState maintains an in-memory view of state from change events.
*
* It organizes data by type, where each type contains a map of key -> value.
* This supports multi-type streams where different entity types can coexist.
*/
declare class MaterializedState {
  private data;
  constructor();
  /**
  * Apply a single change event to update the materialized state
  */
  apply(event: ChangeEvent): void;
  /**
  * Apply a batch of change events
  */
  applyBatch(events: Array<ChangeEvent>): void;
  /**
  * Get a specific value by type and key
  */
  get<T = unknown>(type: string, key: string): T | undefined;
  /**
  * Get all entries for a specific type
  */
  getType(type: string): Map<string, unknown>;
  /**
  * Clear all state
  */
  clear(): void;
  /**
  * Get the number of types in the state
  */
  get typeCount(): number;
  /**
  * Get all type names
  */
  get types(): Array<string>;
}

//#endregion
//#region src/schema.d.ts
/**
* Definition for a single collection in the stream state
*/
interface CollectionDefinition<T = unknown> {
  /** Standard Schema for validating values */
  schema: StandardSchemaV1<T>;
  /** The type field value in change events that map to this collection */
  type: string;
  /** The property name in T that serves as the primary key */
  primaryKey: string;
}
/**
* Helper methods for creating change events for a collection
*/
interface CollectionEventHelpers<T> {
  /**
  * Create an insert change event
  */
  insert: (params: {
    key?: string;
    value: T;
    headers?: Omit<Record<string, string>, `operation`>;
  }) => ChangeEvent<T>;
  /**
  * Create an update change event
  */
  update: (params: {
    key?: string;
    value: T;
    oldValue?: T;
    headers?: Omit<Record<string, string>, `operation`>;
  }) => ChangeEvent<T>;
  /**
  * Create a delete change event
  */
  delete: (params: {
    key?: string;
    oldValue?: T;
    headers?: Omit<Record<string, string>, `operation`>;
  }) => ChangeEvent<T>;
  /**
  * Create an upsert change event (insert or update)
  */
  upsert: (params: {
    key?: string;
    value: T;
    headers?: Omit<Record<string, string>, `operation`>;
  }) => ChangeEvent<T>;
}
/**
* Collection definition enhanced with event creation helpers
*/
type CollectionWithHelpers<T = unknown> = CollectionDefinition<T> & CollectionEventHelpers<T>;
/**
* Stream state definition containing all collections
*/
type StreamStateDefinition = Record<string, CollectionDefinition>;
/**
* Stream state schema with helper methods for creating change events
*/
type StateSchema<T extends Record<string, CollectionDefinition>> = { [K in keyof T]: CollectionWithHelpers<T[K] extends CollectionDefinition<infer U> ? U : unknown> };
/**
* Create a state schema definition with typed collections and event helpers
*/
declare function createStateSchema<T extends Record<string, CollectionDefinition>>(collections: T): StateSchema<T>;

//#endregion
export { ChangeEvent, ChangeHeaders, CollectionDefinition, CollectionEventHelpers, CollectionWithHelpers, ControlEvent, MaterializedState as MaterializedState$1, Operation, Row, StateEvent, StateSchema, StreamStateDefinition, Value, createStateSchema as createStateSchema$1, isChangeEvent as isChangeEvent$1, isControlEvent as isControlEvent$1 };