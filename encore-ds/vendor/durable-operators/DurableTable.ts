/**
 * DurableTable — ksql-inspired table declaration and action facade over
 * `@durable-streams/state`'s `createStreamDB`.
 */

import type { DurableStreamOptions } from "@durable-streams/client";
import { FetchHttpClient } from "effect/unstable/http";
import {
  createStateSchema,
  createStreamDB,
  type ActionDefinition,
  type ActionFactory,
  type CollectionDefinition as StateCollectionDefinition,
  type CreateStreamDBOptions,
  type Operation,
  type StateSchema,
  type StreamDBWithActions,
  type StreamStateDefinition,
} from "@durable-streams/state/db";
import type { ChangeMessage, Collection as TanStackCollection } from "@tanstack/db";
import { DurableStream } from "../durable-streams/index.ts";
import {
  type Brand,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { DurableTableError } from "./Errors.ts";

/**
 * A `Stream` that has gone through a `DurableTable.rows()` — i.e., is
 * replay-then-tail over a durable projection. Consumers that semantically
 * require this property (single-shot projectionWait, continuous projection
 * observers) declare it explicitly in their signatures.
 *
 * Structurally `ProjectionStream<A, E, R>` is a `Stream.Stream<A, E, R>` with
 * an Effect `Brand` intersection, so a `ProjectionStream` is assignable
 * anywhere a `Stream.Stream` is expected; the brand is erased at runtime.
 * The brand marks the SOURCE only — derived streams produced by Stream
 * combinators (filter, filterMap, map, …) return raw `Stream.Stream` and
 * lose the brand.
 */
export type ProjectionStream<A, E = never, R = never> = Stream.Stream<A, E, R> &
  Brand.Brand<"effect-durable-operators/ProjectionStream">;

const primaryKeyAnnotationId = Symbol.for("effect-durable-operators/DurableTable/primaryKey");
declare const primaryKeyTypeId: unique symbol;

interface PrimaryKeyField<DecodedKey> {
  readonly [primaryKeyTypeId]: DecodedKey;
}

// `Schema.Struct<any>` is the practical top type for Struct schemas here:
// Effect Schema's annotation methods are contravariant in their annotation
// parameter, so a more "precise" index-signature field type rejects ordinary
// concrete structs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StructSchema = Schema.Struct<any>;
type TableSchemas<Schemas> = {
  readonly [Key in keyof Schemas]: StructSchema;
};
type AnyTableSchemas = Record<string, StructSchema>;

export type RowOf<S extends Schema.Top> = Schema.Schema.Type<S>;

type FieldsOf<S> = S extends Schema.Struct<infer Fields> ? Fields : never;
type PrimaryKeyNameOf<S> = {
  readonly [Key in keyof FieldsOf<S>]: FieldsOf<S>[Key] extends PrimaryKeyField<unknown>
    ? Key
    : never;
}[keyof FieldsOf<S>] &
  string;

export type PrimaryKeyOf<S extends StructSchema> =
  PrimaryKeyNameOf<S> extends keyof FieldsOf<S>
    ? Schema.Schema.Type<FieldsOf<S>[PrimaryKeyNameOf<S>]>
    : never;

export interface LayerOptions {
  readonly streamOptions: DurableStreamOptions;
  readonly txTimeoutMs?: number;
}

export type DurableTableHeaders = Readonly<
  Record<string, string | (() => string | Promise<string>)>
>;

export type DurableTableCollection<Row extends object> = TanStackCollection<Row, string>;

export type InsertOrGetResult<Row> =
  | { readonly _tag: "Inserted"; readonly offset: DurableStream.Offset }
  | { readonly _tag: "Found"; readonly row: Row };

export interface CollectionFacade<Row extends object, Key> {
  /**
   * Read-only TanStack collection view for query engines and UI bindings.
   *
   * This collection decodes DurableTable primary-key fields on reads and
   * subscriptions. Data mutations through the collection view fail loudly;
   * callers must use the generated DurableTable insert/upsert/delete actions
   * so txid coordination and State Protocol event construction remain intact.
   */
  readonly collection: DurableTableCollection<Row>;
  /**
   * Current non-deleted rows plus live non-deleted row changes.
   */
  readonly rows: () => ProjectionStream<Row, DurableTableError>;
  readonly insert: (row: Row) => Effect.Effect<void, DurableTableError>;
  /**
   * Row-level insert-or-read by primary key.
   *
   * This is not a lock, claim, mutex, semaphore, lease, or general
   * coordination primitive.
   *
   * On `Inserted` the result carries the durable-stream append `offset`: the
   * row's arrival position in append order. For a per-stream collection it is a
   * monotonic per-stream arrival sequence (distinct concurrent inserts receive
   * distinct, lexicographically-ordered offsets). It is a read-only receipt of
   * an already-assigned position — not a writable sequence and not a
   * coordination token. `Found` carries no offset (a duplicate writes no event
   * and reports no position).
   */
  readonly insertOrGet: (row: Row) => Effect.Effect<InsertOrGetResult<Row>, DurableTableError>;
  readonly upsert: (row: Row) => Effect.Effect<void, DurableTableError>;
  readonly delete: (key: Key) => Effect.Effect<void, DurableTableError>;
  readonly get: (key: Key) => Effect.Effect<Option.Option<Row>, DurableTableError>;
  readonly query: <A>(
    build: (coll: TanStackCollection<Row, string>) => A,
  ) => Effect.Effect<A, DurableTableError>;
  readonly subscribe: <A>(
    subscribe: (coll: TanStackCollection<Row, string>, emit: (value: A) => void) => () => void,
  ) => Stream.Stream<A, DurableTableError>;
}

export type DurableTableService<Schemas extends TableSchemas<Schemas>> = {
  readonly [Name in keyof Schemas & string]: CollectionFacade<
    RowOf<Schemas[Name]> & object,
    PrimaryKeyOf<Schemas[Name]>
  >;
} & {
  readonly awaitTxId: (txid: string, timeoutMs?: number) => Effect.Effect<void, DurableTableError>;
};

// `Self` is bound to the resulting tag class so consumers' Effects that
// `yield* MyTable` get a precise requirements channel instead of `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DurableTableTagClass<
  Schemas extends TableSchemas<Schemas>,
  Self = any,
> = Context.Service<Self, DurableTableService<Schemas>> & {
  readonly namespace: string;
  readonly layer: (options: LayerOptions) => Layer.Layer<Self, DurableTableError>;
};

type CompiledCollection = {
  readonly collectionKey: string;
  readonly durableType: string;
  readonly primaryKey: string;
  readonly schema: StructSchema;
  readonly storeSchema: StructSchema;
  // Returns the schema-encoded primary-key value as-is. Callers that need
  // the durable-wire string form route through `requireString`, which
  // raises a typed DurableTableError on non-string values.
  readonly encodePrimaryKey: (decoded: unknown) => unknown;
  readonly decodePrimaryKey: (encoded: string) => unknown;
};

type CompiledTable<Schemas extends TableSchemas<Schemas>> = {
  readonly namespace: string;
  readonly schemas: Schemas;
  readonly collections: ReadonlyArray<CompiledCollection>;
};

type StateSchemaWithHelpers = StateSchema<StreamStateDefinition>;
type GeneratedOperation = Extract<Operation, "insert" | "upsert" | "delete">;
type TableActionDefinitions = Record<string, ActionDefinition<unknown>>;
type TableActionFactory = ActionFactory<StateSchemaWithHelpers, TableActionDefinitions>;
type TableStreamDB = StreamDBWithActions<StateSchemaWithHelpers, TableActionDefinitions>;
type TableActionMap = TableStreamDB["actions"];

const reservedFacadeProperties = new Set(["awaitTxId"]);

/**
 * `primaryKey` attaches the package-owned annotation used for AST-level
 * primary-key discovery. The field schema itself owns encode/decode behavior.
 *
 * - The pipeable form is the primary path: `Schema.String.pipe(primaryKey)`.
 * - For non-string-decoded primary keys, the user composes a Schema.transform
 *   themselves (e.g., for composite keys) and pipes it through `primaryKey`.
 *   The package never concatenates key parts at runtime.
 */
const primaryKey = <S extends Schema.Top>(schema: S): S & PrimaryKeyField<Schema.Schema.Type<S>> =>
  // v4 renamed `.annotations(...)` to `.annotate(...)`. The annotation map's
  // type index is string-keyed (`Annotations.Annotations`), but this package
  // keys its private discovery marker on a unique `symbol` to avoid collisions
  // with user annotations — cast through the symbol-keyed record.
  schema.annotate({
    [primaryKeyAnnotationId]: true,
  } as Record<symbol, unknown>) as S & PrimaryKeyField<Schema.Schema.Type<S>>;

const raise = (message: string): never => {
  throw new Error(message);
};

const isPrimaryKeyField = (schema: Schema.Top): boolean =>
  // `ast.annotations` is `Annotations | undefined` in v4, and the symbol
  // marker key sits outside the string-keyed annotation index — read it
  // through a symbol-keyed view.
  (schema.ast.annotations as Record<symbol, unknown> | undefined)?.[primaryKeyAnnotationId] ===
  true;

const actionName = (collectionKey: string, operation: GeneratedOperation): string =>
  `${collectionKey}.${operation}`;

const rowCountForQueryResult = (value: unknown): number | undefined =>
  Array.isArray(value) ? value.length : undefined;

const requireString = (collection: CompiledCollection, value: unknown): string => {
  if (typeof value !== "string") {
    return raise(
      `DurableTable("${collection.durableType}") primary-key field "${collection.primaryKey}" must encode to a string; got ${typeof value}`,
    );
  }
  return value;
};

const compileTable = <const Schemas extends TableSchemas<Schemas>>(
  namespace: string,
  schemas: Schemas,
): CompiledTable<Schemas> => {
  const collections = Object.entries(schemas).map(([collectionKey, schemaValue]) => {
    const schema = schemaValue as StructSchema;
    if (reservedFacadeProperties.has(collectionKey)) {
      return raise(
        `DurableTable("${namespace}") collection "${collectionKey}" collides with a table service property`,
      );
    }

    const fieldEntries = Object.entries(schema.fields) as Array<readonly [string, Schema.Top]>;
    const primaryKeyEntries = fieldEntries.filter(([, fieldSchema]) =>
      isPrimaryKeyField(fieldSchema),
    );

    if (primaryKeyEntries.length !== 1) {
      return raise(
        `DurableTable("${namespace}").${collectionKey} must declare exactly one DurableTable.primaryKey field; found ${primaryKeyEntries.length}`,
      );
    }

    const [primaryKeyName, primaryKeyFieldSchema] = primaryKeyEntries[0]!;
    const fieldSchema = primaryKeyFieldSchema as Schema.Codec<unknown, unknown, never>;
    // Capture encode/decode closures so action paths can run them in plain
    // promise contexts without needing Effect or per-call schema resolution.
    const encodeFn = Schema.encodeSync(fieldSchema);
    const decodeFn = Schema.decodeSync(fieldSchema);
    const storeSchema = Schema.Struct({
      ...schema.fields,
      [primaryKeyName]: Schema.String,
    });

    return {
      collectionKey,
      durableType: `${namespace}.${collectionKey}`,
      primaryKey: primaryKeyName,
      schema,
      storeSchema,
      // Primary-key values are encoded through the field schema as-is.
      // Non-string encoded values are rejected by `requireString` at the
      // action boundary; the package contains no String(...) coercion fallback.
      encodePrimaryKey: (value: unknown) => encodeFn(value),
      decodePrimaryKey: (encoded: string) => decodeFn(encoded),
    } satisfies CompiledCollection;
  });

  return { namespace, schemas, collections };
};

const makeStateDefinition = (table: CompiledTable<AnyTableSchemas>): StreamStateDefinition =>
  Object.fromEntries(
    table.collections.map((collection): [string, StateCollectionDefinition] => [
      collection.collectionKey,
      {
        type: collection.durableType,
        primaryKey: collection.primaryKey,
        schema: Schema.toStandardSchemaV1(
          // Schema variance: the per-collection storeSchema's encoded + context type
          // params are erased to satisfy the StandardSchemaV1 adapter's signature.
          // eslint-disable-next-line local/no-launder-cast -- Schema<object, unknown, never> erasure
          collection.storeSchema as unknown as Schema.Codec<object, unknown, never>,
        ),
      },
    ]),
  );

const makeStateSchema = (table: CompiledTable<AnyTableSchemas>): StateSchemaWithHelpers =>
  createStateSchema(makeStateDefinition(table));

/**
 * Returns a row whose primary-key field has been pre-encoded to its string
 * wire form. @durable-streams/state's TanStack DB wiring uses
 * `String(row[primaryKey])` to derive the collection index key; replacing the
 * field's decoded value with the schema-encoded string keeps composite-key
 * lookups consistent with the durable wire format.
 */
const encodeRowForStore = (
  collection: CompiledCollection,
  row: object,
): { encoded: object; encodedKey: string } => {
  const decoded = (row as Record<string, unknown>)[collection.primaryKey];
  const encodedKey = requireString(collection, collection.encodePrimaryKey(decoded));
  const encoded = { ...row, [collection.primaryKey]: encodedKey };
  return { encoded, encodedKey };
};

const makeActionDefinitions =
  (
    table: CompiledTable<AnyTableSchemas>,
    stateSchema: StateSchemaWithHelpers,
    txTimeoutMs: number,
  ): TableActionFactory =>
  ({ db, stream }) =>
    table.collections.reduce<TableActionDefinitions>((actions, collection) => {
      const coll = db.collections[collection.collectionKey]!;
      const helpers = stateSchema[collection.collectionKey]!;

      actions[actionName(collection.collectionKey, "insert")] = {
        onMutate: (params: unknown) => {
          const { encoded } = encodeRowForStore(collection, params as object);
          coll.insert(encoded);
        },
        mutationFn: async (params: unknown) => {
          const { encoded, encodedKey } = encodeRowForStore(collection, params as object);
          const txid = crypto.randomUUID();
          const event = helpers.insert({
            key: encodedKey,
            value: encoded,
            headers: { txid },
          });
          // Append the State Protocol event and wait until the materialized
          // table has observed its txid.
          await stream.append(JSON.stringify(event));
          await db.utils.awaitTxId(txid, txTimeoutMs);
        },
      };

      actions[actionName(collection.collectionKey, "upsert")] = {
        onMutate: (params: unknown) => {
          const { encoded, encodedKey } = encodeRowForStore(collection, params as object);
          if (coll.get(encodedKey) === undefined) {
            coll.insert(encoded);
          } else {
            coll.update(encodedKey, (draft) => {
              Object.assign(draft, encoded);
            });
          }
        },
        mutationFn: async (params: unknown) => {
          const { encoded, encodedKey } = encodeRowForStore(collection, params as object);
          const txid = crypto.randomUUID();
          const event = helpers.upsert({
            key: encodedKey,
            value: encoded,
            headers: { txid },
          });
          await stream.append(JSON.stringify(event));
          await db.utils.awaitTxId(txid, txTimeoutMs);
        },
      };

      actions[actionName(collection.collectionKey, "delete")] = {
        onMutate: (params: unknown) => {
          const encodedKey = requireString(collection, collection.encodePrimaryKey(params));
          if (coll.get(encodedKey) !== undefined) {
            coll.delete(encodedKey);
          }
        },
        mutationFn: async (params: unknown) => {
          const encodedKey = requireString(collection, collection.encodePrimaryKey(params));
          const txid = crypto.randomUUID();
          const event = helpers.delete({
            key: encodedKey,
            headers: { txid },
          });
          await stream.append(JSON.stringify(event));
          await db.utils.awaitTxId(txid, txTimeoutMs);
        },
      };
      return actions;
    }, {});

const runAction = (
  tableName: string,
  collection: CompiledCollection,
  actions: TableActionMap,
  operation: GeneratedOperation,
  params: unknown,
): Effect.Effect<void, DurableTableError> =>
  Effect.tryPromise({
    try: async () => {
      const name = actionName(collection.collectionKey, operation);
      const action = actions[name];
      if (action === undefined) {
        await Promise.reject(new Error(`unknown DurableTable action: ${name}`));
        return;
      }
      await action(params).isPersisted.promise;
    },
    catch: (cause) => new DurableTableError({ table: tableName, cause }),
  }).pipe(
    Effect.asVoid,
    Effect.withSpan("firegrid.durable_table.action", {
      kind: "internal",
      attributes: {
        // tf-a07s: durable schema-checked write (insert/upsert/delete lower
        // here; awaits isPersisted). Invariant declared by SDD §"What
        // DurableTable Actually Provides" — WRITES + schema-checked writes.
        "firegrid.seam.kind": "storage-commit",
        "firegrid.contract.id": "docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md",
        "firegrid.durable_table.name": tableName,
        "firegrid.durable_table.collection": collection.collectionKey,
        "firegrid.durable_table.durable_type": collection.durableType,
        "firegrid.durable_table.primary_key": collection.primaryKey,
        "firegrid.durable_table.operation": operation,
      },
    }),
  );

/**
 * On read, the stored row carries the encoded-string primary-key value. To
 * preserve the user-facing row type (whose primary-key field is the decoded
 * form), decode the field back before returning to callers.
 */
const decodeRowForRead = <Row extends object>(collection: CompiledCollection, stored: Row): Row => {
  const encoded = (stored as Record<string, unknown>)[collection.primaryKey];
  if (typeof encoded !== "string") return stored;
  const decoded = collection.decodePrimaryKey(encoded);
  return { ...stored, [collection.primaryKey]: decoded };
};

const decodeChangeForRead = <Row extends object>(
  collection: CompiledCollection,
  change: ChangeMessage<Row>,
): ChangeMessage<Row> => ({
  ...change,
  value: decodeRowForRead(collection, change.value),
  ...(change.previousValue === undefined
    ? {}
    : { previousValue: decodeRowForRead(collection, change.previousValue) }),
});

const encodeHeaderFragment = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

const streamEndpoint = (streamOptions: DurableStreamOptions): DurableStream.Endpoint => ({
  url: streamOptions.url,
  ...(streamOptions.headers !== undefined ? { headers: streamOptions.headers } : {}),
  ...(streamOptions.params !== undefined ? { params: streamOptions.params } : {}),
});

const appendInsertWithPrimaryKeyFence = (options: {
  readonly streamOptions: DurableStreamOptions;
  readonly collection: CompiledCollection;
  readonly encodedKey: string;
  readonly event: unknown;
}) => {
  const { collection, encodedKey, event, streamOptions } = options;
  const producerId = [
    "durable-table",
    collection.durableType,
    encodeHeaderFragment(encodedKey),
  ].join(":");
  const append = DurableStream.appendWithProducer({
    endpoint: streamEndpoint(streamOptions),
    schema: Schema.Unknown,
    event,
    producerId,
    producerEpoch: 0,
    producerSeq: 0,
  }).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "firegrid.durable_table.producer_append.result": result._tag,
      }),
    ),
    Effect.withSpan("firegrid.durable_table.producer_append", {
      kind: "internal",
      attributes: {
        // tf-a07s: durable append through the State Protocol producer
        // identity (producerId/epoch/seq). Invariant declared by SDD §"What
        // DurableTable Actually Provides" — primary-key fencing for
        // idempotent producers.
        "firegrid.seam.kind": "durable-append",
        "firegrid.contract.id": "docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md",
        "firegrid.durable_table.collection": collection.collectionKey,
        "firegrid.durable_table.durable_type": collection.durableType,
        "firegrid.durable_table.primary_key": collection.primaryKey,
      },
    }),
    Effect.provide(FetchHttpClient.layer),
  );
  return streamOptions.fetch === undefined
    ? append
    : append.pipe(Effect.provide(Layer.succeed(FetchHttpClient.Fetch, streamOptions.fetch)));
};

