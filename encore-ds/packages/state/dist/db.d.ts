import { ChangeEvent, ChangeHeaders, CollectionDefinition, CollectionEventHelpers, CollectionWithHelpers, ControlEvent, MaterializedState$1 as MaterializedState, Operation, Row, StateEvent, StateSchema, StreamStateDefinition, Value, createStateSchema$1 as createStateSchema, isChangeEvent$1 as isChangeEvent, isControlEvent$1 as isControlEvent } from "./index-D6Nak3Wl.js";
import { Collection, Collection as Collection$1, SyncConfig, and, avg, coalesce, concat, count, createCollection, createLiveQueryCollection, createOptimisticAction, createOptimisticAction as createOptimisticAction$1, createTransaction, deepEquals, eq, gt, gte, ilike, inArray, isNull, isUndefined, like, localOnlyCollectionOptions, lt, lte, max, min, not, or, queryOnce, sum, toArray } from "@tanstack/db";
import { DurableStream, DurableStreamOptions, JsonBatch, LiveMode } from "@durable-streams/client";

//#region src/stream-db.d.ts
/**
* Definition for a single action that can be passed to createOptimisticAction
*/

/**
* Definition for a single action that can be passed to createOptimisticAction
*/
interface ActionDefinition<TParams = any, TContext = any> {
  onMutate: (params: TParams) => void;
  mutationFn: (params: TParams, context: TContext) => Promise<any>;
}
/**
* Factory function for creating actions with access to db and stream context
*/
type ActionFactory<TDef extends StreamStateDefinition, TActions extends Record<string, ActionDefinition<any>>> = (context: {
  db: StreamDB<TDef>;
  stream: DurableStream;
}) => TActions;
/**
* Map action definitions to callable action functions
*/
type ActionMap<TActions extends Record<string, ActionDefinition<any>>> = { [K in keyof TActions]: ReturnType<typeof createOptimisticAction$1<any>> };
/**
* Options for creating a stream DB
*/
interface CreateStreamDBOptions<TDef extends StreamStateDefinition = StreamStateDefinition, TActions extends Record<string, ActionDefinition<any>> = Record<string, never>> {
  /** Options for creating a new durable stream. Ignored when `stream` is provided. */
  streamOptions?: DurableStreamOptions;
  /** Pre-existing DurableStream instance to reuse (avoids creating a second connection). */
  stream?: DurableStream;
  /** Live read mode used by the StreamDB consumer. Defaults to true. */
  live?: LiveMode;
  /** The stream state definition */
  state: TDef;
  /** Optional factory function to create actions with db and stream context */
  actions?: ActionFactory<TDef, TActions>;
  /** Called for every ChangeEvent as it flows through the stream consumer. */
  onEvent?: (event: ChangeEvent) => void;
  /**
  * Called once per consumed stream batch before items are dispatched.
  * Useful when external consumers need batch metadata available during
  * downstream collection/effect processing.
  */
  onBeforeBatch?: (batch: JsonBatch<StateEvent>) => void;
  /**
  * Called once per consumed stream batch after items have been dispatched.
  * Useful for tracking safe offsets for external ack/lease protocols.
  */
  onBatch?: (batch: JsonBatch<StateEvent>) => void;
}
/**
* Extract the value type from a CollectionDefinition
*/
type ExtractCollectionType<T extends CollectionDefinition> = T extends CollectionDefinition<infer U> ? U : unknown;
/**
* Map collection definitions to TanStack DB Collection types
*/
type CollectionMap<TDef extends StreamStateDefinition> = { [K in keyof TDef]: Collection$1<ExtractCollectionType<TDef[K]> & object, string> };
/**
* The StreamDB interface - provides typed access to collections
*/
type StreamDB<TDef extends StreamStateDefinition> = {
  collections: CollectionMap<TDef>;
} & StreamDBMethods;
/**
* StreamDB with actions
*/
type StreamDBWithActions<TDef extends StreamStateDefinition, TActions extends Record<string, ActionDefinition<any>>> = StreamDB<TDef> & {
  actions: ActionMap<TActions>;
};
/**
* Utility methods available on StreamDB
*/
interface StreamDBUtils {
  /**
  * Wait for a specific transaction ID to be synced through the stream
  * @param txid The transaction ID to wait for (UUID string)
  * @param timeout Optional timeout in milliseconds (defaults to 5000ms)
  * @returns Promise that resolves when the txid is synced
  */
  awaitTxId: (txid: string, timeout?: number) => Promise<void>;
}
/**
* Methods available on a StreamDB instance
*/
interface StreamDBMethods {
  /**
  * The underlying DurableStream instance
  */
  stream: DurableStream;
  /**
  * Current stream offset (tracks the last consumed position).
  */
  readonly offset: string;
  /**
  * Preload all collections by consuming the stream until up-to-date
  */
  preload: () => Promise<void>;
  /**
  * Close the stream connection and cleanup
  */
  close: () => void;
  /**
  * Utility methods for advanced stream operations
  */
  utils: StreamDBUtils;
}
/**
* Build a TanStack collection id for a StreamDB collection.
*
* Collection ids must be unique per source stream, not just per schema key,
* otherwise joining the same collection name from two different streams can
* collapse to one logical source inside TanStack DB.
*/
declare function getStreamDBCollectionId(streamUrl: string, collectionName: string): string;
/**
* Create a stream-backed database with TanStack DB collections
*
* This function is synchronous - it creates the stream handle and collections
* but does not start the stream connection. Call `db.preload()` to connect
* and sync initial data.
*
* @example
* ```typescript
* const stateSchema = createStateSchema({
*   users: { schema: userSchema, type: "user", primaryKey: "id" },
*   messages: { schema: messageSchema, type: "message", primaryKey: "id" },
* })
*
* // Create a stream DB (synchronous - stream is created lazily on preload)
* const db = createStreamDB({
*   streamOptions: {
*     url: "https://api.example.com/streams/my-stream",
*     contentType: "application/json",
*   },
*   state: stateSchema,
* })
*
* // preload() creates the stream and loads initial data
* await db.preload()
* const user = await db.collections.users.get("123")
* ```
*/
declare function createStreamDB<TDef extends StreamStateDefinition, TActions extends Record<string, ActionDefinition<any>> = Record<string, never>>(options: CreateStreamDBOptions<TDef, TActions>): TActions extends Record<string, never> ? StreamDB<TDef> : StreamDBWithActions<TDef, TActions>;

//#endregion
export { ActionDefinition, ActionFactory, ActionMap, ChangeEvent, ChangeHeaders, Collection, CollectionDefinition, CollectionEventHelpers, CollectionWithHelpers, ControlEvent, CreateStreamDBOptions, MaterializedState, Operation, Row, StateEvent, StateSchema, StreamDB, StreamDBMethods, StreamDBUtils, StreamDBWithActions, StreamStateDefinition, SyncConfig, Value, and, avg, coalesce, concat, count, createCollection, createLiveQueryCollection, createOptimisticAction, createStateSchema, createStreamDB, createTransaction, deepEquals, eq, getStreamDBCollectionId, gt, gte, ilike, inArray, isChangeEvent, isControlEvent, isNull, isUndefined, like, localOnlyCollectionOptions, lt, lte, max, min, not, or, queryOnce, sum, toArray };