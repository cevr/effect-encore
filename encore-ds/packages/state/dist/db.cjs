"use strict";
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
const require_src = require('./src-AIE5IYwJ.cjs');
const __tanstack_db = __toESM(require("@tanstack/db"));
const __durable_streams_client = __toESM(require("@durable-streams/client"));

//#region src/stream-db.ts
/**
* Build a TanStack collection id for a StreamDB collection.
*
* Collection ids must be unique per source stream, not just per schema key,
* otherwise joining the same collection name from two different streams can
* collapse to one logical source inside TanStack DB.
*/
function getStreamDBCollectionId(streamUrl, collectionName) {
	return `stream-db:${streamUrl}:${collectionName}`;
}
/**
* Internal event dispatcher that routes stream events to collection handlers
*/
var EventDispatcher = class {
	/** Map from event type to collection handler */
	handlers = new Map();
	/** Handlers that have pending writes (need commit) */
	pendingHandlers = new Set();
	/** Whether we've received the initial up-to-date signal */
	isUpToDate = false;
	/** Resolvers and rejecters for preload promises */
	preloadResolvers = [];
	preloadRejecters = [];
	/** Set of all txids that have been seen and committed */
	seenTxids = new Set();
	/** Txids collected during current batch (before commit) */
	pendingTxids = new Set();
	/** Resolvers waiting for specific txids */
	txidResolvers = new Map();
	/** Track existing keys per collection for upsert logic */
	existingKeys = new Map();
	/** Global sequence counter for insertion ordering */
	seq = 0;
	comparableRow(row) {
		const clone = { ...row };
		delete clone._seq;
		return clone;
	}
	/**
	* Register a handler for a specific event type
	*/
	registerHandler(eventType, handler) {
		this.handlers.set(eventType, handler);
		if (!this.existingKeys.has(eventType)) this.existingKeys.set(eventType, new Set());
	}
	/**
	* Dispatch a change event to the appropriate collection.
	* Writes are buffered until commit() is called via markUpToDate().
	*/
	dispatchChange(event, cursor) {
		if (!require_src.isChangeEvent(event)) return;
		const eventCursor = event.headers.offset ?? cursor;
		if (event.headers.txid && typeof event.headers.txid === `string`) this.pendingTxids.add(event.headers.txid);
		const handler = this.handlers.get(event.type);
		if (!handler) return;
		let operation = event.headers.operation;
		if (operation !== `delete`) {
			if (typeof event.value !== `object` || event.value === null) throw new Error(`StreamDB collections require object values; got ${typeof event.value} for type=${event.type}, key=${event.key}`);
		}
		const originalValue = event.value ?? {};
		const value = { ...originalValue };
		value[handler.primaryKey] = event.key;
		value._seq = this.seq++;
		if (!this.pendingHandlers.has(handler)) {
			handler.begin();
			this.pendingHandlers.add(handler);
		}
		if (operation === `upsert`) {
			const keys$1 = this.existingKeys.get(event.type);
			const existing = keys$1?.has(event.key);
			operation = existing ? `update` : `insert`;
		}
		const keys = this.existingKeys.get(event.type);
		if (operation === `insert` && keys?.has(event.key)) operation = `update`;
		else if (operation === `insert` && typeof event.key === `string`) {
			const existingValue = handler.read(event.key);
			if (existingValue && (0, __tanstack_db.deepEquals)(this.comparableRow(existingValue), this.comparableRow(value))) operation = `update`;
		}
		if (operation === `insert` || operation === `update`) keys?.add(event.key);
		else keys?.delete(event.key);
		try {
			handler.write(value, operation, eventCursor);
		} catch (error) {
			console.error(`[StreamDB] Error in handler.write():`, error);
			console.error(`[StreamDB] Event that caused error:`, {
				type: event.type,
				key: event.key,
				operation
			});
			throw error;
		}
	}
	/**
	* Handle control events from the stream JSON items
	*/
	dispatchControl(event) {
		if (!require_src.isControlEvent(event)) return;
		switch (event.headers.control) {
			case `reset`:
				for (const handler of this.handlers.values()) handler.truncate();
				for (const keys of this.existingKeys.values()) keys.clear();
				this.pendingHandlers.clear();
				this.isUpToDate = false;
				break;
			case `snapshot-start`:
			case `snapshot-end`: break;
		}
	}
	/**
	* Commit all pending writes and handle up-to-date signal
	*/
	markUpToDate() {
		for (const handler of this.pendingHandlers) try {
			handler.commit();
		} catch (error) {
			console.error(`[StreamDB] Error in handler.commit():`, error);
			if (error instanceof Error && error.message.includes(`already exists in the collection`) && error.message.includes(`live-query`)) {
				console.warn(`[StreamDB] Known TanStack DB groupBy bug detected - continuing despite error`);
				console.warn(`[StreamDB] Queries with groupBy may show stale data until fixed`);
				continue;
			}
			throw error;
		}
		this.pendingHandlers.clear();
		for (const txid of this.pendingTxids) {
			this.seenTxids.add(txid);
			const resolvers = this.txidResolvers.get(txid);
			if (resolvers) {
				for (const { resolve, timeoutId } of resolvers) {
					clearTimeout(timeoutId);
					resolve();
				}
				this.txidResolvers.delete(txid);
			}
		}
		this.pendingTxids.clear();
		if (!this.isUpToDate) {
			this.isUpToDate = true;
			for (const handler of this.handlers.values()) handler.markReady();
			for (const resolve of this.preloadResolvers) resolve();
			this.preloadResolvers = [];
		}
	}
	/**
	* Wait for the stream to reach up-to-date state
	*/
	waitForUpToDate() {
		if (this.isUpToDate) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.preloadResolvers.push(resolve);
			this.preloadRejecters.push(reject);
		});
	}
	/**
	* Reject all waiting preload promises with an error
	*/
	rejectAll(error) {
		for (const reject of this.preloadRejecters) reject(error);
		this.preloadResolvers = [];
		this.preloadRejecters = [];
		for (const resolvers of this.txidResolvers.values()) for (const { reject, timeoutId } of resolvers) {
			clearTimeout(timeoutId);
			reject(error);
		}
		this.txidResolvers.clear();
	}
	/**
	* Check if we've received up-to-date
	*/
	get ready() {
		return this.isUpToDate;
	}
	/**
	* Wait for a specific txid to be seen in the stream
	*/
	awaitTxId(txid, timeout = 5e3) {
		if (this.seenTxids.has(txid)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				const resolvers = this.txidResolvers.get(txid);
				if (resolvers) {
					const index = resolvers.findIndex((r) => r.timeoutId === timeoutId);
					if (index !== -1) resolvers.splice(index, 1);
					if (resolvers.length === 0) this.txidResolvers.delete(txid);
				}
				reject(new Error(`Timeout waiting for txid: ${txid}`));
			}, timeout);
			if (!this.txidResolvers.has(txid)) this.txidResolvers.set(txid, []);
			this.txidResolvers.get(txid).push({
				resolve,
				reject,
				timeoutId
			});
		});
	}
};
/**
* Create a sync config for a stream-backed collection
*/
function createStreamSyncConfig(eventType, dispatcher, primaryKey, read) {
	return { sync: ({ begin, write, commit, markReady, truncate }) => {
		dispatcher.registerHandler(eventType, {
			begin,
			write: (value, type, _cursor) => {
				write({
					value,
					type
				});
			},
			read: (key) => read(key),
			commit,
			markReady,
			truncate,
			primaryKey
		});
		if (dispatcher.ready) markReady();
		return () => {};
	} };
}
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
function createStreamDB(options) {
	const { streamOptions, state, actions: actionsFactory, live = true, onEvent, onBeforeBatch, onBatch } = options;
	const stream = options.stream ?? (() => {
		if (!streamOptions) throw new Error(`createStreamDB requires stream or streamOptions`);
		return new __durable_streams_client.DurableStream(streamOptions);
	})();
	const dispatcher = new EventDispatcher();
	const streamIdentity = stream.url;
	const collectionInstances = {};
	for (const [name, definition] of Object.entries(state)) {
		let collection = (0, __tanstack_db.createCollection)({
			id: getStreamDBCollectionId(streamIdentity, name),
			schema: definition.schema,
			getKey: (item) => String(item[definition.primaryKey]),
			sync: createStreamSyncConfig(definition.type, dispatcher, definition.primaryKey, (key) => collection.get(key)),
			startSync: true,
			gcTime: 0
		});
		collectionInstances[name] = collection;
	}
	let streamResponse = null;
	const abortController = new AbortController();
	let consumerStarted = false;
	let lastConsumedOffset = `-1`;
	const isAbortLikeError = (err) => {
		if (abortController.signal.aborted) return true;
		if (!(err instanceof Error)) return false;
		return err.name === `AbortError` || err.name === `FetchBackoffAbortError` || err.message === `Stream request was aborted`;
	};
	/**
	* Start the stream consumer (called lazily on first preload)
	*/
	const startConsumer = async () => {
		if (consumerStarted) return;
		consumerStarted = true;
		streamResponse = await stream.stream({
			live,
			json: true,
			signal: abortController.signal
		});
		streamResponse.closed.catch((err) => {
			if (isAbortLikeError(err)) return void 0;
			const error = err instanceof Error ? err : new Error(String(err));
			console.error(`[StreamDB] Stream consumer closed unexpectedly:`, error);
			dispatcher.rejectAll(error);
			return void 0;
		});
		lastConsumedOffset = streamResponse.offset;
		streamResponse.subscribeJson((batch) => {
			try {
				lastConsumedOffset = batch.offset;
				onBeforeBatch?.(batch);
				for (const event of batch.items) if (require_src.isChangeEvent(event)) {
					dispatcher.dispatchChange(event, batch.offset);
					onEvent?.(event);
				} else if (require_src.isControlEvent(event)) dispatcher.dispatchControl(event);
				onBatch?.(batch);
				if (batch.upToDate || dispatcher.ready) dispatcher.markUpToDate();
			} catch (error) {
				console.error(`[StreamDB] Error processing batch:`, error);
				dispatcher.rejectAll(error);
				abortController.abort();
			}
			return Promise.resolve();
		});
	};
	const dbMethods = {
		stream,
		get offset() {
			return lastConsumedOffset;
		},
		preload: async () => {
			await startConsumer();
			await dispatcher.waitForUpToDate();
		},
		close: () => {
			dispatcher.rejectAll(new Error(`StreamDB closed`));
			abortController.abort();
		},
		utils: { awaitTxId: (txid, timeout) => dispatcher.awaitTxId(txid, timeout) }
	};
	const db = Object.create(null);
	Object.defineProperty(db, `collections`, {
		value: collectionInstances,
		enumerable: true,
		configurable: false,
		writable: false
	});
	Object.defineProperties(db, Object.getOwnPropertyDescriptors(dbMethods));
	if (actionsFactory) {
		const actionDefs = actionsFactory({
			db,
			stream
		});
		const wrappedActions = {};
		for (const [name, def] of Object.entries(actionDefs)) wrappedActions[name] = (0, __tanstack_db.createOptimisticAction)({
			onMutate: def.onMutate,
			mutationFn: def.mutationFn
		});
		Object.defineProperty(db, `actions`, {
			value: wrappedActions,
			enumerable: true,
			configurable: false,
			writable: false
		});
		return db;
	}
	return db;
}