const waitForStoredRow = <Row extends object>(
  collection: CompiledCollection,
  tanstackCollection: TanStackCollection<Row, string>,
  encodedKey: string,
  timeoutMs: number,
): Promise<Row> =>
  new Promise((resolve, reject) => {
    const current = tanstackCollection.get(encodedKey);
    if (current !== undefined) {
      resolve(decodeRowForRead(collection, current));
      return;
    }

    let unsubscribe: (() => void) | undefined;
    const finish = (row: Row): void => {
      clearTimeout(timeout);
      if (unsubscribe !== undefined) unsubscribe();
      resolve(decodeRowForRead(collection, row));
    };
    const timeout = setTimeout(() => {
      if (unsubscribe !== undefined) unsubscribe();
      reject(
        new Error(`Timed out waiting for DurableTable row ${collection.durableType}:${encodedKey}`),
      );
    }, timeoutMs);

    try {
      const subscription = tanstackCollection.subscribeChanges(
        () => {
          const row = tanstackCollection.get(encodedKey);
          if (row !== undefined) finish(row);
        },
        { includeInitialState: true },
      );
      unsubscribe = () => subscription.unsubscribe();
    } catch (cause) {
      clearTimeout(timeout);
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });

const makeReadableCollection = <Row extends object>(
  tableName: string,
  collection: CompiledCollection,
  tanstackCollection: TanStackCollection<Row, string>,
): TanStackCollection<Row, string> => {
  const rejectMutation = (): never => {
    // Synchronous TanStack mutation boundary: throw the typed error directly
    // so callers can `instanceof DurableTableError` it. Wrapping in
    // Effect.runSync(Effect.fail(...)) would re-package this as a FiberFailure.
    throw new DurableTableError({
      table: tableName,
      cause: new Error(
        "DurableTable collection views are read-only; use the generated insert/upsert/delete facade methods",
      ),
    });
  };

  const overrides = {
    insert: rejectMutation,
    update: rejectMutation,
    delete: rejectMutation,
    get: (key: string) => {
      const row = tanstackCollection.get(key);
      return row === undefined ? undefined : decodeRowForRead(collection, row);
    },
    values: () =>
      Array.from(tanstackCollection.values(), (row) => decodeRowForRead(collection, row)).values(),
    entries: () =>
      Array.from(tanstackCollection.entries(), ([key, row]): [string, Row] => [
        key,
        decodeRowForRead(collection, row),
      ]).values(),
    [Symbol.iterator]: () => overrides.entries(),
    forEach: (callbackfn: (value: Row, key: string, index: number) => void) => {
      tanstackCollection.forEach((row, key, index) => {
        callbackfn(decodeRowForRead(collection, row), key, index);
      });
    },
    map: <A>(callbackfn: (value: Row, key: string, index: number) => A) =>
      tanstackCollection.map((row, key, index) =>
        callbackfn(decodeRowForRead(collection, row), key, index),
      ),
    toArrayWhenReady: () =>
      tanstackCollection
        .toArrayWhenReady()
        .then((rows) => rows.map((row) => decodeRowForRead(collection, row))),
    stateWhenReady: () =>
      tanstackCollection
        .stateWhenReady()
        .then(
          (state) =>
            new Map(
              Array.from(state, ([key, row]): [string, Row] => [
                key,
                decodeRowForRead(collection, row),
              ]),
            ),
        ),
    currentStateAsChanges: (
      ...args: Parameters<TanStackCollection<Row, string>["currentStateAsChanges"]>
    ) => {
      const changes = tanstackCollection.currentStateAsChanges(...args);
      return changes?.map((change) => decodeChangeForRead(collection, change));
    },
    subscribeChanges: (
      callback: Parameters<TanStackCollection<Row, string>["subscribeChanges"]>[0],
      options?: Parameters<TanStackCollection<Row, string>["subscribeChanges"]>[1],
    ) =>
      tanstackCollection.subscribeChanges(
        (changes) => callback(changes.map((change) => decodeChangeForRead(collection, change))),
        options,
      ),
  };

  return new Proxy(tanstackCollection, {
    get(target, property, receiver) {
      if (property === "toArray") {
        return target.toArray.map((row) => decodeRowForRead(collection, row));
      }
      if (property === "state") {
        return new Map(
          Array.from(target.state, ([key, row]): [string, Row] => [
            key,
            decodeRowForRead(collection, row),
          ]),
        );
      }
      if (property in overrides) {
        return overrides[property as keyof typeof overrides];
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
};

const makeFacade = <Row extends object, Key>(options: {
  readonly tableName: string;
  readonly collection: CompiledCollection;
  readonly helper: StateSchemaWithHelpers[string];
  readonly tanstackCollection: TanStackCollection<Row, string>;
  readonly actions: TableActionMap;
  readonly awaitTxId: (txid: string, timeoutMs?: number) => Promise<void>;
  readonly streamOptions: DurableStreamOptions;
  readonly txTimeoutMs: number;
}): CollectionFacade<Row, Key> => {
  const {
    actions,
    awaitTxId,
    collection,
    helper,
    streamOptions,
    tableName,
    tanstackCollection,
    txTimeoutMs,
  } = options;
  const encodeKey = (key: unknown): string =>
    requireString(collection, collection.encodePrimaryKey(key));
  const readableCollection = makeReadableCollection(tableName, collection, tanstackCollection);
  return {
    collection: readableCollection,
    rows: (): ProjectionStream<Row, DurableTableError> =>
      Stream.callback<Row, DurableTableError>((queue) =>
        // v4 `Stream.callback` replaces v3 `Stream.async`. Items are pushed
        // with `Queue.offerUnsafe` (the subscribe callback fires synchronously
        // outside Effect, same as the old `emit.single`). A subscribe-time
        // throw fails the stream with `DurableTableError` via `Effect.try`,
        // mirroring the old `emit.fail`. Cleanup (unsubscribe) is registered
        // as a scope finalizer, replacing the cleanup Effect the old callback
        // returned. The stream stays open (no `Queue.end`) until the scope
        // closes — identical lifecycle to the live subscription before.
        Effect.gen(function* () {
          const sub = yield* Effect.try({
            try: () =>
              readableCollection.subscribeChanges(
                (changes) => {
                  changes.forEach((change) => {
                    if (change.type === "delete") return;
                    if (change.value === undefined || change.value === null) return;
                    Queue.offerUnsafe(queue, change.value);
                  });
                },
                { includeInitialState: true },
              ),
            catch: (cause) => new DurableTableError({ table: tableName, cause }),
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => sub.unsubscribe()));
        }),
      ).pipe(
        Stream.withSpan("firegrid.durable_table.rows", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
          },
        }),
      ) as ProjectionStream<Row, DurableTableError>,
    insert: (row) => runAction(tableName, collection, actions, "insert", row),
    // Advisory Effect.fn suggestion; kept as a plain gen on this hot table path.
    // @effect-diagnostics-next-line effect/effectFnOpportunity:off
    insertOrGet: (row) =>
      Effect.gen(function* () {
        const { encoded, encodedKey } = yield* Effect.try({
          try: () => encodeRowForStore(collection, row),
          catch: (cause) => new DurableTableError({ table: tableName, cause }),
        });
        const txid = crypto.randomUUID();
        const event = helper.insert({
          key: encodedKey,
          value: encoded,
          headers: { txid },
        });
        const result = yield* appendInsertWithPrimaryKeyFence({
          streamOptions,
          collection,
          encodedKey,
          event,
        }).pipe(Effect.mapError((cause) => new DurableTableError({ table: tableName, cause })));
        if (result._tag === "Appended") {
          yield* Effect.tryPromise({
            try: () => awaitTxId(txid, txTimeoutMs),
            catch: (cause) => new DurableTableError({ table: tableName, cause }),
          });
          return {
            _tag: "Inserted",
            // The durable-stream append position of THIS insert. Offsets are
            // server-assigned in append order and zero-padded for total
            // lexicographic order, so for a per-stream collection this is the
            // row's arrival sequence (monotonic across concurrent inserts).
            offset: result.offset,
          } satisfies InsertOrGetResult<Row>;
        }

        // A duplicate producer response means no loser event was appended,
        // so there is no loser txid for awaitTxId. Wait narrowly for the
        // winning row to become visible in this materialized table handle.
        // Found carries no offset: the duplicate (idempotent-fenced) response
        // reports no append position (it wrote nothing), and the winning row's
        // original arrival offset is not stored on the row. Callers that need
        // the original arrival order must capture the Inserted offset at first
        // write. (`result.offset` is empty here.)
        return {
          _tag: "Found",
          row: yield* Effect.tryPromise({
            try: () => waitForStoredRow(collection, tanstackCollection, encodedKey, txTimeoutMs),
            catch: (cause) => new DurableTableError({ table: tableName, cause }),
          }),
        } satisfies InsertOrGetResult<Row>;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof DurableTableError
            ? cause
            : new DurableTableError({ table: tableName, cause }),
        ),
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            "firegrid.durable_table.insert_or_get.result": result._tag,
          }),
        ),
        Effect.withSpan("firegrid.durable_table.insert_or_get", {
          kind: "internal",
          attributes: {
            // tf-a07s: first-writer-wins idempotent claim — duplicate
            // producer resolves to the winning row, no loser append.
            // Invariant declared by SDD §"What DurableTable Actually
            // Provides" — primary-key fencing for idempotent producers
            // (insertOrGet).
            "firegrid.seam.kind": "claim-idempotency",
            "firegrid.contract.id":
              "docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md",
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
            "firegrid.durable_table.primary_key": collection.primaryKey,
          },
        }),
      ),
    upsert: (row) => runAction(tableName, collection, actions, "upsert", row),
    delete: (key) => runAction(tableName, collection, actions, "delete", key),
    get: (key) =>
      Effect.try({
        try: () => {
          const encoded = encodeKey(key);
          const value = tanstackCollection.get(encoded);
          return value === undefined
            ? Option.none<Row>()
            : Option.some(decodeRowForRead(collection, value));
        },
        catch: (cause) => new DurableTableError({ table: tableName, cause }),
      }).pipe(
        Effect.tap((row) =>
          Effect.annotateCurrentSpan({
            "firegrid.durable_table.row_found": Option.isSome(row),
          }),
        ),
        Effect.withSpan("firegrid.durable_table.get", {
          kind: "internal",
          attributes: {
            // tf-a07s: point read of current state from the materialized
            // view (Option<Row>). Invariant declared by SDD §"What
            // DurableTable Actually Provides" — READS / query current state.
            "firegrid.seam.kind": "storage-read",
            "firegrid.contract.id":
              "docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md",
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
            "firegrid.durable_table.primary_key": collection.primaryKey,
          },
        }),
      ),
    query: (build) =>
      Effect.try({
        try: () => build(readableCollection),
        catch: (cause) => new DurableTableError({ table: tableName, cause }),
      }).pipe(
        Effect.tap((result) => {
          const rowCount = rowCountForQueryResult(result);
          return rowCount === undefined
            ? Effect.void
            : Effect.annotateCurrentSpan({
                "firegrid.durable_table.query.row_count": rowCount,
              });
        }),
        Effect.withSpan("firegrid.durable_table.query", {
          kind: "internal",
          attributes: {
            // tf-a07s: read query over the materialized read-only view.
            // Invariant declared by SDD §"What DurableTable Actually
            // Provides" — READS / query current state.
            "firegrid.seam.kind": "storage-read",
            "firegrid.contract.id":
              "docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md",
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
          },
        }),
      ),
    subscribe: <A>(
      subscribe: (coll: TanStackCollection<Row, string>, emit: (value: A) => void) => () => void,
    ) =>
      // v4 `Stream.callback` replaces v3 `Stream.async`; see `rows()` above for
      // the offer/fail/finalizer mapping. Same semantics: caller-supplied
      // `subscribe` pushes via `Queue.offerUnsafe`, a throw fails the stream
      // with `DurableTableError`, unsubscribe runs as a scope finalizer.
      Stream.callback<A, DurableTableError>((queue) =>
        Effect.gen(function* () {
          const unsubscribe = yield* Effect.try({
            try: () =>
              subscribe(readableCollection, (value) => {
                Queue.offerUnsafe(queue, value);
              }),
            catch: (cause) => new DurableTableError({ table: tableName, cause }),
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));
        }),
      ).pipe(
        Stream.withSpan("firegrid.durable_table.subscribe", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
          },
        }),
      ),
  };
};

