"use strict";

//#region src/types.ts
/**
* Type guard to check if an event is a change event
*/
function isChangeEvent(event) {
	return event != null && `operation` in event.headers;
}
/**
* Type guard to check if an event is a control event
*/
function isControlEvent(event) {
	return event != null && `control` in event.headers;
}

//#endregion
//#region src/materialized-state.ts
/**
* MaterializedState maintains an in-memory view of state from change events.
*
* It organizes data by type, where each type contains a map of key -> value.
* This supports multi-type streams where different entity types can coexist.
*/
var MaterializedState = class {
	data;
	constructor() {
		this.data = new Map();
	}
	/**
	* Apply a single change event to update the materialized state
	*/
	apply(event) {
		const { type, key, value, headers } = event;
		let typeMap = this.data.get(type);
		if (!typeMap) {
			typeMap = new Map();
			this.data.set(type, typeMap);
		}
		switch (headers.operation) {
			case `insert`:
				typeMap.set(key, value);
				break;
			case `update`:
				typeMap.set(key, value);
				break;
			case `upsert`:
				typeMap.set(key, value);
				break;
			case `delete`:
				typeMap.delete(key);
				break;
		}
	}
	/**
	* Apply a batch of change events
	*/
	applyBatch(events) {
		for (const event of events) this.apply(event);
	}
	/**
	* Get a specific value by type and key
	*/
	get(type, key) {
		const typeMap = this.data.get(type);
		if (!typeMap) return void 0;
		return typeMap.get(key);
	}
	/**
	* Get all entries for a specific type
	*/
	getType(type) {
		return this.data.get(type) || new Map();
	}
	/**
	* Clear all state
	*/
	clear() {
		this.data.clear();
	}
	/**
	* Get the number of types in the state
	*/
	get typeCount() {
		return this.data.size;
	}
	/**
	* Get all type names
	*/
	get types() {
		return Array.from(this.data.keys());
	}
};

//#endregion
//#region src/schema.ts
/**
* Reserved collection names that would collide with StreamDB properties
* (collections are now namespaced, but we still prevent internal name collisions)
*/
const RESERVED_COLLECTION_NAMES = new Set([
	`collections`,
	`preload`,
	`close`,
	`utils`,
	`actions`
]);
/**
* Create helper functions for a collection
*/
function createCollectionHelpers(eventType, primaryKey, schema) {
	return {
		insert: ({ key, value, headers }) => {
			const result = schema[`~standard`].validate(value);
			if (`issues` in result) throw new Error(`Validation failed for ${eventType} insert: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`);
			const derived = value[primaryKey];
			const finalKey = key ?? (derived != null && derived !== `` ? String(derived) : void 0);
			if (finalKey == null || finalKey === ``) throw new Error(`Cannot create ${eventType} insert event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`);
			return {
				type: eventType,
				key: finalKey,
				value,
				headers: {
					...headers,
					operation: `insert`
				}
			};
		},
		update: ({ key, value, oldValue, headers }) => {
			const result = schema[`~standard`].validate(value);
			if (`issues` in result) throw new Error(`Validation failed for ${eventType} update: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`);
			if (oldValue !== void 0) {
				const oldResult = schema[`~standard`].validate(oldValue);
				if (`issues` in oldResult) throw new Error(`Validation failed for ${eventType} update (oldValue): ${oldResult.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`);
			}
			const derived = value[primaryKey];
			const finalKey = key ?? (derived != null && derived !== `` ? String(derived) : void 0);
			if (finalKey == null || finalKey === ``) throw new Error(`Cannot create ${eventType} update event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`);
			return {
				type: eventType,
				key: finalKey,
				value,
				old_value: oldValue,
				headers: {
					...headers,
					operation: `update`
				}
			};
		},
		delete: ({ key, oldValue, headers }) => {
			if (oldValue !== void 0) {
				const result = schema[`~standard`].validate(oldValue);
				if (`issues` in result) throw new Error(`Validation failed for ${eventType} delete (oldValue): ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`);
			}
			const finalKey = key ?? (oldValue ? String(oldValue[primaryKey]) : void 0);
			if (!finalKey) throw new Error(`Cannot create ${eventType} delete event: must provide either 'key' or 'oldValue' with a ${primaryKey} field`);
			return {
				type: eventType,
				key: finalKey,
				old_value: oldValue,
				headers: {
					...headers,
					operation: `delete`
				}
			};
		},
		upsert: ({ key, value, headers }) => {
			const result = schema[`~standard`].validate(value);
			if (`issues` in result) throw new Error(`Validation failed for ${eventType} upsert: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`);
			const derived = value[primaryKey];
			const finalKey = key ?? (derived != null && derived !== `` ? String(derived) : void 0);
			if (finalKey == null || finalKey === ``) throw new Error(`Cannot create ${eventType} upsert event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`);
			return {
				type: eventType,
				key: finalKey,
				value,
				headers: {
					...headers,
					operation: `upsert`
				}
			};
		}
	};
}
/**
* Create a state schema definition with typed collections and event helpers
*/
function createStateSchema(collections) {
	for (const name of Object.keys(collections)) if (RESERVED_COLLECTION_NAMES.has(name)) throw new Error(`Reserved collection name "${name}" - this would collide with StreamDB properties (${Array.from(RESERVED_COLLECTION_NAMES).join(`, `)})`);
	const typeToCollection = new Map();
	for (const [collectionName, def] of Object.entries(collections)) {
		const existing = typeToCollection.get(def.type);
		if (existing) throw new Error(`Duplicate event type "${def.type}" - used by both "${existing}" and "${collectionName}" collections`);
		typeToCollection.set(def.type, collectionName);
	}
	const enhancedCollections = {};
	for (const [name, collectionDef] of Object.entries(collections)) enhancedCollections[name] = {
		...collectionDef,
		...createCollectionHelpers(collectionDef.type, collectionDef.primaryKey, collectionDef.schema)
	};
	return enhancedCollections;
}

//#endregion
Object.defineProperty(exports, 'MaterializedState', {
  enumerable: true,
  get: function () {
    return MaterializedState;
  }
});
Object.defineProperty(exports, 'createStateSchema', {
  enumerable: true,
  get: function () {
    return createStateSchema;
  }
});
Object.defineProperty(exports, 'isChangeEvent', {
  enumerable: true,
  get: function () {
    return isChangeEvent;
  }
});
Object.defineProperty(exports, 'isControlEvent', {
  enumerable: true,
  get: function () {
    return isControlEvent;
  }
});