//#endregion
exports.MaterializedState = require_src.MaterializedState
Object.defineProperty(exports, 'and', {
  enumerable: true,
  get: function () {
    return __tanstack_db.and;
  }
});
Object.defineProperty(exports, 'avg', {
  enumerable: true,
  get: function () {
    return __tanstack_db.avg;
  }
});
Object.defineProperty(exports, 'coalesce', {
  enumerable: true,
  get: function () {
    return __tanstack_db.coalesce;
  }
});
Object.defineProperty(exports, 'concat', {
  enumerable: true,
  get: function () {
    return __tanstack_db.concat;
  }
});
Object.defineProperty(exports, 'count', {
  enumerable: true,
  get: function () {
    return __tanstack_db.count;
  }
});
Object.defineProperty(exports, 'createCollection', {
  enumerable: true,
  get: function () {
    return __tanstack_db.createCollection;
  }
});
Object.defineProperty(exports, 'createLiveQueryCollection', {
  enumerable: true,
  get: function () {
    return __tanstack_db.createLiveQueryCollection;
  }
});
Object.defineProperty(exports, 'createOptimisticAction', {
  enumerable: true,
  get: function () {
    return __tanstack_db.createOptimisticAction;
  }
});
exports.createStateSchema = require_src.createStateSchema
exports.createStreamDB = createStreamDB
Object.defineProperty(exports, 'createTransaction', {
  enumerable: true,
  get: function () {
    return __tanstack_db.createTransaction;
  }
});
Object.defineProperty(exports, 'deepEquals', {
  enumerable: true,
  get: function () {
    return __tanstack_db.deepEquals;
  }
});
Object.defineProperty(exports, 'eq', {
  enumerable: true,
  get: function () {
    return __tanstack_db.eq;
  }
});
exports.getStreamDBCollectionId = getStreamDBCollectionId
Object.defineProperty(exports, 'gt', {
  enumerable: true,
  get: function () {
    return __tanstack_db.gt;
  }
});
Object.defineProperty(exports, 'gte', {
  enumerable: true,
  get: function () {
    return __tanstack_db.gte;
  }
});
Object.defineProperty(exports, 'ilike', {
  enumerable: true,
  get: function () {
    return __tanstack_db.ilike;
  }
});
Object.defineProperty(exports, 'inArray', {
  enumerable: true,
  get: function () {
    return __tanstack_db.inArray;
  }
});
exports.isChangeEvent = require_src.isChangeEvent
exports.isControlEvent = require_src.isControlEvent
Object.defineProperty(exports, 'isNull', {
  enumerable: true,
  get: function () {
    return __tanstack_db.isNull;
  }
});
Object.defineProperty(exports, 'isUndefined', {
  enumerable: true,
  get: function () {
    return __tanstack_db.isUndefined;
  }
});
Object.defineProperty(exports, 'like', {
  enumerable: true,
  get: function () {
    return __tanstack_db.like;
  }
});
Object.defineProperty(exports, 'localOnlyCollectionOptions', {
  enumerable: true,
  get: function () {
    return __tanstack_db.localOnlyCollectionOptions;
  }
});
Object.defineProperty(exports, 'lt', {
  enumerable: true,
  get: function () {
    return __tanstack_db.lt;
  }
});
Object.defineProperty(exports, 'lte', {
  enumerable: true,
  get: function () {
    return __tanstack_db.lte;
  }
});
Object.defineProperty(exports, 'max', {
  enumerable: true,
  get: function () {
    return __tanstack_db.max;
  }
});
Object.defineProperty(exports, 'min', {
  enumerable: true,
  get: function () {
    return __tanstack_db.min;
  }
});
Object.defineProperty(exports, 'not', {
  enumerable: true,
  get: function () {
    return __tanstack_db.not;
  }
});
Object.defineProperty(exports, 'or', {
  enumerable: true,
  get: function () {
    return __tanstack_db.or;
  }
});
Object.defineProperty(exports, 'queryOnce', {
  enumerable: true,
  get: function () {
    return __tanstack_db.queryOnce;
  }
});
Object.defineProperty(exports, 'sum', {
  enumerable: true,
  get: function () {
    return __tanstack_db.sum;
  }
});
Object.defineProperty(exports, 'toArray', {
  enumerable: true,
  get: function () {
    return __tanstack_db.toArray;
  }
});