const makeService = <Schemas extends TableSchemas<Schemas>>(
  table: CompiledTable<Schemas>,
  options: LayerOptions,
): Effect.Effect<DurableTableService<Schemas>, DurableTableError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const stateSchema = makeStateSchema(table);
        const dbOptions: CreateStreamDBOptions<StateSchemaWithHelpers, TableActionDefinitions> = {
          streamOptions: options.streamOptions,
          state: stateSchema,
          actions: makeActionDefinitions(table, stateSchema, options.txTimeoutMs ?? 5_000),
        };
        return createStreamDB<StateSchemaWithHelpers, TableActionDefinitions>(dbOptions);
      },
      catch: (cause) => new DurableTableError({ table: table.namespace, cause }),
    }).pipe(
      Effect.tap((db) =>
        // Ensure the backing durable stream exists before preload. Calling
        // .create() against an already-existing stream returns a typed
        // CONFLICT_EXISTS error from @durable-streams/client; we tolerate
        // that path so DurableTable.layer is idempotent across acquisitions
        // against the same URL.
        Effect.tryPromise({
          try: async () => {
            try {
              const createOpts: { contentType?: string } = {};
              if (options.streamOptions.contentType !== undefined) {
                createOpts.contentType = options.streamOptions.contentType;
              }
              await db.stream.create(createOpts);
            } catch (cause) {
              if (
                typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                cause.code === "CONFLICT_EXISTS"
              ) {
                // Stream already exists with compatible configuration; the
                // server returns CONFLICT_EXISTS and we proceed to preload.
                return;
              }
              throw cause;
            }
          },
          catch: (cause) => new DurableTableError({ table: table.namespace, cause }),
        }),
      ),
      Effect.tap((db) =>
        Effect.tryPromise({
          try: () => db.preload(),
          catch: (cause) => new DurableTableError({ table: table.namespace, cause }),
        }),
      ),
    ),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.map((db) => {
      const actions = db.actions;
      const stateSchema = makeStateSchema(table);
      const txTimeoutMs = options.txTimeoutMs ?? 5_000;
      const collectionFacades = table.collections.reduce<Record<string, unknown>>(
        (facades, collection) => {
          // `db.collections[...]` is typed by `@durable-streams/state`'s
          // bundled `@tanstack/db` (0.6.8), which is a structural SUPERSET of
          // the top-level `@tanstack/db` (0.5.33) the facade types import
          // (0.6.8 adds `deferDataRefresh` / `removeIndex` /
          // `getIndexMetadata`). The two package instances are distinct types
          // under the dual-version install, but every method the facade uses
          // exists in both — bridge the dual-instance gap with a cast rather
          // than touching the pinned versions.
          const coll = db.collections[collection.collectionKey]! as unknown as TanStackCollection<
            object,
            string
          >;
          return {
            ...facades,
            [collection.collectionKey]: makeFacade({
              tableName: `${table.namespace}.${collection.collectionKey}`,
              collection,
              helper: stateSchema[collection.collectionKey]!,
              tanstackCollection: coll,
              actions,
              awaitTxId: db.utils.awaitTxId,
              streamOptions: options.streamOptions,
              txTimeoutMs,
            }),
          };
        },
        {},
      );

      const service: Record<string, unknown> = {
        awaitTxId: (txid: string, timeoutMs?: number) =>
          Effect.tryPromise({
            try: () => db.utils.awaitTxId(txid, timeoutMs),
            catch: (cause) => new DurableTableError({ table: table.namespace, cause }),
          }).pipe(
            Effect.withSpan("firegrid.durable_table.await_tx_id", {
              kind: "internal",
              attributes: {
                "firegrid.durable_table.namespace": table.namespace,
              },
            }),
          ),
        ...collectionFacades,
      };

      return service as DurableTableService<Schemas>;
    }),
    Effect.withSpan("firegrid.durable_table.layer.acquire", {
      kind: "internal",
      attributes: {
        // tf-a07s: scope-managed acquire of the DurableTable service (opens
        // collections / preload on acquire, released with the scope).
        // Invariant declared by SDD §"What DurableTable Actually Provides" —
        // scope-managed acquire/release with preload on acquire.
        "firegrid.seam.kind": "resource-acquire",
        "firegrid.contract.id": "docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md",
        "firegrid.durable_table.namespace": table.namespace,
        "firegrid.durable_table.collection_count": table.collections.length,
      },
    }),
  );

const defineDurableTable = <const Schemas extends TableSchemas<Schemas>>(
  namespace: string,
  schemas: Schemas,
): DurableTableTagClass<Schemas> => {
  const table = compileTable(namespace, schemas);
  const tagKey = `effect-durable-operators/DurableTable/${namespace}`;

  // Self-reference: the class is its own Identifier so `yield* MyTable`
  // produces R = MyTable rather than R = unknown. The forward reference to
  // `DurableTableTag` inside the `Context.Service` generics is the canonical
  // Effect 4 service pattern and works because class declarations are hoisted.
  class DurableTableTag extends Context.Service<DurableTableTag, DurableTableService<Schemas>>()(
    tagKey,
  ) {
    static readonly namespace = namespace;

    static layer(
      this: Context.Service<DurableTableTag, DurableTableService<Schemas>>,
      options: LayerOptions,
    ) {
      // v4: `Layer.scoped` collapsed into `Layer.effect` — the `Scope` in the
      // effect's R is handled by `Layer.effect` (it's excluded from the
      // layer's R), so the scoped acquire/release in `makeService` is
      // preserved with identical lifecycle semantics.
      return Layer.effect(
        this,
        makeService(table, options).pipe(Effect.map((service) => this.of(service))),
      );
    }
  }

  // class-tag-from-factory: the dynamically-assembled Context.Tag class cannot be
  // statically typed as the generic `DurableTableTagClass<Schemas>`.
  // eslint-disable-next-line local/no-launder-cast -- dynamic Tag class → generic class
  return DurableTableTag as unknown as DurableTableTagClass<Schemas>;
};

export const DurableTable = Object.assign(defineDurableTable, {
  primaryKey,
});
