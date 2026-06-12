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
const node_http = __toESM(require("node:http"));
const node_zlib = __toESM(require("node:zlib"));
const __durable_streams_client = __toESM(require("@durable-streams/client"));
const node_fs = __toESM(require("node:fs"));
const node_path = __toESM(require("node:path"));
const node_crypto = __toESM(require("node:crypto"));
const lmdb = __toESM(require("lmdb"));
const __neophi_sieve_cache = __toESM(require("@neophi/sieve-cache"));
const node_net = __toESM(require("node:net"));
const __opentelemetry_api = __toESM(require("@opentelemetry/api"));
const __durable_streams_state = __toESM(require("@durable-streams/state"));

//#region src/store.ts
/**
* TTL for in-memory producer state cleanup (7 days).
*/
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
/**
* Normalize content-type by extracting the media type (before any semicolon).
* Handles cases like "application/json; charset=utf-8".
*/
function normalizeContentType(contentType) {
	if (!contentType) return ``;
	return contentType.split(`;`)[0].trim().toLowerCase();
}
/**
* Process JSON data for append in JSON mode.
* - Validates JSON
* - Extracts array elements if data is an array
* - Always appends trailing comma for easy concatenation
* @param isInitialCreate - If true, empty arrays are allowed (creates empty stream)
* @throws Error if JSON is invalid or array is empty (for non-create operations)
*/
function processJsonAppend(data, isInitialCreate = false) {
	const text = new TextDecoder().decode(data);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Invalid JSON`);
	}
	let result;
	if (Array.isArray(parsed)) {
		if (parsed.length === 0) {
			if (isInitialCreate) return new Uint8Array(0);
			throw new Error(`Empty arrays are not allowed`);
		}
		const elements = parsed.map((item) => JSON.stringify(item));
		result = elements.join(`,`) + `,`;
	} else result = JSON.stringify(parsed) + `,`;
	return new TextEncoder().encode(result);
}
function decodeStoredJsonMessage(data) {
	let text = new TextDecoder().decode(data).trimEnd();
	if (text.endsWith(`,`)) text = text.slice(0, -1);
	return text;
}
function enrichJsonValueWithOffset(parsed, offset) {
	if (!parsed || typeof parsed !== `object` || Array.isArray(parsed)) return JSON.stringify(parsed);
	const candidate = parsed;
	const headers = candidate.headers;
	if (!headers || typeof headers !== `object`) return JSON.stringify(parsed);
	const isStateChange = typeof headers.operation === `string`;
	const isStateControl = typeof headers.control === `string`;
	if (!isStateChange && !isStateControl) return JSON.stringify(parsed);
	return JSON.stringify({
		...candidate,
		headers: {
			...headers,
			offset
		}
	});
}
function formatJsonMessages(messages) {
	if (messages.length === 0) return new TextEncoder().encode(`[]`);
	const items = messages.flatMap((message) => {
		const rawFragment = decodeStoredJsonMessage(message.data);
		const parsed = JSON.parse(`[${rawFragment}]`);
		return parsed.map((value) => enrichJsonValueWithOffset(value, message.offset));
	});
	return new TextEncoder().encode(`[${items.join(`,`)}]`);
}
var StreamStore = class {
	streams = new Map();
	pendingLongPolls = [];
	/**
	* Per-producer locks for serializing validation+append operations.
	* Key: "{streamPath}:{producerId}"
	*/
	producerLocks = new Map();
	/**
	* Check if a stream is expired based on TTL or Expires-At.
	*/
	isExpired(stream) {
		const now = Date.now();
		if (stream.expiresAt) {
			const expiryTime = new Date(stream.expiresAt).getTime();
			if (!Number.isFinite(expiryTime) || now >= expiryTime) return true;
		}
		if (stream.ttlSeconds !== void 0) {
			const expiryTime = stream.lastAccessedAt + stream.ttlSeconds * 1e3;
			if (now >= expiryTime) return true;
		}
		return false;
	}
	/**
	* Get a stream, handling expiry.
	* Returns undefined if stream doesn't exist or is expired (and has no refs).
	* Expired streams with refCount > 0 are soft-deleted instead of fully deleted.
	*/
	getIfNotExpired(path) {
		const stream = this.streams.get(path);
		if (!stream) return void 0;
		if (this.isExpired(stream)) {
			if (stream.refCount > 0) {
				stream.softDeleted = true;
				return stream;
			}
			this.delete(path);
			return void 0;
		}
		return stream;
	}
	/**
	* Update lastAccessedAt to now. Called on reads and appends (not HEAD).
	*/
	touchAccess(path) {
		const stream = this.streams.get(path);
		if (stream) stream.lastAccessedAt = Date.now();
	}
	/**
	* Create a new stream.
	* @throws Error if stream already exists with different config
	* @throws Error if fork source not found, soft-deleted, or offset invalid
	* @returns existing stream if config matches (idempotent)
	*/
	create(path, options = {}) {
		const existingRaw = this.streams.get(path);
		if (existingRaw) if (this.isExpired(existingRaw)) {
			this.streams.delete(path);
			this.cancelLongPollsForStream(path);
		} else if (existingRaw.softDeleted) throw new Error(`Stream has active forks — path cannot be reused until all forks are removed: ${path}`);
		else {
			const contentTypeMatches = (normalizeContentType(options.contentType) || `application/octet-stream`) === (normalizeContentType(existingRaw.contentType) || `application/octet-stream`);
			const ttlMatches = options.ttlSeconds === existingRaw.ttlSeconds;
			const expiresMatches = options.expiresAt === existingRaw.expiresAt;
			const closedMatches = (options.closed ?? false) === (existingRaw.closed ?? false);
			const forkedFromMatches = (options.forkedFrom ?? void 0) === existingRaw.forkedFrom;
			const forkOffsetMatches = options.forkOffset === void 0 || options.forkOffset === existingRaw.forkOffset;
			const requestedSub = options.forkSubOffset ?? 0;
			const existingSub = existingRaw.forkSubOffset ?? 0;
			const forkSubOffsetMatches = requestedSub === existingSub;
			if (contentTypeMatches && ttlMatches && expiresMatches && closedMatches && forkedFromMatches && forkOffsetMatches && forkSubOffsetMatches) return existingRaw;
			else throw new Error(`Stream already exists with different configuration: ${path}`);
		}
		const isFork = !!options.forkedFrom;
		let forkOffset = `0000000000000000_0000000000000000`;
		let sourceContentType;
		let sourceStream;
		let forkSubOffsetPrefix;
		if (isFork) {
			sourceStream = this.streams.get(options.forkedFrom);
			if (!sourceStream) throw new Error(`Source stream not found: ${options.forkedFrom}`);
			if (sourceStream.softDeleted) throw new Error(`Source stream is soft-deleted: ${options.forkedFrom}`);
			if (this.isExpired(sourceStream)) throw new Error(`Source stream not found: ${options.forkedFrom}`);
			sourceContentType = sourceStream.contentType;
			if (options.contentType && options.contentType.trim() !== `` && normalizeContentType(options.contentType) !== normalizeContentType(sourceContentType)) throw new Error(`Content type mismatch with source stream`);
			if (options.forkOffset) forkOffset = options.forkOffset;
			else forkOffset = sourceStream.currentOffset;
			const zeroOffset = `0000000000000000_0000000000000000`;
			if (forkOffset < zeroOffset || sourceStream.currentOffset < forkOffset) throw new Error(`Invalid fork offset: ${forkOffset}`);
			if (options.forkSubOffset && options.forkSubOffset > 0) forkSubOffsetPrefix = this.resolveForkSubOffset(sourceStream, forkOffset, options.forkSubOffset, normalizeContentType(sourceContentType) === `application/json`);
			sourceStream.refCount++;
		}
		let contentType = options.contentType;
		if (!contentType || contentType.trim() === ``) {
			if (isFork) contentType = sourceContentType;
		}
		let effectiveExpiresAt = options.expiresAt;
		let effectiveTtlSeconds = options.ttlSeconds;
		if (isFork) {
			const resolved = this.resolveForkExpiry(options, sourceStream);
			effectiveExpiresAt = resolved.expiresAt;
			effectiveTtlSeconds = resolved.ttlSeconds;
		}
		const stream = {
			path,
			contentType,
			messages: [],
			currentOffset: isFork ? forkOffset : `0000000000000000_0000000000000000`,
			ttlSeconds: effectiveTtlSeconds,
			expiresAt: effectiveExpiresAt,
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),
			closed: options.closed ?? false,
			refCount: 0,
			forkedFrom: isFork ? options.forkedFrom : void 0,
			forkOffset: isFork ? forkOffset : void 0
		};
		if (forkSubOffsetPrefix && forkSubOffsetPrefix.length > 0) {
			const parts = stream.currentOffset.split(`_`).map(Number);
			const readSeq = parts[0];
			const byteOffset = parts[1];
			const newByteOffset = byteOffset + forkSubOffsetPrefix.length + 5;
			const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`;
			stream.messages.push({
				data: forkSubOffsetPrefix,
				offset: newOffset,
				timestamp: Date.now()
			});
			stream.currentOffset = newOffset;
			stream.forkSubOffset = options.forkSubOffset;
		}
		if (options.initialData && options.initialData.length > 0) try {
			this.appendToStream(stream, options.initialData, true);
		} catch (err) {
			if (isFork && sourceStream) sourceStream.refCount--;
			throw err;
		}
		this.streams.set(path, stream);
		return stream;
	}
	/**
	* Resolve fork expiry per the decision table.
	* Forks have independent lifetimes — no capping at source expiry.
	*/
	resolveForkExpiry(opts, sourceMeta) {
		if (opts.ttlSeconds !== void 0) return { ttlSeconds: opts.ttlSeconds };
		if (opts.expiresAt) return { expiresAt: opts.expiresAt };
		if (sourceMeta.ttlSeconds !== void 0) return { ttlSeconds: sourceMeta.ttlSeconds };
		if (sourceMeta.expiresAt) return { expiresAt: sourceMeta.expiresAt };
		return {};
	}
	/**
	* Get a stream by path.
	* Returns undefined if stream doesn't exist or is expired.
	* Returns soft-deleted streams (caller should check stream.softDeleted).
	*/
	get(path) {
		const stream = this.streams.get(path);
		if (!stream) return void 0;
		if (this.isExpired(stream)) {
			if (stream.refCount > 0) {
				stream.softDeleted = true;
				return stream;
			}
			this.delete(path);
			return void 0;
		}
		return stream;
	}
	/**
	* Check if a stream exists, is not expired, and is not soft-deleted.
	*/
	has(path) {
		const stream = this.get(path);
		if (!stream) return false;
		if (stream.softDeleted) return false;
		return true;
	}
	/**
	* Delete a stream.
	* If the stream has forks (refCount > 0), it is soft-deleted instead of fully removed.
	* Returns true if the stream was found and deleted (or soft-deleted).
	*/
	delete(path) {
		const stream = this.streams.get(path);
		if (!stream) return false;
		if (stream.softDeleted) return true;
		if (stream.refCount > 0) {
			stream.softDeleted = true;
			return true;
		}
		this.deleteWithCascade(path);
		return true;
	}
	/**
	* Fully delete a stream and cascade to soft-deleted parents
	* whose refcount drops to zero.
	*/
	deleteWithCascade(path) {
		const stream = this.streams.get(path);
		if (!stream) return;
		const forkedFrom = stream.forkedFrom;
		this.streams.delete(path);
		this.cancelLongPollsForStream(path);
		if (forkedFrom) {
			const parent = this.streams.get(forkedFrom);
			if (parent) {
				parent.refCount--;
				if (parent.refCount < 0) parent.refCount = 0;
				if (parent.refCount === 0 && parent.softDeleted) this.deleteWithCascade(forkedFrom);
			}
		}
	}
	/**
	* Validate producer state WITHOUT mutating.
	* Returns proposed state to commit after successful append.
	* Implements Kafka-style idempotent producer validation.
	*
	* IMPORTANT: This function does NOT mutate producer state. The caller must
	* call commitProducerState() after successful append to apply the mutation.
	* This ensures atomicity: if append fails (e.g., JSON validation), producer
	* state is not incorrectly advanced.
	*/
	validateProducer(stream, producerId, epoch, seq) {
		if (!stream.producers) stream.producers = new Map();
		this.cleanupExpiredProducers(stream);
		const state = stream.producers.get(producerId);
		const now = Date.now();
		if (!state) {
			if (seq !== 0) return {
				status: `sequence_gap`,
				expectedSeq: 0,
				receivedSeq: seq
			};
			return {
				status: `accepted`,
				isNew: true,
				producerId,
				proposedState: {
					epoch,
					lastSeq: 0,
					lastUpdated: now
				}
			};
		}
		if (epoch < state.epoch) return {
			status: `stale_epoch`,
			currentEpoch: state.epoch
		};
		if (epoch > state.epoch) {
			if (seq !== 0) return { status: `invalid_epoch_seq` };
			return {
				status: `accepted`,
				isNew: true,
				producerId,
				proposedState: {
					epoch,
					lastSeq: 0,
					lastUpdated: now
				}
			};
		}
		if (seq <= state.lastSeq) return {
			status: `duplicate`,
			lastSeq: state.lastSeq
		};
		if (seq === state.lastSeq + 1) return {
			status: `accepted`,
			isNew: false,
			producerId,
			proposedState: {
				epoch,
				lastSeq: seq,
				lastUpdated: now
			}
		};
		return {
			status: `sequence_gap`,
			expectedSeq: state.lastSeq + 1,
			receivedSeq: seq
		};
	}
	/**
	* Commit producer state after successful append.
	* This is the only place where producer state is mutated.
	*/
	commitProducerState(stream, result) {
		if (result.status !== `accepted`) return;
		stream.producers.set(result.producerId, result.proposedState);
	}
	/**
	* Clean up expired producer states from a stream.
	*/
	cleanupExpiredProducers(stream) {
		if (!stream.producers) return;
		const now = Date.now();
		for (const [id, state] of stream.producers) if (now - state.lastUpdated > PRODUCER_STATE_TTL_MS) stream.producers.delete(id);
	}
	/**
	* Acquire a lock for serialized producer operations.
	* Returns a release function.
	*/
	async acquireProducerLock(path, producerId) {
		const lockKey = `${path}:${producerId}`;
		while (this.producerLocks.has(lockKey)) await this.producerLocks.get(lockKey);
		let releaseLock;
		const lockPromise = new Promise((resolve) => {
			releaseLock = resolve;
		});
		this.producerLocks.set(lockKey, lockPromise);
		return () => {
			this.producerLocks.delete(lockKey);
			releaseLock();
		};
	}
	/**
	* Append data to a stream.
	* @throws Error if stream doesn't exist or is expired
	* @throws Error if seq is lower than lastSeq
	* @throws Error if JSON mode and array is empty
	*/
	append(path, data, options = {}) {
		const stream = this.getIfNotExpired(path);
		if (!stream) throw new Error(`Stream not found: ${path}`);
		if (stream.softDeleted) throw new Error(`Stream is soft-deleted: ${path}`);
		if (stream.closed) {
			if (options.producerId && stream.closedBy && stream.closedBy.producerId === options.producerId && stream.closedBy.epoch === options.producerEpoch && stream.closedBy.seq === options.producerSeq) return {
				message: null,
				streamClosed: true,
				producerResult: {
					status: `duplicate`,
					lastSeq: options.producerSeq
				}
			};
			return {
				message: null,
				streamClosed: true
			};
		}
		if (options.contentType && stream.contentType) {
			const providedType = normalizeContentType(options.contentType);
			const streamType = normalizeContentType(stream.contentType);
			if (providedType !== streamType) throw new Error(`Content-type mismatch: expected ${stream.contentType}, got ${options.contentType}`);
		}
		let producerResult;
		if (options.producerId !== void 0 && options.producerEpoch !== void 0 && options.producerSeq !== void 0) {
			producerResult = this.validateProducer(stream, options.producerId, options.producerEpoch, options.producerSeq);
			if (producerResult.status !== `accepted`) return {
				message: null,
				producerResult
			};
		}
		if (options.seq !== void 0) {
			if (stream.lastSeq !== void 0 && options.seq <= stream.lastSeq) throw new Error(`Sequence conflict: ${options.seq} <= ${stream.lastSeq}`);
		}
		const message = this.appendToStream(stream, data);
		if (producerResult) this.commitProducerState(stream, producerResult);
		if (options.seq !== void 0) stream.lastSeq = options.seq;
		if (options.close) {
			stream.closed = true;
			if (options.producerId !== void 0) stream.closedBy = {
				producerId: options.producerId,
				epoch: options.producerEpoch,
				seq: options.producerSeq
			};
		}
		this.notifyLongPolls(path);
		if (options.close) this.notifyLongPollsClosed(path);
		if (producerResult || options.close) return {
			message,
			producerResult,
			streamClosed: options.close
		};
		return message;
	}
	/**
	* Append with producer serialization for concurrent request handling.
	* This ensures that validation+append is atomic per producer.
	*/
	async appendWithProducer(path, data, options) {
		if (!options.producerId) {
			const result = this.append(path, data, options);
			if (`message` in result) return result;
			return { message: result };
		}
		const releaseLock = await this.acquireProducerLock(path, options.producerId);
		try {
			const result = this.append(path, data, options);
			if (`message` in result) return result;
			return { message: result };
		} finally {
			releaseLock();
		}
	}
	/**
	* Close a stream without appending data.
	* @returns The final offset, or null if stream doesn't exist
	*/
	async closeStream(path) {
		const stream = this.getIfNotExpired(path);
		if (!stream) return null;
		if (stream.softDeleted) throw new Error(`Stream is soft-deleted: ${path}`);
		const alreadyClosed = stream.closed ?? false;
		stream.closed = true;
		this.notifyLongPollsClosed(path);
		return {
			finalOffset: stream.currentOffset,
			alreadyClosed
		};
	}
	/**
	* Close a stream with producer headers for idempotent close-only operations.
	* Participates in producer sequencing for deduplication.
	* @returns The final offset and producer result, or null if stream doesn't exist
	*/
	async closeStreamWithProducer(path, options) {
		const releaseLock = await this.acquireProducerLock(path, options.producerId);
		try {
			const stream = this.getIfNotExpired(path);
			if (!stream) return null;
			if (stream.closed) {
				if (stream.closedBy && stream.closedBy.producerId === options.producerId && stream.closedBy.epoch === options.producerEpoch && stream.closedBy.seq === options.producerSeq) return {
					finalOffset: stream.currentOffset,
					alreadyClosed: true,
					producerResult: {
						status: `duplicate`,
						lastSeq: options.producerSeq
					}
				};
				return {
					finalOffset: stream.currentOffset,
					alreadyClosed: true,
					producerResult: { status: `stream_closed` }
				};
			}
			const producerResult = this.validateProducer(stream, options.producerId, options.producerEpoch, options.producerSeq);
			if (producerResult.status !== `accepted`) return {
				finalOffset: stream.currentOffset,
				alreadyClosed: stream.closed ?? false,
				producerResult
			};
			this.commitProducerState(stream, producerResult);
			stream.closed = true;
			stream.closedBy = {
				producerId: options.producerId,
				epoch: options.producerEpoch,
				seq: options.producerSeq
			};
			this.notifyLongPollsClosed(path);
			return {
				finalOffset: stream.currentOffset,
				alreadyClosed: false,
				producerResult
			};
		} finally {
			releaseLock();
		}
	}
	/**
	* Get the current epoch for a producer on a stream.
	* Returns undefined if the producer doesn't exist or stream not found.
	*/
	getProducerEpoch(path, producerId) {
		const stream = this.getIfNotExpired(path);
		if (!stream?.producers) return void 0;
		return stream.producers.get(producerId)?.epoch;
	}
	/**
	* Read messages from a stream starting at the given offset.
	* For forked streams, stitches messages from the source chain and the fork's own messages.
	* @throws Error if stream doesn't exist or is expired
	*/
	read(path, offset) {
		const stream = this.getIfNotExpired(path);
		if (!stream) throw new Error(`Stream not found: ${path}`);
		if (!offset || offset === `-1`) {
			if (stream.forkedFrom) {
				const inherited = this.readForkedMessages(stream.forkedFrom, void 0, stream.forkOffset);
				return {
					messages: [...inherited, ...stream.messages],
					upToDate: true
				};
			}
			return {
				messages: [...stream.messages],
				upToDate: true
			};
		}
		if (stream.forkedFrom) return this.readFromFork(stream, offset);
		const offsetIndex = this.findOffsetIndex(stream, offset);
		if (offsetIndex === -1) return {
			messages: [],
			upToDate: true
		};
		return {
			messages: stream.messages.slice(offsetIndex),
			upToDate: true
		};
	}
	/**
	* Read from a forked stream, stitching inherited and own messages.
	*/
	readFromFork(stream, offset) {
		const messages = [];
		if (offset < stream.forkOffset) {
			const inherited = this.readForkedMessages(stream.forkedFrom, offset, stream.forkOffset);
			messages.push(...inherited);
		}
		const ownMessages = this.readOwnMessages(stream, offset);
		messages.push(...ownMessages);
		return {
			messages,
			upToDate: true
		};
	}
	/**
	* Read a stream's own messages starting after the given offset.
	*/
	readOwnMessages(stream, offset) {
		const offsetIndex = this.findOffsetIndex(stream, offset);
		if (offsetIndex === -1) return [];
		return stream.messages.slice(offsetIndex);
	}
	/**
	* Recursively read messages from a fork's source chain.
	* Reads from source (and its sources if also forked), capped at forkOffset.
	* Does NOT check softDeleted — forks must read through soft-deleted sources.
	*/
	readForkedMessages(sourcePath, offset, capOffset) {
		const source = this.streams.get(sourcePath);
		if (!source) return [];
		const messages = [];
		if (source.forkedFrom && (!offset || offset < source.forkOffset)) {
			const inherited = this.readForkedMessages(
				source.forkedFrom,
				offset,
				// Cap at the minimum of source's forkOffset and our capOffset
				source.forkOffset < capOffset ? source.forkOffset : capOffset
);
			messages.push(...inherited);
		}
		for (const msg of source.messages) {
			if (offset && msg.offset <= offset) continue;
			if (msg.offset > capOffset) break;
			messages.push(msg);
		}
		return messages;
	}
	/**
	* Format messages for response.
	* For JSON mode, wraps concatenated data in array brackets.
	* @throws Error if stream doesn't exist or is expired
	*/
	formatResponse(path, messages) {
		const stream = this.getIfNotExpired(path);
		if (!stream) throw new Error(`Stream not found: ${path}`);
		if (normalizeContentType(stream.contentType) === `application/json`) return formatJsonMessages(messages);
		const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0);
		const concatenated = new Uint8Array(totalSize);
		let offset = 0;
		for (const msg of messages) {
			concatenated.set(msg.data, offset);
			offset += msg.data.length;
		}
		return concatenated;
	}
	/**
	* Wait for new messages (long-poll).
	* @throws Error if stream doesn't exist or is expired
	*/
	async waitForMessages(path, offset, timeoutMs) {
		const stream = this.getIfNotExpired(path);
		if (!stream) throw new Error(`Stream not found: ${path}`);
		if (stream.forkedFrom && offset < stream.forkOffset) {
			const { messages: messages$1 } = this.read(path, offset);
			return {
				messages: messages$1,
				timedOut: false
			};
		}
		const { messages } = this.read(path, offset);
		if (messages.length > 0) return {
			messages,
			timedOut: false
		};
		if (stream.closed && offset === stream.currentOffset) return {
			messages: [],
			timedOut: false,
			streamClosed: true
		};
		return new Promise((resolve) => {
			const timeoutId = setTimeout(() => {
				this.removePendingLongPoll(pending);
				const currentStream = this.getIfNotExpired(path);
				const streamClosed = currentStream?.closed ?? false;
				resolve({
					messages: [],
					timedOut: true,
					streamClosed
				});
			}, timeoutMs);
			const pending = {
				path,
				offset,
				resolve: (msgs) => {
					clearTimeout(timeoutId);
					this.removePendingLongPoll(pending);
					const currentStream = this.getIfNotExpired(path);
					const streamClosed = currentStream?.closed && msgs.length === 0 ? true : void 0;
					resolve({
						messages: msgs,
						timedOut: false,
						streamClosed
					});
				},
				timeoutId
			};
			this.pendingLongPolls.push(pending);
		});
	}
	/**
	* Get the current offset for a stream.
	* Returns undefined if stream doesn't exist or is expired.
	*/
	getCurrentOffset(path) {
		return this.getIfNotExpired(path)?.currentOffset;
	}
	/**
	* Clear all streams.
	*/
	clear() {
		for (const pending of this.pendingLongPolls) {
			clearTimeout(pending.timeoutId);
			pending.resolve([]);
		}
		this.pendingLongPolls = [];
		this.streams.clear();
	}
	/**
	* Cancel all pending long-polls (used during shutdown).
	*/
	cancelAllWaits() {
		for (const pending of this.pendingLongPolls) {
			clearTimeout(pending.timeoutId);
			pending.resolve([]);
		}
		this.pendingLongPolls = [];
	}
	/**
	* Get all stream paths.
	*/
	list() {
		return Array.from(this.streams.keys());
	}
	/**
	* Resolve a sub-offset against a source stream and return the prefix bytes
	* to materialize as the fork's first own message. Reads from the source
	* (across its fork chain if any) starting at forkOffset; the first message
	* returned is the one that starts at forkOffset. Throws if the sub-offset
	* cannot be satisfied (no message past forkOffset, or overshoots its
	* content extent).
	*/
	resolveForkSubOffset(sourceStream, forkOffset, subOffset, isJSON) {
		let sourceMessages;
		if (sourceStream.forkedFrom) sourceMessages = [...this.readForkedMessages(sourceStream.forkedFrom, forkOffset, sourceStream.forkOffset), ...this.readOwnMessages(sourceStream, forkOffset)];
		else sourceMessages = this.readOwnMessages(sourceStream, forkOffset);
		if (sourceMessages.length === 0) throw new Error(`Invalid fork sub-offset: no data past forkOffset`);
		const first = sourceMessages[0];
		if (isJSON) {
			const text = new TextDecoder().decode(first.data);
			const trimmed = text.endsWith(`,`) ? text.slice(0, -1) : text;
			let values;
			try {
				values = JSON.parse(`[${trimmed}]`);
			} catch {
				throw new Error(`Invalid fork sub-offset: source JSON is unparseable`);
			}
			if (subOffset > values.length) throw new Error(`Invalid fork sub-offset: overshoots source message count`);
			const prefix = values.slice(0, subOffset).map((v) => JSON.stringify(v));
			return new TextEncoder().encode(prefix.join(`,`) + `,`);
		}
		if (subOffset > first.data.length) throw new Error(`Invalid fork sub-offset: overshoots source message length`);
		return first.data.slice(0, subOffset);
	}
	appendToStream(stream, data, isInitialCreate = false) {
		let processedData = data;
		if (normalizeContentType(stream.contentType) === `application/json`) {
			processedData = processJsonAppend(data, isInitialCreate);
			if (processedData.length === 0) return null;
		}
		const parts = stream.currentOffset.split(`_`).map(Number);
		const readSeq = parts[0];
		const byteOffset = parts[1];
		const FRAME_OVERHEAD = 5;
		const newByteOffset = byteOffset + FRAME_OVERHEAD + processedData.length;
		const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`;
		const message = {
			data: processedData,
			offset: newOffset,
			timestamp: Date.now()
		};
		stream.messages.push(message);
		stream.currentOffset = newOffset;
		return message;
	}
	findOffsetIndex(stream, offset) {
		for (let i = 0; i < stream.messages.length; i++) if (stream.messages[i].offset > offset) return i;
		return -1;
	}
	notifyLongPolls(path) {
		const toNotify = this.pendingLongPolls.filter((p) => p.path === path);
		for (const pending of toNotify) {
			const { messages } = this.read(path, pending.offset);
			if (messages.length > 0) pending.resolve(messages);
		}
	}
	/**
	* Notify pending long-polls that a stream has been closed.
	* They should wake up immediately and return Stream-Closed: true.
	*/
	notifyLongPollsClosed(path) {
		const toNotify = this.pendingLongPolls.filter((p) => p.path === path);
		for (const pending of toNotify) pending.resolve([]);
	}
	cancelLongPollsForStream(path) {
		const toCancel = this.pendingLongPolls.filter((p) => p.path === path);
		for (const pending of toCancel) {
			clearTimeout(pending.timeoutId);
			pending.resolve([]);
		}
		this.pendingLongPolls = this.pendingLongPolls.filter((p) => p.path !== path);
	}
	removePendingLongPoll(pending) {
		const index = this.pendingLongPolls.indexOf(pending);
		if (index !== -1) this.pendingLongPolls.splice(index, 1);
	}
};

//#endregion
//#region src/log.ts
const streamsLogFile = process.env.STREAMS_LOG_FILE;
async function appendLogLine(line) {
	if (!streamsLogFile) return;
	const fs = await import(`node:fs/promises`);
	const path = await import(`node:path`);
	await fs.mkdir(path.dirname(streamsLogFile), { recursive: true });
	await fs.appendFile(streamsLogFile, `${line}\n`);
}
function serializeArg(arg) {
	if (arg instanceof Error) return arg.stack ?? arg.message;
	if (typeof arg === `string`) return arg;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}
function write(level, args) {
	const line = args.map(serializeArg).join(` `);
	const formatted = `[${level}] ${line}`;
	if (level === `error`) console.error(formatted);
	else if (level === `warn`) console.warn(formatted);
	else console.info(formatted);
	appendLogLine(formatted).catch(() => void 0);
}
const serverLog = {
	info(...args) {
		write(`info`, args);
	},
	warn(...args) {
		write(`warn`, args);
	},
	error(...args) {
		write(`error`, args);
	},
	event(obj, msg) {
		write(`info`, [msg, obj]);
	}
};

//#endregion
//#region src/path-encoding.ts
const MAX_ENCODED_LENGTH = 200;
/**
* Encode a stream path to a filesystem-safe directory name using base64url encoding.
* Long paths (>200 chars) are hashed to keep directory names manageable.
*
* @example
* encodeStreamPath("/stream/users:created") → "L3N0cmVhbS91c2VyczpjcmVhdGVk"
*/
function encodeStreamPath(path) {
	const base64 = Buffer.from(path, `utf-8`).toString(`base64`).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=/g, ``);
	if (base64.length > MAX_ENCODED_LENGTH) {
		const hash = (0, node_crypto.createHash)(`sha256`).update(path).digest(`hex`).slice(0, 16);
		return `${base64.slice(0, 180)}~${hash}`;
	}
	return base64;
}
/**
* Decode a filesystem-safe directory name back to the original stream path.
*
* @example
* decodeStreamPath("L3N0cmVhbS91c2VyczpjcmVhdGVk") → "/stream/users:created"
*/
function decodeStreamPath(encoded) {
	let base = encoded;
	const tildeIndex = encoded.lastIndexOf(`~`);
	if (tildeIndex !== -1) {
		const possibleHash = encoded.slice(tildeIndex + 1);
		if (possibleHash.length === 16 && /^[0-9a-f]+$/.test(possibleHash)) base = encoded.slice(0, tildeIndex);
	}
	const normalized = base.replace(/-/g, `+`).replace(/_/g, `/`);
	const padded = normalized + `=`.repeat((4 - normalized.length % 4) % 4);
	return Buffer.from(padded, `base64`).toString(`utf-8`);
}

//#endregion
//#region src/file-store.ts
var FileHandlePool = class {
	cache;
	constructor(maxSize) {
		this.cache = new __neophi_sieve_cache.SieveCache(maxSize, { evictHook: (_key, handle) => {
			this.closeHandle(handle).catch((err) => {
				serverLog.error(`[FileHandlePool] Error closing evicted handle:`, err);
			});
		} });
	}
	getWriteStream(filePath) {
		let handle = this.cache.get(filePath);
		if (!handle) {
			const stream = node_fs.createWriteStream(filePath, { flags: `a` });
			handle = {
				stream,
				syncLeader: null
			};
			this.cache.set(filePath, handle);
		}
		return handle.stream;
	}
	/**
	* Open a write stream eagerly so the first write does not pay the lazy
	* `open()` stall. Resolves once the underlying fd is ready.
	*/
	async openWriteStream(filePath) {
		const stream = this.getWriteStream(filePath);
		const fd = stream.fd;
		if (typeof fd === `number`) return stream;
		await new Promise((resolve, reject) => {
			stream.once(`open`, () => resolve());
			stream.once(`error`, (err) => reject(err));
		});
		return stream;
	}
	/**
	* Flush a specific file to disk immediately.
	* Concurrent callers on the same fd share one in-flight fdatasync: the
	* first caller issues the syscall, later arrivals during that window wait
	* for it to finish and then issue a fresh syscall (because their writes
	* may have landed after the in-flight syscall started). This preserves
	* durability without adding scheduling latency.
	*/
	fsyncFile(filePath) {
		const handle = this.cache.get(filePath);
		if (!handle) return Promise.reject(new Error(`[FileHandlePool] Cannot fsync: handle not found for ${filePath}`));
		const existing = handle.syncLeader;
		if (existing && existing.scheduled) return existing.promise;
		let resolveFn;
		let rejectFn;
		const promise = new Promise((res, rej) => {
			resolveFn = res;
			rejectFn = rej;
		});
		const leader = {
			promise,
			scheduled: true
		};
		handle.syncLeader = leader;
		const runSyscall = (fd$1) => {
			leader.scheduled = false;
			node_fs.fdatasync(fd$1, (err) => {
				if (handle.syncLeader === leader) handle.syncLeader = null;
				if (err) rejectFn(err);
				else resolveFn();
			});
		};
		const fd = handle.stream.fd;
		if (typeof fd === `number`) runSyscall(fd);
		else {
			handle.stream.once(`open`, (openedFd) => runSyscall(openedFd));
			handle.stream.once(`error`, (err) => {
				if (handle.syncLeader === leader) handle.syncLeader = null;
				rejectFn(err);
			});
		}
		return promise;
	}
	async closeAll() {
		const promises = [];
		for (const [_key, handle] of this.cache.entries()) promises.push(this.closeHandle(handle));
		await Promise.all(promises);
		this.cache.clear();
	}
	/**
	* Close a specific file handle if it exists in the cache.
	* Useful for cleanup before deleting files.
	*/
	async closeFileHandle(filePath) {
		const handle = this.cache.get(filePath);
		if (handle) {
			await this.closeHandle(handle);
			this.cache.delete(filePath);
		}
	}
	async closeHandle(handle) {
		return new Promise((resolve) => {
			handle.stream.end(() => resolve());
		});
	}
};
/**
* Generate a unique directory name for a stream.
* Format: {encoded_path}~{timestamp}~{random_hex}
* This allows safe async deletion and immediate reuse of stream paths.
*/
function generateUniqueDirectoryName(streamPath) {
	const encoded = encodeStreamPath(streamPath);
	const timestamp = Date.now().toString(36);
	const random = (0, node_crypto.randomBytes)(4).toString(`hex`);
	return `${encoded}~${timestamp}~${random}`;
}
function segmentFile(dataDir, dirName) {
	return node_path.join(dataDir, `streams`, `${dirName}.log`);
}
/**
* File-backed implementation of StreamStore.
* Maintains the same interface as the in-memory StreamStore for drop-in compatibility.
*/
var FileBackedStreamStore = class {
	db;
	fileHandlePool;
	pendingLongPolls = [];
	dataDir;
	/**
	* Per-producer locks for serializing validation+append operations.
	* Key: "{streamPath}:{producerId}"
	*/
	producerLocks = new Map();
	/**
	* Per-stream append locks. Serializes the read-modify-write of currentOffset
	* across all concurrent appenders on the same stream so the LMDB-tracked
	* offset cannot drift behind the file's actual byte position.
	* Key: streamPath
	*/
	streamAppendLocks = new Map();
	constructor(options) {
		this.dataDir = options.dataDir;
		this.db = (0, lmdb.open)({
			path: node_path.join(this.dataDir, `metadata.lmdb`),
			compression: true,
			noMemInit: true,
			cache: true,
			sharedStructuresKey: Symbol.for(`structures`)
		});
		node_fs.mkdirSync(node_path.join(this.dataDir, `streams`), { recursive: true });
		const maxFileHandles = options.maxFileHandles ?? 100;
		this.fileHandlePool = new FileHandlePool(maxFileHandles);
		this.recover();
	}
	/**
	* Recover streams from disk on startup.
	* Validates that LMDB metadata matches actual file contents and reconciles any mismatches.
	*/
	recover() {
		serverLog.info(`[FileBackedStreamStore] Starting recovery...`);
		let recovered = 0;
		let reconciled = 0;
		let errors = 0;
		const range = this.db.getRange({
			start: `stream:`,
			end: `stream:\xFF`
		});
		const entries = Array.from(range);
		for (const { key, value } of entries) try {
			if (typeof key !== `string`) continue;
			const streamMeta = value;
			const streamPath = key.replace(`stream:`, ``);
			const segmentPath = segmentFile(this.dataDir, streamMeta.directoryName);
			if (!node_fs.existsSync(segmentPath)) {
				serverLog.warn(`[FileBackedStreamStore] Recovery: Stream file missing for ${streamPath}, removing from LMDB`);
				this.db.removeSync(key);
				errors++;
				continue;
			}
			const physicalOffset = this.scanFileForTrueOffset(segmentPath);
			const physicalBytes = Number(physicalOffset.split(`_`)[1] ?? 0);
			let trueOffset;
			if (streamMeta.forkOffset) {
				const forkBaseByte = Number(streamMeta.forkOffset.split(`_`)[1] ?? 0);
				const logicalBytes = forkBaseByte + physicalBytes;
				trueOffset = `${String(0).padStart(16, `0`)}_${String(logicalBytes).padStart(16, `0`)}`;
			} else trueOffset = physicalOffset;
			if (trueOffset !== streamMeta.currentOffset) {
				serverLog.warn(`[FileBackedStreamStore] Recovery: Offset mismatch for ${streamPath}: LMDB says ${streamMeta.currentOffset}, file says ${trueOffset}. Reconciling to file.`);
				const reconciledMeta = {
					...streamMeta,
					currentOffset: trueOffset
				};
				this.db.putSync(key, reconciledMeta);
				reconciled++;
			}
			recovered++;
		} catch (err) {
			serverLog.error(`[FileBackedStreamStore] Error recovering stream:`, err);
			errors++;
		}
		serverLog.info(`[FileBackedStreamStore] Recovery complete: ${recovered} streams, ${reconciled} reconciled, ${errors} errors`);
	}
	/**
	* Scan a segment file to compute the true last offset.
	* Handles partial/truncated messages at the end.
	*/
	scanFileForTrueOffset(segmentPath) {
		try {
			const fileContent = node_fs.readFileSync(segmentPath);
			let filePos = 0;
			while (filePos < fileContent.length) {
				if (filePos + 4 > fileContent.length) break;
				const messageLength = fileContent.readUInt32BE(filePos);
				const frameEnd = filePos + 4 + messageLength + 1;
				if (frameEnd > fileContent.length) break;
				filePos = frameEnd;
			}
			return `0000000000000000_${String(filePos).padStart(16, `0`)}`;
		} catch (err) {
			serverLog.error(`[FileBackedStreamStore] Error scanning file ${segmentPath}:`, err);
			return `0000000000000000_0000000000000000`;
		}
	}
	/**
	* Convert LMDB metadata to Stream object.
	*/
	streamMetaToStream(meta) {
		let producers;
		if (meta.producers) {
			producers = new Map();
			for (const [id, state] of Object.entries(meta.producers)) producers.set(id, { ...state });
		}
		return {
			path: meta.path,
			contentType: meta.contentType,
			messages: [],
			currentOffset: meta.currentOffset,
			lastSeq: meta.lastSeq,
			ttlSeconds: meta.ttlSeconds,
			expiresAt: meta.expiresAt,
			createdAt: meta.createdAt,
			lastAccessedAt: meta.lastAccessedAt ?? meta.createdAt,
			producers,
			closed: meta.closed,
			closedBy: meta.closedBy,
			forkedFrom: meta.forkedFrom,
			forkOffset: meta.forkOffset,
			refCount: meta.refCount ?? 0,
			softDeleted: meta.softDeleted
		};
	}
	/**
	* Validate producer state WITHOUT mutating.
	* Returns proposed state to commit after successful append.
	*
	* IMPORTANT: This function does NOT mutate producer state. The caller must
	* commit the proposedState after successful append (file write + fsync + LMDB).
	* This ensures atomicity: if any step fails, producer state is not advanced.
	*/
	validateProducer(meta, producerId, epoch, seq) {
		if (!meta.producers) meta.producers = {};
		const state = meta.producers[producerId];
		const now = Date.now();
		if (!state) {
			if (seq !== 0) return {
				status: `sequence_gap`,
				expectedSeq: 0,
				receivedSeq: seq
			};
			return {
				status: `accepted`,
				isNew: true,
				producerId,
				proposedState: {
					epoch,
					lastSeq: 0,
					lastUpdated: now
				}
			};
		}
		if (epoch < state.epoch) return {
			status: `stale_epoch`,
			currentEpoch: state.epoch
		};
		if (epoch > state.epoch) {
			if (seq !== 0) return { status: `invalid_epoch_seq` };
			return {
				status: `accepted`,
				isNew: true,
				producerId,
				proposedState: {
					epoch,
					lastSeq: 0,
					lastUpdated: now
				}
			};
		}
		if (seq <= state.lastSeq) return {
			status: `duplicate`,
			lastSeq: state.lastSeq
		};
		if (seq === state.lastSeq + 1) return {
			status: `accepted`,
			isNew: false,
			producerId,
			proposedState: {
				epoch,
				lastSeq: seq,
				lastUpdated: now
			}
		};
		return {
			status: `sequence_gap`,
			expectedSeq: state.lastSeq + 1,
			receivedSeq: seq
		};
	}
	/**
	* Acquire a lock for serialized producer operations.
	* Returns a release function.
	*/
	async acquireProducerLock(streamPath, producerId) {
		const lockKey = `${streamPath}:${producerId}`;
		while (this.producerLocks.has(lockKey)) await this.producerLocks.get(lockKey);
		let releaseLock;
		const lockPromise = new Promise((resolve) => {
			releaseLock = resolve;
		});
		this.producerLocks.set(lockKey, lockPromise);
		return () => {
			this.producerLocks.delete(lockKey);
			releaseLock();
		};
	}
	/**
	* Acquire a per-stream append lock that serializes the read-modify-write
	* of currentOffset across all concurrent appenders on the same stream.
	* Without this, two concurrent appends can read the same starting
	* currentOffset, both compute their newOffset, both write a frame to the
	* file, but only one of their LMDB updates wins — leaving currentOffset
	* lagging the file's actual byte position. Returns a release function.
	*/
	async acquireStreamAppendLock(streamPath) {
		while (this.streamAppendLocks.has(streamPath)) await this.streamAppendLocks.get(streamPath);
		let releaseLock;
		const lockPromise = new Promise((resolve) => {
			releaseLock = resolve;
		});
		this.streamAppendLocks.set(streamPath, lockPromise);
		return () => {
			this.streamAppendLocks.delete(streamPath);
			releaseLock();
		};
	}
	/**
	* Get the current epoch for a producer on a stream.
	* Returns undefined if the producer doesn't exist or stream not found.
	*/
	getProducerEpoch(streamPath, producerId) {
		const meta = this.getMetaIfNotExpired(streamPath);
		if (!meta?.producers) return void 0;
		return meta.producers[producerId]?.epoch;
	}
	/**
	* Update lastAccessedAt to now. Called on reads and appends (not HEAD).
	*/
	touchAccess(streamPath) {
		const key = `stream:${streamPath}`;
		const meta = this.db.get(key);
		if (meta) {
			const updatedMeta = {
				...meta,
				lastAccessedAt: Date.now()
			};
			this.db.putSync(key, updatedMeta);
		}
	}
	/**
	* Check if a stream is expired based on TTL or Expires-At.
	*/
	isExpired(meta) {
		const now = Date.now();
		if (meta.expiresAt) {
			const expiryTime = new Date(meta.expiresAt).getTime();
			if (!Number.isFinite(expiryTime) || now >= expiryTime) return true;
		}
		if (meta.ttlSeconds !== void 0) {
			const lastAccessed = meta.lastAccessedAt ?? meta.createdAt;
			const expiryTime = lastAccessed + meta.ttlSeconds * 1e3;
			if (now >= expiryTime) return true;
		}
		return false;
	}
	/**
	* Get stream metadata, deleting it if expired.
	* Returns undefined if stream doesn't exist or is expired (and has no refs).
	* Expired streams with refCount > 0 are soft-deleted instead of fully deleted.
	*/
	getMetaIfNotExpired(streamPath) {
		const key = `stream:${streamPath}`;
		const meta = this.db.get(key);
		if (!meta) return void 0;
		if (this.isExpired(meta)) {
			if ((meta.refCount ?? 0) > 0) {
				if (!meta.softDeleted) {
					const updatedMeta = {
						...meta,
						softDeleted: true
					};
					this.db.putSync(key, updatedMeta);
					return updatedMeta;
				}
				return meta;
			}
			this.delete(streamPath);
			return void 0;
		}
		return meta;
	}
	/**
	* Resolve fork expiry per the decision table.
	* Forks have independent lifetimes — no capping at source expiry.
	*/
	resolveForkExpiry(opts, sourceMeta) {
		if (opts.ttlSeconds !== void 0) return { ttlSeconds: opts.ttlSeconds };
		if (opts.expiresAt) return { expiresAt: opts.expiresAt };
		if (sourceMeta.ttlSeconds !== void 0) return { ttlSeconds: sourceMeta.ttlSeconds };
		if (sourceMeta.expiresAt) return { expiresAt: sourceMeta.expiresAt };
		return {};
	}
	/**
	* Close the store, closing all file handles and database.
	* All data is already fsynced on each append, so no final flush needed.
	*/
	async close() {
		await this.fileHandlePool.closeAll();
		await this.db.close();
	}
	async create(streamPath, options = {}) {
		const existingRaw = this.db.get(`stream:${streamPath}`);
		if (existingRaw) if (this.isExpired(existingRaw)) this.delete(streamPath);
		else if (existingRaw.softDeleted) throw new Error(`Stream has active forks — path cannot be reused until all forks are removed: ${streamPath}`);
		else {
			const normalizeMimeType = (ct) => (ct ?? `application/octet-stream`).toLowerCase();
			const contentTypeMatches = normalizeMimeType(options.contentType) === normalizeMimeType(existingRaw.contentType);
			const ttlMatches = options.ttlSeconds === existingRaw.ttlSeconds;
			const expiresMatches = options.expiresAt === existingRaw.expiresAt;
			const closedMatches = (options.closed ?? false) === (existingRaw.closed ?? false);
			const forkedFromMatches = (options.forkedFrom ?? void 0) === existingRaw.forkedFrom;
			const forkOffsetMatches = options.forkOffset === void 0 || options.forkOffset === existingRaw.forkOffset;
			const requestedSub = options.forkSubOffset ?? 0;
			const existingSub = existingRaw.forkSubOffset ?? 0;
			const forkSubOffsetMatches = requestedSub === existingSub;
			if (contentTypeMatches && ttlMatches && expiresMatches && closedMatches && forkedFromMatches && forkOffsetMatches && forkSubOffsetMatches) return this.streamMetaToStream(existingRaw);
			else throw new Error(`Stream already exists with different configuration: ${streamPath}`);
		}
		const isFork = !!options.forkedFrom;
		let forkOffset = `0000000000000000_0000000000000000`;
		let sourceContentType;
		let sourceMeta;
		let forkSubOffsetPrefix;
		if (isFork) {
			const sourceKey = `stream:${options.forkedFrom}`;
			sourceMeta = this.db.get(sourceKey);
			if (!sourceMeta) throw new Error(`Source stream not found: ${options.forkedFrom}`);
			if (sourceMeta.softDeleted) throw new Error(`Source stream is soft-deleted: ${options.forkedFrom}`);
			if (this.isExpired(sourceMeta)) throw new Error(`Source stream not found: ${options.forkedFrom}`);
			sourceContentType = sourceMeta.contentType;
			if (options.contentType && options.contentType.trim() !== `` && normalizeContentType(options.contentType) !== normalizeContentType(sourceContentType)) throw new Error(`Content type mismatch with source stream`);
			if (options.forkOffset) forkOffset = options.forkOffset;
			else forkOffset = sourceMeta.currentOffset;
			const zeroOffset = `0000000000000000_0000000000000000`;
			if (forkOffset < zeroOffset || sourceMeta.currentOffset < forkOffset) throw new Error(`Invalid fork offset: ${forkOffset}`);
			if (options.forkSubOffset && options.forkSubOffset > 0) forkSubOffsetPrefix = this.resolveForkSubOffset(options.forkedFrom, forkOffset, options.forkSubOffset, normalizeContentType(sourceContentType) === `application/json`);
			const freshSource = this.db.get(sourceKey);
			const updatedSource = {
				...freshSource,
				refCount: (freshSource.refCount ?? 0) + 1
			};
			this.db.putSync(sourceKey, updatedSource);
		}
		let contentType = options.contentType;
		if (!contentType || contentType.trim() === ``) {
			if (isFork) contentType = sourceContentType;
		}
		let effectiveExpiresAt = options.expiresAt;
		let effectiveTtlSeconds = options.ttlSeconds;
		if (isFork) {
			const resolved = this.resolveForkExpiry(options, sourceMeta);
			effectiveExpiresAt = resolved.expiresAt;
			effectiveTtlSeconds = resolved.ttlSeconds;
		}
		const key = `stream:${streamPath}`;
		const t0 = performance.now();
		const streamMeta = {
			path: streamPath,
			contentType,
			currentOffset: isFork ? forkOffset : `0000000000000000_0000000000000000`,
			lastSeq: void 0,
			ttlSeconds: effectiveTtlSeconds,
			expiresAt: effectiveExpiresAt,
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),
			segmentCount: 1,
			totalBytes: 0,
			directoryName: generateUniqueDirectoryName(streamPath),
			closed: false,
			forkedFrom: isFork ? options.forkedFrom : void 0,
			forkOffset: isFork ? forkOffset : void 0,
			forkSubOffset: void 0,
			refCount: 0
		};
		const tAfterMeta = performance.now();
		const segmentPath = segmentFile(this.dataDir, streamMeta.directoryName);
		try {
			if (forkSubOffsetPrefix && forkSubOffsetPrefix.length > 0) {
				const lengthBuf = Buffer.allocUnsafe(4);
				lengthBuf.writeUInt32BE(forkSubOffsetPrefix.length, 0);
				const frameBuf = Buffer.concat([
					lengthBuf,
					Buffer.from(forkSubOffsetPrefix),
					Buffer.from(`\n`)
				]);
				const fd = node_fs.openSync(segmentPath, `wx`);
				try {
					let written = 0;
					while (written < frameBuf.length) {
						const bytesWritten = node_fs.writeSync(fd, frameBuf, written, frameBuf.length - written, written);
						if (bytesWritten === 0) throw new Error(`failed to write sub-offset prefix frame`);
						written += bytesWritten;
					}
					node_fs.fsyncSync(fd);
				} finally {
					node_fs.closeSync(fd);
				}
				const parts = streamMeta.currentOffset.split(`_`).map(Number);
				const readSeq = parts[0];
				const byteOffset = parts[1];
				const newByteOffset = byteOffset + forkSubOffsetPrefix.length + 5;
				streamMeta.currentOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`;
				streamMeta.forkSubOffset = options.forkSubOffset;
			}
			await this.db.put(key, streamMeta);
		} catch (err) {
			if (isFork && sourceMeta) {
				const sourceKey = `stream:${options.forkedFrom}`;
				const freshSource = this.db.get(sourceKey);
				if (freshSource) {
					const updatedSource = {
						...freshSource,
						refCount: Math.max(0, (freshSource.refCount ?? 0) - 1)
					};
					this.db.putSync(sourceKey, updatedSource);
				}
			}
			serverLog.error(`[FileBackedStreamStore] Error creating stream before metadata commit:`, err);
			throw err;
		}
		const tAfterLmdb = performance.now();
		try {
			await this.fileHandlePool.openWriteStream(segmentPath);
		} catch (err) {
			this.db.removeSync(key);
			serverLog.error(`[FileBackedStreamStore] Error creating stream (file open):`, err);
			throw err;
		}
		const tAfterOpen = performance.now();
		if (options.initialData && options.initialData.length > 0) try {
			await this.append(streamPath, options.initialData, {
				contentType: options.contentType,
				isInitialCreate: true
			});
		} catch (err) {
			if (isFork && sourceMeta) {
				const sourceKey = `stream:${options.forkedFrom}`;
				const freshSource = this.db.get(sourceKey);
				if (freshSource) {
					const updatedSource = {
						...freshSource,
						refCount: Math.max(0, (freshSource.refCount ?? 0) - 1)
					};
					this.db.putSync(sourceKey, updatedSource);
				}
			}
			throw err;
		}
		const tAfterAppend = performance.now();
		if (options.closed) {
			const updatedMeta = this.db.get(key);
			updatedMeta.closed = true;
			await this.db.put(key, updatedMeta);
		}
		const updated = this.db.get(key);
		const totalMs = performance.now() - t0;
		if (totalMs > 50) serverLog.event({
			event: `store.create`,
			path: streamPath,
			totalMs: +totalMs.toFixed(2),
			metaMs: +(tAfterMeta - t0).toFixed(2),
			lmdbMs: +(tAfterLmdb - tAfterMeta).toFixed(2),
			openMs: +(tAfterOpen - tAfterLmdb).toFixed(2),
			appendMs: +(tAfterAppend - tAfterOpen).toFixed(2),
			initBytes: options.initialData?.length ?? 0
		}, `store.create slow`);
		return this.streamMetaToStream(updated);
	}
	get(streamPath) {
		const meta = this.getMetaIfNotExpired(streamPath);
		if (!meta) return void 0;
		return this.streamMetaToStream(meta);
	}
	has(streamPath) {
		const meta = this.getMetaIfNotExpired(streamPath);
		if (!meta) return false;
		if (meta.softDeleted) return false;
		return true;
	}
	delete(streamPath) {
		const key = `stream:${streamPath}`;
		const streamMeta = this.db.get(key);
		if (!streamMeta) return false;
		if (streamMeta.softDeleted) return true;
		if ((streamMeta.refCount ?? 0) > 0) {
			const updatedMeta = {
				...streamMeta,
				softDeleted: true
			};
			this.db.putSync(key, updatedMeta);
			this.cancelLongPollsForStream(streamPath);
			return true;
		}
		this.deleteWithCascade(streamPath);
		return true;
	}
	/**
	* Fully delete a stream and cascade to soft-deleted parents
	* whose refcount drops to zero.
	*/
	deleteWithCascade(streamPath) {
		const key = `stream:${streamPath}`;
		const streamMeta = this.db.get(key);
		if (!streamMeta) return;
		const forkedFrom = streamMeta.forkedFrom;
		this.cancelLongPollsForStream(streamPath);
		const segmentPath = segmentFile(this.dataDir, streamMeta.directoryName);
		this.db.removeSync(key);
		this.fileHandlePool.closeFileHandle(segmentPath).then(() => node_fs.promises.unlink(segmentPath)).catch((err) => {
			serverLog.error(`[FileBackedStreamStore] Error cleaning up stream file:`, err);
		});
		if (forkedFrom) {
			const parentKey = `stream:${forkedFrom}`;
			const parentMeta = this.db.get(parentKey);
			if (parentMeta) {
				const newRefCount = Math.max(0, (parentMeta.refCount ?? 0) - 1);
				const updatedParent = {
					...parentMeta,
					refCount: newRefCount
				};
				this.db.putSync(parentKey, updatedParent);
				if (newRefCount === 0 && updatedParent.softDeleted) this.deleteWithCascade(forkedFrom);
			}
		}
	}
	/**
	* Public append entry point. Serializes concurrent appends to the same
	* stream so the read-modify-write of currentOffset cannot interleave —
	* see acquireStreamAppendLock for the underlying race.
	*/
	async append(streamPath, data, options = {}) {
		const releaseLock = await this.acquireStreamAppendLock(streamPath);
		try {
			return await this.appendInner(streamPath, data, options);
		} finally {
			releaseLock();
		}
	}
	async appendInner(streamPath, data, options = {}) {
		const streamMeta = this.getMetaIfNotExpired(streamPath);
		if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`);
		if (streamMeta.softDeleted) throw new Error(`Stream is soft-deleted: ${streamPath}`);
		if (streamMeta.closed) {
			if (options.producerId && streamMeta.closedBy && streamMeta.closedBy.producerId === options.producerId && streamMeta.closedBy.epoch === options.producerEpoch && streamMeta.closedBy.seq === options.producerSeq) return {
				message: null,
				streamClosed: true,
				producerResult: {
					status: `duplicate`,
					lastSeq: options.producerSeq
				}
			};
			return {
				message: null,
				streamClosed: true
			};
		}
		if (options.contentType && streamMeta.contentType) {
			const providedType = normalizeContentType(options.contentType);
			const streamType = normalizeContentType(streamMeta.contentType);
			if (providedType !== streamType) throw new Error(`Content-type mismatch: expected ${streamMeta.contentType}, got ${options.contentType}`);
		}
		let producerResult;
		if (options.producerId !== void 0 && options.producerEpoch !== void 0 && options.producerSeq !== void 0) {
			producerResult = this.validateProducer(streamMeta, options.producerId, options.producerEpoch, options.producerSeq);
			if (producerResult.status !== `accepted`) return {
				message: null,
				producerResult
			};
		}
		if (options.seq !== void 0) {
			if (streamMeta.lastSeq !== void 0 && options.seq <= streamMeta.lastSeq) throw new Error(`Sequence conflict: ${options.seq} <= ${streamMeta.lastSeq}`);
		}
		let processedData = data;
		if (normalizeContentType(streamMeta.contentType) === `application/json`) {
			processedData = processJsonAppend(data, options.isInitialCreate ?? false);
			if (processedData.length === 0) return null;
		}
		const parts = streamMeta.currentOffset.split(`_`).map(Number);
		const readSeq = parts[0];
		const byteOffset = parts[1];
		const FRAME_OVERHEAD = 5;
		const newByteOffset = byteOffset + FRAME_OVERHEAD + processedData.length;
		const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`;
		const segmentPath = segmentFile(this.dataDir, streamMeta.directoryName);
		const tAppendStart = performance.now();
		const stream = this.fileHandlePool.getWriteStream(segmentPath);
		const lengthBuf = Buffer.allocUnsafe(4);
		lengthBuf.writeUInt32BE(processedData.length, 0);
		const frameBuf = Buffer.concat([
			lengthBuf,
			processedData,
			Buffer.from(`\n`)
		]);
		await new Promise((resolve, reject) => {
			stream.write(frameBuf, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		const tAfterWrite = performance.now();
		const message = {
			data: processedData,
			offset: newOffset,
			timestamp: Date.now()
		};
		await this.fileHandlePool.fsyncFile(segmentPath);
		const tAfterFsync = performance.now();
		const updatedProducers = { ...streamMeta.producers };
		if (producerResult && producerResult.status === `accepted`) updatedProducers[producerResult.producerId] = producerResult.proposedState;
		let closedBy = void 0;
		if (options.close && options.producerId) closedBy = {
			producerId: options.producerId,
			epoch: options.producerEpoch,
			seq: options.producerSeq
		};
		const updatedMeta = {
			...streamMeta,
			currentOffset: newOffset,
			lastSeq: options.seq ?? streamMeta.lastSeq,
			totalBytes: streamMeta.totalBytes + processedData.length + 5,
			producers: updatedProducers,
			closed: options.close ? true : streamMeta.closed,
			closedBy: closedBy ?? streamMeta.closedBy
		};
		const key = `stream:${streamPath}`;
		await this.db.put(key, updatedMeta);
		const tAfterLmdb = performance.now();
		const appendTotal = tAfterLmdb - tAppendStart;
		if (appendTotal > 50) serverLog.event({
			event: `store.append`,
			path: streamPath,
			totalMs: +appendTotal.toFixed(2),
			writeMs: +(tAfterWrite - tAppendStart).toFixed(2),
			fsyncMs: +(tAfterFsync - tAfterWrite).toFixed(2),
			lmdbMs: +(tAfterLmdb - tAfterFsync).toFixed(2),
			bytes: processedData.length,
			isInitial: options.isInitialCreate ?? false
		}, `store.append slow`);
		this.notifyLongPolls(streamPath);
		if (options.close) this.notifyLongPollsClosed(streamPath);
		if (producerResult || options.close) return {
			message,
			producerResult,
			streamClosed: options.close
		};
		return message;
	}
	/**
	* Append with producer serialization for concurrent request handling.
	* This ensures that validation+append is atomic per producer.
	*/
	async appendWithProducer(streamPath, data, options) {
		if (!options.producerId) {
			const result = await this.append(streamPath, data, options);
			if (result && `message` in result) return result;
			return { message: result };
		}
		const releaseLock = await this.acquireProducerLock(streamPath, options.producerId);
		try {
			const result = await this.append(streamPath, data, options);
			if (result && `message` in result) return result;
			return { message: result };
		} finally {
			releaseLock();
		}
	}
	/**
	* Close a stream without appending data.
	* @returns The final offset, or null if stream doesn't exist
	*/
	closeStream(streamPath) {
		const streamMeta = this.getMetaIfNotExpired(streamPath);
		if (!streamMeta) return null;
		const alreadyClosed = streamMeta.closed ?? false;
		const key = `stream:${streamPath}`;
		const updatedMeta = {
			...streamMeta,
			closed: true
		};
		this.db.putSync(key, updatedMeta);
		this.notifyLongPollsClosed(streamPath);
		return {
			finalOffset: streamMeta.currentOffset,
			alreadyClosed
		};
	}
	/**
	* Close a stream with producer headers for idempotent close-only operations.
	* Participates in producer sequencing for deduplication.
	* @returns The final offset and producer result, or null if stream doesn't exist
	*/
	async closeStreamWithProducer(streamPath, options) {
		const releaseLock = await this.acquireProducerLock(streamPath, options.producerId);
		try {
			const streamMeta = this.getMetaIfNotExpired(streamPath);
			if (!streamMeta) return null;
			if (streamMeta.closed) {
				if (streamMeta.closedBy && streamMeta.closedBy.producerId === options.producerId && streamMeta.closedBy.epoch === options.producerEpoch && streamMeta.closedBy.seq === options.producerSeq) return {
					finalOffset: streamMeta.currentOffset,
					alreadyClosed: true,
					producerResult: {
						status: `duplicate`,
						lastSeq: options.producerSeq
					}
				};
				return {
					finalOffset: streamMeta.currentOffset,
					alreadyClosed: true,
					producerResult: { status: `stream_closed` }
				};
			}
			const producerResult = this.validateProducer(streamMeta, options.producerId, options.producerEpoch, options.producerSeq);
			if (producerResult.status !== `accepted`) return {
				finalOffset: streamMeta.currentOffset,
				alreadyClosed: streamMeta.closed ?? false,
				producerResult
			};
			const key = `stream:${streamPath}`;
			const updatedProducers = { ...streamMeta.producers };
			updatedProducers[producerResult.producerId] = producerResult.proposedState;
			const updatedMeta = {
				...streamMeta,
				closed: true,
				closedBy: {
					producerId: options.producerId,
					epoch: options.producerEpoch,
					seq: options.producerSeq
				},
				producers: updatedProducers
			};
			await this.db.put(key, updatedMeta);
			this.notifyLongPollsClosed(streamPath);
			return {
				finalOffset: streamMeta.currentOffset,
				alreadyClosed: false,
				producerResult
			};
		} finally {
			releaseLock();
		}
	}
	/**
	* Read messages from a specific segment file.
	* @param segmentPath - Path to the segment file
	* @param startByte - Start byte offset (skip messages at or before this offset)
	* @param baseByteOffset - Base byte offset to add to physical offsets (for fork stitching)
	* @param capByte - Optional cap: stop reading when logical offset exceeds this value
	* @returns Array of messages with properly computed offsets
	*/
	readMessagesFromSegmentFile(segmentPath, startByte, baseByteOffset, capByte) {
		const messages = [];
		if (!node_fs.existsSync(segmentPath)) return messages;
		try {
			const fileContent = node_fs.readFileSync(segmentPath);
			let filePos = 0;
			let physicalDataOffset = 0;
			while (filePos < fileContent.length) {
				if (filePos + 4 > fileContent.length) break;
				const messageLength = fileContent.readUInt32BE(filePos);
				filePos += 4;
				if (filePos + messageLength > fileContent.length) break;
				const messageData = fileContent.subarray(filePos, filePos + messageLength);
				filePos += messageLength;
				filePos += 1;
				physicalDataOffset += messageLength + 5;
				const logicalOffset = baseByteOffset + physicalDataOffset;
				if (capByte !== void 0 && logicalOffset > capByte) break;
				if (logicalOffset > startByte) messages.push({
					data: new Uint8Array(messageData),
					offset: `${String(0).padStart(16, `0`)}_${String(logicalOffset).padStart(16, `0`)}`,
					timestamp: 0
				});
			}
		} catch (err) {
			serverLog.error(`[FileBackedStreamStore] Error reading segment file:`, err);
		}
		return messages;
	}
	/**
	* Recursively read messages from a fork's source chain.
	* Reads from source (and its sources if also forked), capped at capByte.
	* Does NOT check softDeleted -- forks must read through soft-deleted sources.
	*/
	readForkedMessages(sourcePath, startByte, capByte) {
		const sourceKey = `stream:${sourcePath}`;
		const sourceMeta = this.db.get(sourceKey);
		if (!sourceMeta) return [];
		const messages = [];
		if (sourceMeta.forkedFrom && sourceMeta.forkOffset) {
			const sourceForkByte = Number(sourceMeta.forkOffset.split(`_`)[1] ?? 0);
			if (startByte < sourceForkByte) {
				const inheritedCap = Math.min(sourceForkByte, capByte);
				const inherited = this.readForkedMessages(sourceMeta.forkedFrom, startByte, inheritedCap);
				messages.push(...inherited);
			}
		}
		const segmentPath = segmentFile(this.dataDir, sourceMeta.directoryName);
		const sourceBaseByte = sourceMeta.forkOffset ? Number(sourceMeta.forkOffset.split(`_`)[1] ?? 0) : 0;
		const ownMessages = this.readMessagesFromSegmentFile(segmentPath, startByte, sourceBaseByte, capByte);
		messages.push(...ownMessages);
		return messages;
	}
	/**
	* Resolve a fork sub-offset against the source: read the message that
	* starts at forkOffset and return prefix bytes to materialize as the
	* fork's first own message. For JSON, parses comma-joined values.
	*/
	resolveForkSubOffset(sourcePath, forkOffset, subOffset, isJSON) {
		const forkByte = Number(forkOffset.split(`_`)[1] ?? 0);
		const sourceMeta = this.db.get(`stream:${sourcePath}`);
		if (!sourceMeta) throw new Error(`Source stream not found: ${sourcePath}`);
		const currentByte = Number(sourceMeta.currentOffset.split(`_`)[1] ?? 0);
		const messages = this.readForkedMessages(sourcePath, forkByte, currentByte);
		if (messages.length === 0) throw new Error(`Invalid fork sub-offset: no data past forkOffset`);
		const first = messages[0];
		if (isJSON) {
			const text = new TextDecoder().decode(first.data);
			const trimmed = text.endsWith(`,`) ? text.slice(0, -1) : text;
			let values;
			try {
				values = JSON.parse(`[${trimmed}]`);
			} catch {
				throw new Error(`Invalid fork sub-offset: source JSON is unparseable`);
			}
			if (subOffset > values.length) throw new Error(`Invalid fork sub-offset: overshoots source message count`);
			const prefix = values.slice(0, subOffset).map((v) => JSON.stringify(v));
			return new TextEncoder().encode(prefix.join(`,`) + `,`);
		}
		if (subOffset > first.data.length) throw new Error(`Invalid fork sub-offset: overshoots source message length`);
		return first.data.slice(0, subOffset);
	}
	read(streamPath, offset) {
		const streamMeta = this.getMetaIfNotExpired(streamPath);
		if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`);
		const startOffset = offset ?? `0000000000000000_0000000000000000`;
		const startByte = Number(startOffset.split(`_`)[1] ?? 0);
		const currentByte = Number(streamMeta.currentOffset.split(`_`)[1] ?? 0);
		if (streamMeta.currentOffset === `0000000000000000_0000000000000000`) return {
			messages: [],
			upToDate: true
		};
		if (startByte >= currentByte) return {
			messages: [],
			upToDate: true
		};
		const messages = [];
		if (streamMeta.forkedFrom && streamMeta.forkOffset) {
			const forkByte = Number(streamMeta.forkOffset.split(`_`)[1] ?? 0);
			if (startByte < forkByte) {
				const inherited = this.readForkedMessages(streamMeta.forkedFrom, startByte, forkByte);
				messages.push(...inherited);
			}
			const segmentPath = segmentFile(this.dataDir, streamMeta.directoryName);
			const ownMessages = this.readMessagesFromSegmentFile(segmentPath, startByte, forkByte);
			messages.push(...ownMessages);
		} else {
			const segmentPath = segmentFile(this.dataDir, streamMeta.directoryName);
			const ownMessages = this.readMessagesFromSegmentFile(segmentPath, startByte, 0);
			messages.push(...ownMessages);
		}
		return {
			messages,
			upToDate: true
		};
	}
	async waitForMessages(streamPath, offset, timeoutMs) {
		const streamMeta = this.getMetaIfNotExpired(streamPath);
		if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`);
		if (streamMeta.forkedFrom && streamMeta.forkOffset && offset < streamMeta.forkOffset) {
			const { messages: messages$1 } = this.read(streamPath, offset);
			return {
				messages: messages$1,
				timedOut: false
			};
		}
		if (streamMeta.closed && offset === streamMeta.currentOffset) return {
			messages: [],
			timedOut: false,
			streamClosed: true
		};
		const { messages } = this.read(streamPath, offset);
		if (messages.length > 0) return {
			messages,
			timedOut: false,
			streamClosed: streamMeta.closed
		};
		if (streamMeta.closed) return {
			messages: [],
			timedOut: false,
			streamClosed: true
		};
		return new Promise((resolve) => {
			const timeoutId = setTimeout(() => {
				this.removePendingLongPoll(pending);
				const currentMeta = this.getMetaIfNotExpired(streamPath);
				resolve({
					messages: [],
					timedOut: true,
					streamClosed: currentMeta?.closed
				});
			}, timeoutMs);
			const pending = {
				path: streamPath,
				offset,
				resolve: (msgs) => {
					clearTimeout(timeoutId);
					this.removePendingLongPoll(pending);
					const currentMeta = this.getMetaIfNotExpired(streamPath);
					resolve({
						messages: msgs,
						timedOut: false,
						streamClosed: currentMeta?.closed
					});
				},
				timeoutId
			};
			this.pendingLongPolls.push(pending);
		});
	}
	/**
	* Format messages for response.
	* For JSON mode, wraps concatenated data in array brackets.
	* @throws Error if stream doesn't exist or is expired
	*/
	formatResponse(streamPath, messages) {
		const streamMeta = this.getMetaIfNotExpired(streamPath);
		if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`);
		if (normalizeContentType(streamMeta.contentType) === `application/json`) return formatJsonMessages(messages);
		const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0);
		const concatenated = new Uint8Array(totalSize);
		let offset = 0;
		for (const msg of messages) {
			concatenated.set(msg.data, offset);
			offset += msg.data.length;
		}
		return concatenated;
	}
	getCurrentOffset(streamPath) {
		const streamMeta = this.getMetaIfNotExpired(streamPath);
		return streamMeta?.currentOffset;
	}
	clear() {
		for (const pending of this.pendingLongPolls) {
			clearTimeout(pending.timeoutId);
			pending.resolve([]);
		}
		this.pendingLongPolls = [];
		const range = this.db.getRange({
			start: `stream:`,
			end: `stream:\xFF`
		});
		const entries = Array.from(range);
		for (const { key } of entries) this.db.removeSync(key);
		this.fileHandlePool.closeAll().catch((err) => {
			serverLog.error(`[FileBackedStreamStore] Error closing handles:`, err);
		});
	}
	/**
	* Cancel all pending long-polls (used during shutdown).
	*/
	cancelAllWaits() {
		for (const pending of this.pendingLongPolls) {
			clearTimeout(pending.timeoutId);
			pending.resolve([]);
		}
		this.pendingLongPolls = [];
	}
	list() {
		const paths = [];
		const range = this.db.getRange({
			start: `stream:`,
			end: `stream:\xFF`
		});
		const entries = Array.from(range);
		for (const { key } of entries) if (typeof key === `string`) paths.push(key.replace(`stream:`, ``));
		return paths;
	}
	notifyLongPolls(streamPath) {
		const toNotify = this.pendingLongPolls.filter((p) => p.path === streamPath);
		for (const pending of toNotify) {
			const { messages } = this.read(streamPath, pending.offset);
			if (messages.length > 0) pending.resolve(messages);
		}
	}
	/**
	* Notify pending long-polls that a stream has been closed.
	* They should wake up immediately and return Stream-Closed: true.
	*/
	notifyLongPollsClosed(streamPath) {
		const toNotify = this.pendingLongPolls.filter((p) => p.path === streamPath);
		for (const pending of toNotify) pending.resolve([]);
	}
	cancelLongPollsForStream(streamPath) {
		const toCancel = this.pendingLongPolls.filter((p) => p.path === streamPath);
		for (const pending of toCancel) {
			clearTimeout(pending.timeoutId);
			pending.resolve([]);
		}
		this.pendingLongPolls = this.pendingLongPolls.filter((p) => p.path !== streamPath);
	}
	removePendingLongPoll(pending) {
		const index = this.pendingLongPolls.indexOf(pending);
		if (index !== -1) this.pendingLongPolls.splice(index, 1);
	}
};

//#endregion
//#region src/cursor.ts
/**
* Stream cursor calculation for CDN cache collapsing.
*
* This module implements interval-based cursor generation to prevent
* infinite CDN cache loops while enabling request collapsing.
*
* The mechanism works by:
* 1. Dividing time into fixed intervals (default 20 seconds)
* 2. Computing interval number from an epoch (October 9, 2024)
* 3. Returning cursor values that change at interval boundaries
* 4. Ensuring monotonic cursor progression (never going backwards)
*/
/**
* Default epoch for cursor calculation: October 9, 2024 00:00:00 UTC.
* This is the reference point from which intervals are counted.
* Using a past date ensures cursors are always positive.
*/
const DEFAULT_CURSOR_EPOCH = new Date(`2024-10-09T00:00:00.000Z`);
/**
* Default interval duration in seconds.
*/
const DEFAULT_CURSOR_INTERVAL_SECONDS = 20;
/**
* Maximum jitter in seconds to add on collision.
* Per protocol spec: random value between 1-3600 seconds.
*/
const MAX_JITTER_SECONDS = 3600;
/**
* Minimum jitter in seconds.
*/
const MIN_JITTER_SECONDS = 1;
/**
* Calculate the current cursor value based on time intervals.
*
* @param options - Configuration for cursor calculation
* @returns The current cursor value as a string
*/
function calculateCursor(options = {}) {
	const intervalSeconds = options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS;
	const epoch = options.epoch ?? DEFAULT_CURSOR_EPOCH;
	const now = Date.now();
	const epochMs = epoch.getTime();
	const intervalMs = intervalSeconds * 1e3;
	const intervalNumber = Math.floor((now - epochMs) / intervalMs);
	return String(intervalNumber);
}
/**
* Generate a random jitter value in intervals.
*
* @param intervalSeconds - The interval duration in seconds
* @returns Number of intervals to add as jitter
*/
function generateJitterIntervals(intervalSeconds) {
	const jitterSeconds = MIN_JITTER_SECONDS + Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1));
	return Math.max(1, Math.ceil(jitterSeconds / intervalSeconds));
}
/**
* Generate a cursor for a response, ensuring monotonic progression.
*
* This function ensures the returned cursor is always greater than or equal
* to the current time interval, and strictly greater than any client-provided
* cursor. This prevents cache loops where a client could cycle between
* cursor values.
*
* Algorithm:
* - If no client cursor: return current interval
* - If client cursor < current interval: return current interval
* - If client cursor >= current interval: return client cursor + jitter
*
* This guarantees monotonic cursor progression and prevents A→B→A cycles.
*
* @param clientCursor - The cursor provided by the client (if any)
* @param options - Configuration for cursor calculation
* @returns The cursor value to include in the response
*/
function generateResponseCursor(clientCursor, options = {}) {
	const intervalSeconds = options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS;
	const currentCursor = calculateCursor(options);
	const currentInterval = parseInt(currentCursor, 10);
	if (!clientCursor) return currentCursor;
	const clientInterval = parseInt(clientCursor, 10);
	if (isNaN(clientInterval) || clientInterval < currentInterval) return currentCursor;
	const jitterIntervals = generateJitterIntervals(intervalSeconds);
	return String(clientInterval + jitterIntervals);
}
/**
* Handle cursor collision by adding random jitter.
*
* @deprecated Use generateResponseCursor instead, which handles all cases
* including monotonicity guarantees.
*
* @param currentCursor - The newly calculated cursor value
* @param previousCursor - The cursor provided by the client (if any)
* @param options - Configuration for cursor calculation
* @returns The cursor value to return, with jitter applied if there's a collision
*/
function handleCursorCollision(currentCursor, previousCursor, options = {}) {
	return generateResponseCursor(previousCursor, options);
}

//#endregion
//#region src/glob.ts
/**
* Glob pattern matching for webhook subscription patterns.
*
* Supports:
* - `*` matches exactly one path segment
* - `**` matches zero or more path segments (recursive)
* - Literal segments match exactly
*/
/**
* Match a stream path against a glob pattern.
*/
function globMatch(pattern, path) {
	const patternParts = splitPath(pattern);
	const pathParts = splitPath(path);
	return matchParts(patternParts, 0, pathParts, 0);
}
function splitPath(p) {
	return p.replace(/^\/+/, ``).replace(/\/+$/, ``).split(`/`).filter((s) => s.length > 0);
}
function matchParts(pattern, pi, path, si) {
	while (pi < pattern.length && si < path.length) {
		const seg = pattern[pi];
		if (seg === `**`) {
			for (let i = si; i <= path.length; i++) if (matchParts(pattern, pi + 1, path, i)) return true;
			return false;
		}
		if (seg === `*`) {
			pi++;
			si++;
			continue;
		}
		const decodedSeg = seg.replace(/%2[Aa]/g, `*`);
		if (decodedSeg !== path[si]) return false;
		pi++;
		si++;
	}
	while (pi < pattern.length && pattern[pi] === `**`) pi++;
	return pi === pattern.length && si === path.length;
}

//#endregion
//#region src/consumer-store.ts
const DEFAULT_LEASE_TTL_MS$1 = 6e4;
const INITIAL_CONSUMER_OFFSET = `-1`;
/**
* Compare two offsets. Offsets are fixed-width, zero-padded strings
* (e.g., "0000000000000001_0000000000000001") that are lexicographically
* orderable. This is guaranteed by the server's offset generation
* (see PROTOCOL.md § Offsets). Returns negative if a < b, 0 if equal,
* positive if a > b.
*/
function compareOffsets$1(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
var ConsumerStore = class {
	consumers = new Map();
	streamConsumers = new Map();
	/**
	* Register a new consumer. Idempotent if config matches.
	*/
	registerConsumer(consumerId, streams, getTailOffset, opts) {
		const existing = this.consumers.get(consumerId);
		if (existing) {
			const existingPaths = Array.from(existing.streams.keys()).sort();
			const newPaths = [...streams].sort();
			const configMatch = existingPaths.length === newPaths.length && existingPaths.every((p, i) => p === newPaths[i]) && existing.namespace === (opts?.namespace ?? null) && existing.lease_ttl_ms === (opts?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS$1);
			if (!configMatch) return { error: `CONFIG_MISMATCH` };
			return {
				consumer: existing,
				created: false
			};
		}
		const streamMap = new Map();
		for (const path of streams) streamMap.set(path, INITIAL_CONSUMER_OFFSET);
		const consumer = {
			consumer_id: consumerId,
			state: `REGISTERED`,
			epoch: 0,
			token: null,
			streams: streamMap,
			namespace: opts?.namespace ?? null,
			lease_ttl_ms: opts?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS$1,
			last_ack_at: 0,
			lease_timer: null,
			created_at: Date.now(),
			wake_preference: { type: `none` },
			holder_id: null
		};
		this.consumers.set(consumerId, consumer);
		for (const path of streams) this.addStreamIndex(path, consumerId);
		return {
			consumer,
			created: true
		};
	}
	getConsumer(consumerId) {
		return this.consumers.get(consumerId);
	}
	removeConsumer(consumerId) {
		const consumer = this.consumers.get(consumerId);
		if (!consumer) return false;
		if (consumer.lease_timer) clearTimeout(consumer.lease_timer);
		for (const path of consumer.streams.keys()) this.removeStreamIndex(path, consumerId);
		this.consumers.delete(consumerId);
		return true;
	}
	/**
	* Acquire epoch for a consumer. Increments epoch and transitions to READING.
	* If already READING, this is a self-supersede (crash recovery) — epoch
	* increments and old token is invalidated.
	* Returns null if consumer doesn't exist.
	* NOTE: Single-process reference server has no contention check (EPOCH_HELD). Self-supersede always
	* succeeds. Multi-server contention is a future concern.
	*/
	acquireEpoch(consumerId) {
		const consumer = this.consumers.get(consumerId);
		if (!consumer) return null;
		consumer.epoch++;
		const prevState = consumer.state;
		consumer.state = `READING`;
		consumer.last_ack_at = Date.now();
		return {
			epoch: consumer.epoch,
			prevState
		};
	}
	/**
	* Release epoch. Transitions consumer from READING to REGISTERED.
	*/
	releaseEpoch(consumerId) {
		const consumer = this.consumers.get(consumerId);
		if (!consumer || consumer.state !== `READING`) return false;
		consumer.state = `REGISTERED`;
		consumer.token = null;
		consumer.holder_id = null;
		if (consumer.lease_timer) {
			clearTimeout(consumer.lease_timer);
			consumer.lease_timer = null;
		}
		return true;
	}
	/**
	* Update acked offsets. Returns error info if offset regresses or is invalid.
	*/
	updateOffsets(consumer, offsets, getTailOffset) {
		for (const { path, offset } of offsets) {
			const current = consumer.streams.get(path);
			if (current === void 0) return {
				path,
				code: `UNKNOWN_STREAM`
			};
			if (offset === `-1`) return {
				path,
				code: `INVALID_OFFSET`
			};
			if (compareOffsets$1(offset, current) < 0) return {
				path,
				code: `OFFSET_REGRESSION`
			};
			const tail = getTailOffset(path);
			if (compareOffsets$1(offset, tail) > 0) return {
				path,
				code: `INVALID_OFFSET`
			};
		}
		for (const { path, offset } of offsets) if (consumer.streams.has(path)) consumer.streams.set(path, offset);
		consumer.last_ack_at = Date.now();
		return null;
	}
	/**
	* Add streams to a consumer's subscription.
	*/
	addStreams(consumer, paths, getTailOffset) {
		for (const path of paths) if (!consumer.streams.has(path)) {
			consumer.streams.set(path, getTailOffset(path));
			this.addStreamIndex(path, consumer.consumer_id);
		}
	}
	/**
	* Remove streams from a consumer. Returns true if consumer has no streams left.
	*/
	removeStreams(consumer, paths) {
		for (const path of paths) {
			consumer.streams.delete(path);
			this.removeStreamIndex(path, consumer.consumer_id);
		}
		return consumer.streams.size === 0;
	}
	/**
	* Get consumer IDs subscribed to a stream.
	*/
	getConsumersForStream(streamPath) {
		const set = this.streamConsumers.get(streamPath);
		return set ? Array.from(set) : [];
	}
	/**
	* Find consumers matching a stream path via namespace globs.
	*/
	findConsumersMatchingStream(streamPath) {
		return Array.from(this.consumers.values()).filter((c) => c.namespace && globMatch(c.namespace, streamPath));
	}
	/**
	* Get streams data for API responses.
	*/
	getStreamsData(consumer) {
		return Array.from(consumer.streams, ([path, offset]) => ({
			path,
			offset
		}));
	}
	/**
	* Check if consumer has pending work.
	*/
	hasPendingWork(consumer, getTailOffset) {
		for (const [path, ackedOffset] of consumer.streams) {
			const tail = getTailOffset(path);
			if (compareOffsets$1(tail, ackedOffset) > 0) return true;
		}
		return false;
	}
	/**
	* Remove a stream from all consumers. Returns IDs of consumers with no streams left.
	*/
	removeStreamFromAllConsumers(streamPath) {
		const consumerIds = this.getConsumersForStream(streamPath);
		const empty = [];
		for (const cid of consumerIds) {
			const consumer = this.consumers.get(cid);
			if (!consumer) continue;
			consumer.streams.delete(streamPath);
			if (consumer.streams.size === 0) empty.push(cid);
		}
		this.streamConsumers.delete(streamPath);
		return empty;
	}
	/**
	* Get all consumers (for shutdown).
	*/
	getAllConsumers() {
		return this.consumers.values();
	}
	/**
	* Shut down: clear all timers and state.
	*/
	shutdown() {
		for (const consumer of this.consumers.values()) if (consumer.lease_timer) clearTimeout(consumer.lease_timer);
		this.consumers.clear();
		this.streamConsumers.clear();
	}
	addStreamIndex(streamPath, consumerId) {
		let set = this.streamConsumers.get(streamPath);
		if (!set) {
			set = new Set();
			this.streamConsumers.set(streamPath, set);
		}
		set.add(consumerId);
	}
	removeStreamIndex(streamPath, consumerId) {
		const set = this.streamConsumers.get(streamPath);
		if (set) {
			set.delete(consumerId);
			if (set.size === 0) this.streamConsumers.delete(streamPath);
		}
	}
};

//#endregion
//#region src/crypto.ts
/**
* Generate a webhook secret for a subscription.
*/
function generateWebhookSecret() {
	return `whsec_${(0, node_crypto.randomBytes)(32).toString(`hex`)}`;
}
/**
* Generate a unique wake ID.
*/
function generateWakeId() {
	return `w_${(0, node_crypto.randomBytes)(12).toString(`hex`)}`;
}
const WEBHOOK_KEYPAIR = (0, node_crypto.generateKeyPairSync)(`ed25519`);
const WEBHOOK_PUBLIC_JWK = buildWebhookPublicJwk();
function buildWebhookPublicJwk() {
	const exported = WEBHOOK_KEYPAIR.publicKey.export({ format: `jwk` });
	if (exported.kty !== `OKP` || exported.crv !== `Ed25519` || !exported.x) throw new Error(`Failed to export Ed25519 webhook signing key`);
	const thumbprintInput = JSON.stringify({
		crv: exported.crv,
		kty: exported.kty,
		x: exported.x
	});
	const kid = `ds_${(0, node_crypto.createHash)(`sha256`).update(thumbprintInput).digest(`base64url`)}`;
	return {
		kty: `OKP`,
		crv: `Ed25519`,
		x: exported.x,
		kid,
		use: `sig`,
		alg: `EdDSA`
	};
}
function getWebhookSigningKeyId() {
	return WEBHOOK_PUBLIC_JWK.kid;
}
function getWebhookJwks() {
	return { keys: [{ ...WEBHOOK_PUBLIC_JWK }] };
}
function signWebhookPayload(body, secret) {
	const timestamp = Math.floor(Date.now() / 1e3);
	const payload = `${timestamp}.${body}`;
	if (secret) {
		const signature$1 = (0, node_crypto.createHmac)(`sha256`, secret).update(payload).digest(`hex`);
		return `t=${timestamp},sha256=${signature$1}`;
	}
	const signature = (0, node_crypto.sign)(null, Buffer.from(payload), WEBHOOK_KEYPAIR.privateKey).toString(`base64url`);
	return `t=${timestamp},kid=${WEBHOOK_PUBLIC_JWK.kid},ed25519=${signature}`;
}
const TOKEN_KEY = (0, node_crypto.randomBytes)(32);
/**
* Generate a signed callback token.
* Token format: base64url(json_payload).base64url(hmac_signature)
* Payload: { consumer_id, epoch, exp }
*/
function generateCallbackToken(consumerId, epoch) {
	const payload = {
		sub: consumerId,
		epoch,
		exp: Math.floor(Date.now() / 1e3) + 3600,
		jti: (0, node_crypto.randomBytes)(8).toString(`hex`)
	};
	const payloadStr = Buffer.from(JSON.stringify(payload)).toString(`base64url`);
	const sig = (0, node_crypto.createHmac)(`sha256`, TOKEN_KEY).update(payloadStr).digest(`base64url`);
	return `${payloadStr}.${sig}`;
}
/** Seconds before expiry at which a token should be refreshed. */
const TOKEN_REFRESH_THRESHOLD = 300;
/**
* Validate a callback token. Returns the decoded payload or null.
* On success, includes `exp` (unix seconds) so callers can decide
* whether the token needs refreshing.
*/
function validateCallbackToken(token, consumerId) {
	const parts = token.split(`.`);
	if (parts.length !== 2) return {
		valid: false,
		code: `TOKEN_INVALID`
	};
	const [payloadStr, sig] = parts;
	const expectedSig = (0, node_crypto.createHmac)(`sha256`, TOKEN_KEY).update(payloadStr).digest(`base64url`);
	try {
		if (!(0, node_crypto.timingSafeEqual)(Buffer.from(sig), Buffer.from(expectedSig))) return {
			valid: false,
			code: `TOKEN_INVALID`
		};
	} catch {
		return {
			valid: false,
			code: `TOKEN_INVALID`
		};
	}
	let payload;
	try {
		payload = JSON.parse(Buffer.from(payloadStr, `base64url`).toString());
	} catch {
		return {
			valid: false,
			code: `TOKEN_INVALID`
		};
	}
	if (payload.sub !== consumerId) return {
		valid: false,
		code: `TOKEN_INVALID`
	};
	const now = Math.floor(Date.now() / 1e3);
	if (now > payload.exp) return {
		valid: false,
		code: `TOKEN_EXPIRED`
	};
	return {
		valid: true,
		exp: payload.exp,
		epoch: payload.epoch
	};
}
/**
* Check whether a token is close enough to expiry that it should be refreshed.
*/
function tokenNeedsRefresh(exp) {
	const now = Math.floor(Date.now() / 1e3);
	return exp - now <= TOKEN_REFRESH_THRESHOLD;
}

//#endregion
//#region src/consumer-manager.ts
var ConsumerManager = class {
	store;
	getTailOffset;
	isShuttingDown = false;
	/**
	* Callbacks invoked when a consumer's lease expires.
	* L2 layers register here to react (e.g., webhook re-wake).
	*/
	leaseExpiredCallbacks = [];
	onLeaseExpired(cb) {
		this.leaseExpiredCallbacks.push(cb);
	}
	/**
	* Callbacks invoked when a consumer is deleted.
	* L2 layers register here to clean up associated state
	* (e.g., remove WebhookConsumer records, cancel retry timers).
	*/
	consumerDeletedCallbacks = [];
	onConsumerDeleted(cb) {
		this.consumerDeletedCallbacks.push(cb);
	}
	/**
	* Callbacks invoked when a consumer's epoch is acquired.
	* L2 layers register here to track claims (e.g., pull-wake writes "claimed" events).
	*
	* Critical callbacks run first — if any throw, the acquire is rolled back
	* and returned as an error. Non-critical callbacks are swallowed with a log.
	*/
	epochAcquiredCallbacks = [];
	criticalEpochAcquiredCallbacks = [];
	onEpochAcquired(cb) {
		this.epochAcquiredCallbacks.push(cb);
	}
	onEpochAcquiredCritical(cb) {
		this.criticalEpochAcquiredCallbacks.push(cb);
	}
	/**
	* Callbacks invoked when a consumer's epoch is released.
	* L2 layers register here to react (e.g., pull-wake re-wake if pending work).
	*/
	epochReleasedCallbacks = [];
	onEpochReleased(cb) {
		this.epochReleasedCallbacks.push(cb);
	}
	constructor(opts) {
		this.store = new ConsumerStore();
		this.getTailOffset = opts.getTailOffset;
	}
	registerConsumer(consumerId, streams, opts) {
		return this.store.registerConsumer(consumerId, streams, this.getTailOffset, opts);
	}
	deleteConsumer(consumerId) {
		const removed = this.store.removeConsumer(consumerId);
		if (removed) for (const cb of this.consumerDeletedCallbacks) try {
			cb(consumerId);
		} catch (err) {
			serverLog.error(`[consumer-manager] consumerDeleted callback failed:`, err);
		}
		return removed;
	}
	getConsumer(consumerId) {
		const consumer = this.store.getConsumer(consumerId);
		if (!consumer) return null;
		return {
			consumer_id: consumer.consumer_id,
			state: consumer.state,
			epoch: consumer.epoch,
			streams: this.store.getStreamsData(consumer),
			namespace: consumer.namespace,
			lease_ttl_ms: consumer.lease_ttl_ms,
			wake_preference: consumer.wake_preference
		};
	}
	/**
	* Set the wake preference for a consumer.
	* Used by L2 layers to configure how the consumer is notified of new work.
	*/
	setWakePreference(consumerId, preference) {
		const consumer = this.store.getConsumer(consumerId);
		if (!consumer) return null;
		consumer.wake_preference = preference;
		return consumer;
	}
	/**
	* Acquire epoch for a consumer. Returns token + stream offsets.
	* If already READING, this is a self-supersede (crash recovery).
	* Optional `worker` parameter enables contention tracking for pull-wake.
	*/
	acquire(consumerId, worker) {
		const consumer = this.store.getConsumer(consumerId);
		if (!consumer) return { error: {
			code: `CONSUMER_NOT_FOUND`,
			message: `Consumer '${consumerId}' does not exist`
		} };
		if (consumer.state === `READING` && worker && consumer.holder_id && consumer.holder_id !== worker) return { error: {
			code: `EPOCH_HELD`,
			message: `Consumer is currently held by another worker`,
			holder: `active`
		} };
		const result = this.store.acquireEpoch(consumerId);
		if (!result) return { error: {
			code: `CONSUMER_NOT_FOUND`,
			message: `Consumer '${consumerId}' does not exist`
		} };
		const token = generateCallbackToken(consumerId, result.epoch);
		consumer.token = token;
		consumer.holder_id = worker ?? null;
		this.resetLeaseTimer(consumer);
		for (const cb of this.criticalEpochAcquiredCallbacks) try {
			cb(consumerId, result.epoch, worker);
		} catch (err) {
			serverLog.error(`[consumer-manager] Critical epochAcquired callback failed, rolling back acquire:`, err);
			this.store.releaseEpoch(consumerId);
			return { error: {
				code: `INTERNAL_ERROR`,
				message: `L2 callback failed: ${err instanceof Error ? err.message : String(err)}`
			} };
		}
		for (const cb of this.epochAcquiredCallbacks) try {
			cb(consumerId, result.epoch, worker);
		} catch (err) {
			serverLog.error(`[consumer-manager] epochAcquired callback failed:`, err);
		}
		return {
			consumer_id: consumerId,
			epoch: result.epoch,
			token,
			streams: this.store.getStreamsData(consumer),
			worker
		};
	}
	/**
	* Process an ack request. Validates token, epoch, and offsets.
	* Empty offsets = heartbeat: resets lease timer, no durable cursor write.
	* Both empty and cursor-advancing acks reset last_ack_time (RFC § Liveness).
	*/
	ack(consumerId, token, request) {
		const consumer = this.store.getConsumer(consumerId);
		if (!consumer) return { error: {
			code: `CONSUMER_NOT_FOUND`,
			message: `Consumer '${consumerId}' does not exist`
		} };
		const tokenResult = validateCallbackToken(token, consumerId);
		if (!tokenResult.valid) {
			if (tokenResult.code === `TOKEN_EXPIRED`) return { error: {
				code: `TOKEN_EXPIRED`,
				message: `Bearer token has expired. Re-acquire the epoch to get a new token.`
			} };
			return { error: {
				code: `TOKEN_INVALID`,
				message: `Bearer token is malformed or signature invalid`
			} };
		}
		if (tokenResult.epoch !== consumer.epoch) return { error: {
			code: `STALE_EPOCH`,
			message: `Token epoch ${tokenResult.epoch} does not match current epoch ${consumer.epoch}`
		} };
		if (consumer.state !== `READING`) return { error: {
			code: `STALE_EPOCH`,
			message: `Consumer is not in READING state`
		} };
		if (request.offsets.length === 0) {
			consumer.last_ack_at = Date.now();
			this.resetLeaseTimer(consumer);
			const responseToken$1 = tokenNeedsRefresh(tokenResult.exp) ? generateCallbackToken(consumerId, consumer.epoch) : token;
			return {
				ok: true,
				token: responseToken$1
			};
		}
		const offsetError = this.store.updateOffsets(consumer, request.offsets, this.getTailOffset);
		if (offsetError) {
			let message;
			switch (offsetError.code) {
				case `OFFSET_REGRESSION`:
					message = `Ack offset is less than current cursor`;
					break;
				case `UNKNOWN_STREAM`:
					message = `Stream path is not registered for this consumer`;
					break;
				case `INVALID_OFFSET`:
					message = `Ack offset is invalid: it must not be -1 and cannot be beyond stream tail`;
					break;
			}
			return { error: {
				code: offsetError.code,
				message,
				path: offsetError.path
			} };
		}
		this.resetLeaseTimer(consumer);
		const responseToken = tokenNeedsRefresh(tokenResult.exp) ? generateCallbackToken(consumerId, consumer.epoch) : token;
		return {
			ok: true,
			token: responseToken
		};
	}
	release(consumerId, token) {
		const consumer = this.store.getConsumer(consumerId);
		if (!consumer) return { error: {
			code: `CONSUMER_NOT_FOUND`,
			message: `Consumer '${consumerId}' does not exist`
		} };
		const tokenResult = validateCallbackToken(token, consumerId);
		if (!tokenResult.valid) return { error: {
			code: tokenResult.code,
			message: tokenResult.code === `TOKEN_EXPIRED` ? `Bearer token has expired` : `Bearer token is malformed or signature invalid`
		} };
		if (tokenResult.epoch !== consumer.epoch) return { error: {
			code: `STALE_EPOCH`,
			message: `Token epoch ${tokenResult.epoch} does not match current epoch ${consumer.epoch}`
		} };
		if (consumer.state !== `READING`) return { error: {
			code: `STALE_EPOCH`,
			message: `Consumer is not in READING state`
		} };
		this.store.releaseEpoch(consumerId);
		for (const cb of this.epochReleasedCallbacks) try {
			cb(consumerId);
		} catch (err) {
			serverLog.error(`[consumer-manager] epochReleased callback failed:`, err);
		}
		return {
			ok: true,
			state: `REGISTERED`
		};
	}
	resetLeaseTimer(consumer) {
		if (consumer.lease_timer) clearTimeout(consumer.lease_timer);
		consumer.lease_timer = setTimeout(() => {
			consumer.lease_timer = null;
			if (consumer.state === `READING` && !this.isShuttingDown) {
				this.store.releaseEpoch(consumer.consumer_id);
				for (const cb of this.leaseExpiredCallbacks) try {
					cb(consumer);
				} catch (err) {
					serverLog.error(`[consumer-manager] leaseExpired callback failed:`, err);
				}
			}
		}, consumer.lease_ttl_ms);
	}
	/**
	* Expire a consumer's epoch. Public API for L2 to force-expire
	* (e.g., webhook delivery failures beyond threshold).
	*/
	expireConsumer(consumerId) {
		return this.store.releaseEpoch(consumerId);
	}
	/**
	* Called when a stream is deleted. Removes stream from all consumers.
	*/
	onStreamDeleted(streamPath) {
		const emptyConsumerIds = this.store.removeStreamFromAllConsumers(streamPath);
		for (const cid of emptyConsumerIds) this.deleteConsumer(cid);
	}
	hasPendingWork(consumerId) {
		const consumer = this.store.getConsumer(consumerId);
		if (!consumer) return false;
		return this.store.hasPendingWork(consumer, this.getTailOffset);
	}
	shutdown() {
		this.isShuttingDown = true;
		this.store.shutdown();
	}
};

//#endregion
//#region src/consumer-routes.ts
const ERROR_CODE_TO_STATUS$1 = {
	CONSUMER_NOT_FOUND: 404,
	CONSUMER_ALREADY_EXISTS: 409,
	EPOCH_HELD: 409,
	STALE_EPOCH: 409,
	TOKEN_EXPIRED: 401,
	TOKEN_INVALID: 401,
	OFFSET_REGRESSION: 409,
	INVALID_OFFSET: 409,
	UNKNOWN_STREAM: 400,
	INTERNAL_ERROR: 500
};
var ConsumerRoutes = class {
	manager;
	webhookManager;
	pullWakeManager;
	constructor(manager, opts) {
		this.manager = manager;
		this.webhookManager = opts?.webhookManager ?? null;
		this.pullWakeManager = opts?.pullWakeManager ?? null;
	}
	/**
	* Try to handle a request as a consumer route.
	* Returns true if handled, false to pass through.
	*/
	async handleRequest(method, path, req, res) {
		if (!path.startsWith(`/consumers`)) return false;
		if (path === `/consumers` && method === `POST`) {
			await this.handleRegister(req, res);
			return true;
		}
		const segments = path.slice(`/consumers/`.length).split(`/`);
		if (segments.length === 0 || !segments[0]) return false;
		const consumerId = decodeURIComponent(segments[0]);
		const action = segments[1];
		if (!action) {
			if (method === `GET`) {
				this.handleGet(consumerId, res);
				return true;
			}
			if (method === `DELETE`) {
				this.handleDelete(consumerId, res);
				return true;
			}
			return false;
		}
		if (segments.length === 2 && segments[1] === `wake` && method === `PUT`) {
			await this.handleSetWakePreference(consumerId, req, res);
			return true;
		}
		if (method !== `POST`) {
			res.writeHead(405, { "content-type": `text/plain` });
			res.end(`Method not allowed`);
			return true;
		}
		switch (action) {
			case `acquire`:
				await this.handleAcquire(consumerId, req, res);
				return true;
			case `ack`:
				await this.handleAck(consumerId, req, res);
				return true;
			case `release`:
				this.handleRelease(consumerId, req, res);
				return true;
			default: return false;
		}
	}
	async handleRegister(req, res) {
		const body = await this.readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body));
		} catch {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Invalid JSON body`
			} }));
			return;
		}
		if (typeof parsed !== `object` || parsed === null) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Invalid JSON body`
			} }));
			return;
		}
		const payload = parsed;
		if (typeof payload.consumer_id !== `string` || payload.consumer_id.length === 0) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Missing required field: consumer_id`
			} }));
			return;
		}
		if (payload.consumer_id.startsWith(`__wh__:`)) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `consumer_id must not start with reserved prefix '__wh__:'`
			} }));
			return;
		}
		if (!Array.isArray(payload.streams) || payload.streams.length === 0 || payload.streams.some((path) => typeof path !== `string` || path.length === 0)) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Missing required field: streams`
			} }));
			return;
		}
		if (payload.namespace !== void 0 && (typeof payload.namespace !== `string` || payload.namespace.length === 0)) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `namespace must be a non-empty string when provided`
			} }));
			return;
		}
		if (payload.lease_ttl_ms !== void 0 && (typeof payload.lease_ttl_ms !== `number` || !Number.isInteger(payload.lease_ttl_ms) || payload.lease_ttl_ms <= 0)) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `lease_ttl_ms must be a positive integer when provided`
			} }));
			return;
		}
		const namespace = typeof payload.namespace === `string` ? payload.namespace : void 0;
		const leaseTtlMs = typeof payload.lease_ttl_ms === `number` ? payload.lease_ttl_ms : void 0;
		const result = this.manager.registerConsumer(payload.consumer_id, payload.streams, {
			namespace,
			lease_ttl_ms: leaseTtlMs
		});
		if (`error` in result) {
			res.writeHead(409, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `CONSUMER_ALREADY_EXISTS`,
				message: `Consumer already exists with different configuration`
			} }));
			return;
		}
		const info = this.manager.getConsumer(result.consumer.consumer_id);
		res.writeHead(result.created ? 201 : 200, { "content-type": `application/json` });
		res.end(JSON.stringify(info));
	}
	handleGet(consumerId, res) {
		const info = this.manager.getConsumer(consumerId);
		if (!info) {
			res.writeHead(404, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `CONSUMER_NOT_FOUND`,
				message: `Consumer not found`
			} }));
			return;
		}
		const webhookConsumer = this.webhookManager?.store.getWebhookConsumer(consumerId);
		const response = {
			...info,
			...webhookConsumer ? { webhook: {
				wake_id: webhookConsumer.wake_id ?? null,
				subscription_id: webhookConsumer.subscription_id
			} } : {}
		};
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify(response));
	}
	handleDelete(consumerId, res) {
		const removed = this.manager.deleteConsumer(consumerId);
		if (!removed) {
			res.writeHead(404, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `CONSUMER_NOT_FOUND`,
				message: `Consumer not found`
			} }));
			return;
		}
		res.writeHead(204);
		res.end();
	}
	async handleAcquire(consumerId, req, res) {
		let worker;
		const body = await this.readBody(req);
		if (body.length > 0) {
			let parsed;
			try {
				parsed = JSON.parse(new TextDecoder().decode(body));
			} catch {
				res.writeHead(400, { "content-type": `application/json` });
				res.end(JSON.stringify({ error: {
					code: `INVALID_REQUEST`,
					message: `Invalid JSON body`
				} }));
				return;
			}
			if (parsed.worker && typeof parsed.worker === `string`) worker = parsed.worker;
		}
		const result = this.manager.acquire(consumerId, worker);
		if (`error` in result) {
			const status = ERROR_CODE_TO_STATUS$1[result.error.code] ?? 500;
			const headers = { "content-type": `application/json` };
			if (result.error.retry_after) headers[`Retry-After`] = String(result.error.retry_after);
			res.writeHead(status, headers);
			res.end(JSON.stringify({ error: result.error }));
			return;
		}
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify(result));
	}
	async handleAck(consumerId, req, res) {
		const authHeader = req.headers[`authorization`];
		if (!authHeader || !authHeader.startsWith(`Bearer `)) {
			res.writeHead(401, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `TOKEN_INVALID`,
				message: `Missing or malformed Authorization header`
			} }));
			return;
		}
		const token = authHeader.slice(`Bearer `.length);
		const body = await this.readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body));
		} catch {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Invalid JSON body`
			} }));
			return;
		}
		if (!isValidAckRequest(parsed)) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `offsets must be an array of { path, offset } objects`
			} }));
			return;
		}
		const result = this.manager.ack(consumerId, token, parsed);
		if (`error` in result) {
			const status = ERROR_CODE_TO_STATUS$1[result.error.code] ?? 500;
			res.writeHead(status, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: result.error }));
			return;
		}
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify({
			ok: true,
			token: result.token
		}));
	}
	handleRelease(consumerId, req, res) {
		const authHeader = req.headers[`authorization`];
		if (!authHeader || !authHeader.startsWith(`Bearer `)) {
			res.writeHead(401, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `TOKEN_INVALID`,
				message: `Missing or malformed Authorization header`
			} }));
			return;
		}
		const token = authHeader.slice(`Bearer `.length);
		const result = this.manager.release(consumerId, token);
		if (`error` in result) {
			const status = ERROR_CODE_TO_STATUS$1[result.error.code] ?? 500;
			res.writeHead(status, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: result.error }));
			return;
		}
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify(result));
	}
	async handleSetWakePreference(consumerId, req, res) {
		const body = await this.readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body));
		} catch {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Invalid JSON body`
			} }));
			return;
		}
		if (typeof parsed !== `object` || parsed === null) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `Invalid JSON body`
			} }));
			return;
		}
		const payload = parsed;
		const existingConsumer = this.manager.getConsumer(consumerId);
		if (!existingConsumer) {
			res.writeHead(404, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `CONSUMER_NOT_FOUND`,
				message: `Consumer not found`
			} }));
			return;
		}
		if (typeof payload.type !== `string` || ![
			`none`,
			`webhook`,
			`pull-wake`
		].includes(payload.type)) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `INVALID_REQUEST`,
				message: `type must be one of: none, webhook, pull-wake`
			} }));
			return;
		}
		let preference;
		if (payload.type === `none`) preference = { type: `none` };
		else if (payload.type === `webhook`) {
			if (!this.webhookManager) {
				res.writeHead(400, { "content-type": `application/json` });
				res.end(JSON.stringify({ error: {
					code: `INVALID_REQUEST`,
					message: `webhook wake preference requires webhook support to be enabled`
				} }));
				return;
			}
			if (typeof payload.url !== `string` || payload.url.length === 0) {
				res.writeHead(400, { "content-type": `application/json` });
				res.end(JSON.stringify({ error: {
					code: `INVALID_REQUEST`,
					message: `webhook type requires url field`
				} }));
				return;
			}
			preference = {
				type: `webhook`,
				url: payload.url
			};
		} else {
			if (typeof payload.wake_stream !== `string` || payload.wake_stream.length === 0) {
				res.writeHead(400, { "content-type": `application/json` });
				res.end(JSON.stringify({ error: {
					code: `INVALID_REQUEST`,
					message: `pull-wake type requires wake_stream field`
				} }));
				return;
			}
			if (existingConsumer.streams.length > 1) {
				res.writeHead(400, { "content-type": `application/json` });
				res.end(JSON.stringify({ error: {
					code: `MULTI_STREAM_PULL_WAKE`,
					message: `pull-wake is not supported for multi-stream consumers`
				} }));
				return;
			}
			preference = {
				type: `pull-wake`,
				wake_stream: payload.wake_stream
			};
		}
		const previousPreference = existingConsumer.wake_preference;
		const consumer = this.manager.setWakePreference(consumerId, preference);
		if (!consumer) {
			res.writeHead(404, { "content-type": `application/json` });
			res.end(JSON.stringify({ error: {
				code: `CONSUMER_NOT_FOUND`,
				message: `Consumer not found`
			} }));
			return;
		}
		if (this.webhookManager && previousPreference.type === `webhook` && preference.type !== `webhook`) this.webhookManager.clearDirectWebhookPreference(consumerId);
		if (this.pullWakeManager) this.pullWakeManager.clearPendingWake(consumerId);
		if (preference.type === `webhook`) {
			const configured = this.webhookManager?.setDirectWebhookPreference(consumerId, preference.url);
			if (!configured) {
				res.writeHead(404, { "content-type": `application/json` });
				res.end(JSON.stringify({ error: {
					code: `CONSUMER_NOT_FOUND`,
					message: `Consumer not found`
				} }));
				return;
			}
		}
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify({
			ok: true,
			wake_preference: preference
		}));
	}
	readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			req.on(`data`, (chunk) => chunks.push(chunk));
			req.on(`end`, () => resolve(new Uint8Array(Buffer.concat(chunks))));
			req.on(`error`, reject);
		});
	}
};
function isValidAckRequest(value) {
	if (!value || typeof value !== `object`) return false;
	const offsets = value.offsets;
	if (!Array.isArray(offsets)) return false;
	return offsets.every((offset) => !!offset && typeof offset === `object` && typeof offset.path === `string` && typeof offset.offset === `string`);
}

//#endregion
//#region src/pull-wake-manager.ts
var PullWakeManager = class {
	consumerManager;
	streamStore;
	pendingWakes = new Set();
	isShuttingDown = false;
	constructor(opts) {
		this.consumerManager = opts.consumerManager;
		this.streamStore = opts.streamStore;
		this.consumerManager.onLeaseExpired(this.handleLeaseExpired.bind(this));
		this.consumerManager.onEpochAcquiredCritical(this.handleEpochAcquired.bind(this));
		this.consumerManager.onEpochReleased(this.handleEpochReleased.bind(this));
		this.consumerManager.onConsumerDeleted((consumerId) => {
			this.pendingWakes.delete(consumerId);
		});
	}
	/**
	* Called from server.ts when events are appended to a stream.
	* Checks if any pull-wake consumers subscribed to this stream need waking.
	*/
	onStreamAppend(streamPath) {
		if (this.isShuttingDown) return;
		const consumerIds = this.consumerManager.store.getConsumersForStream(streamPath);
		for (const consumerId of consumerIds) {
			const consumer = this.consumerManager.store.getConsumer(consumerId);
			if (!consumer) continue;
			if (consumer.wake_preference.type !== `pull-wake`) continue;
			if (consumer.state !== `REGISTERED`) continue;
			if (this.pendingWakes.has(consumerId)) continue;
			this.writeWakeEvent(consumer, streamPath);
		}
	}
	/**
	* Handle lease expiry: if consumer has pending work, re-wake.
	*/
	handleLeaseExpired(consumer) {
		if (this.isShuttingDown) return;
		if (consumer.wake_preference.type !== `pull-wake`) return;
		if (this.consumerManager.hasPendingWork(consumer.consumer_id)) this.writeWakeEvent(consumer, this.getPrimaryStream(consumer));
	}
	/**
	* Handle epoch acquired: write a "claimed" event to the wake stream.
	*/
	handleEpochAcquired(consumerId, epoch, worker) {
		if (this.isShuttingDown) return;
		const consumer = this.consumerManager.store.getConsumer(consumerId);
		if (!consumer) return;
		if (consumer.wake_preference.type !== `pull-wake`) return;
		this.pendingWakes.delete(consumerId);
		const streamPath = this.getPrimaryStream(consumer);
		const event = {
			type: `claimed`,
			stream: streamPath,
			worker: worker ?? `unknown`,
			epoch,
			ts: Date.now()
		};
		this.appendToWakeStream(consumer.wake_preference.wake_stream, event);
	}
	/**
	* Handle epoch released: if consumer has pending work, re-wake.
	*/
	handleEpochReleased(consumerId) {
		if (this.isShuttingDown) return;
		const consumer = this.consumerManager.store.getConsumer(consumerId);
		if (!consumer) return;
		if (consumer.wake_preference.type !== `pull-wake`) return;
		if (this.consumerManager.hasPendingWork(consumerId)) this.writeWakeEvent(consumer, this.getPrimaryStream(consumer));
	}
	/**
	* Write a wake event to the consumer's wake stream.
	*/
	writeWakeEvent(consumer, streamPath) {
		if (consumer.wake_preference.type !== `pull-wake`) return;
		const event = {
			type: `wake`,
			stream: streamPath,
			consumer: consumer.consumer_id,
			ts: Date.now()
		};
		this.appendToWakeStream(consumer.wake_preference.wake_stream, event);
		this.pendingWakes.add(consumer.consumer_id);
	}
	/**
	* Append an event to a wake stream.
	* Wake streams are ordinary L0 streams and must be created explicitly.
	*/
	appendToWakeStream(wakeStreamPath, event) {
		const data = new TextEncoder().encode(JSON.stringify(event));
		if (!this.streamStore.has(wakeStreamPath)) throw new Error(`[pull-wake] Wake stream '${wakeStreamPath}' does not exist. Create the stream before setting pull-wake preference.`);
		this.streamStore.append(wakeStreamPath, data);
	}
	/**
	* Get the primary (first) stream path for a consumer.
	*/
	getPrimaryStream(consumer) {
		const firstEntry = consumer.streams.entries().next();
		if (firstEntry.done) throw new Error(`[pull-wake] Consumer '${consumer.consumer_id}' has no streams`);
		return firstEntry.value[0];
	}
	shutdown() {
		this.isShuttingDown = true;
		this.pendingWakes.clear();
	}
	clearPendingWake(consumerId) {
		this.pendingWakes.delete(consumerId);
	}
};

//#endregion
//#region src/subscription-manager.ts
const DEFAULT_LEASE_TTL_MS = 3e4;
const MIN_LEASE_TTL_MS = 1e3;
const MAX_LEASE_TTL_MS = 10 * 6e4;
const ZERO_OFFSET = `0000000000000000_0000000000000000`;
const BEFORE_FIRST_OFFSET = `-1`;
const MAX_RETRY_DELAY_MS$1 = 6e4;
function compareOffsets(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
function normalizeRelativePath(path) {
	return path.replace(/^\/+/, ``).replace(/\/+$/, ``);
}
function toAbsoluteStreamPath(streamPath) {
	return `/v1/stream/${normalizeRelativePath(streamPath)}`;
}
function toStreamRelativePath(absolutePath) {
	const streamRoot = `/v1/stream/`;
	if (!absolutePath.startsWith(streamRoot)) return null;
	const path = absolutePath.slice(streamRoot.length);
	if (path === `__ds` || path.startsWith(`__ds/`)) return null;
	return path.length > 0 ? path : null;
}
function stableConfigHash(input) {
	const canonical = {
		type: input.type,
		pattern: input.pattern,
		streams: [...new Set(input.streams)].sort(),
		webhook: input.webhook ? { url: input.webhook.url } : void 0,
		wake_stream: input.wake_stream,
		lease_ttl_ms: input.lease_ttl_ms,
		description: input.description
	};
	return (0, node_crypto.createHash)(`sha256`).update(JSON.stringify(canonical)).digest(`hex`);
}
function isPrivateOrLinkLocalIpv4(host) {
	const parts = host.split(`.`).map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
	const [a, b] = parts;
	return a === 10 || a === 127 || a === 0 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
}
function isLocalDevHost(host) {
	return host === `localhost` || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
function validateWebhookUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return {
			ok: false,
			message: `webhook.url must be a valid URL`
		};
	}
	const host = url.hostname.toLowerCase();
	if (url.protocol === `http:`) {
		if (isLocalDevHost(host)) return { ok: true };
		return {
			ok: false,
			message: `http webhook URLs are only allowed for localhost or 127.0.0.x`
		};
	}
	if (url.protocol !== `https:`) return {
		ok: false,
		message: `webhook.url must use https`
	};
	if (host === `localhost`) return {
		ok: false,
		message: `localhost webhook URLs must use http for dev`
	};
	if ((0, node_net.isIP)(host) === 4 && isPrivateOrLinkLocalIpv4(host)) return {
		ok: false,
		message: `webhook.url must not target private or link-local hosts`
	};
	if ((0, node_net.isIP)(host) === 6) return {
		ok: false,
		message: `IPv6 webhook hosts are not accepted by the reference server`
	};
	return { ok: true };
}
var SubscriptionManager = class {
	subscriptions = new Map();
	streamStore;
	callbackBaseUrl;
	webhooksEnabled;
	isShuttingDown = false;
	constructor(opts) {
		this.callbackBaseUrl = opts.callbackBaseUrl;
		this.streamStore = opts.streamStore;
		this.webhooksEnabled = opts.webhooksEnabled ?? true;
	}
	createOrConfirm(id, input) {
		const configHash = stableConfigHash(input);
		const existing = this.subscriptions.get(id);
		if (existing) {
			if (existing.config_hash !== configHash) return { error: {
				code: `SUBSCRIPTION_ALREADY_EXISTS`,
				message: `Subscription already exists with different configuration`
			} };
			return {
				subscription: existing,
				created: false
			};
		}
		if (input.type === `webhook`) {
			if (!this.webhooksEnabled) return { error: {
				code: `INVALID_REQUEST`,
				message: `webhook subscriptions are not enabled on this server`
			} };
			if (!input.webhook) return { error: {
				code: `INVALID_REQUEST`,
				message: `webhook subscriptions require webhook.url`
			} };
			const validation = validateWebhookUrl(input.webhook.url);
			if (!validation.ok) return { error: {
				code: `WEBHOOK_URL_REJECTED`,
				message: validation.message
			} };
		}
		if (input.type === `pull-wake` && !input.wake_stream) return { error: {
			code: `INVALID_REQUEST`,
			message: `pull-wake subscriptions require wake_stream`
		} };
		const subscription = {
			id,
			type: input.type,
			pattern: input.pattern,
			webhook: input.webhook ? { url: input.webhook.url } : void 0,
			wake_stream: input.wake_stream,
			lease_ttl_ms: input.lease_ttl_ms,
			description: input.description,
			created_at: new Date().toISOString(),
			status: `active`,
			config_hash: configHash,
			streams: new Map(),
			generation: 0,
			wake_id: null,
			wake_snapshot: new Map(),
			token: null,
			holder: null,
			lease_timer: null,
			retry_count: 0,
			retry_timer: null,
			next_attempt_at: null
		};
		for (const stream of input.streams) this.linkStream(subscription, stream, `explicit`, this.getTailOffset(stream));
		if (input.pattern) {
			for (const stream of this.listStreams()) if (globMatch(input.pattern, stream)) this.linkStream(subscription, stream, `glob`, this.getTailOffset(stream));
		}
		this.subscriptions.set(id, subscription);
		return {
			subscription,
			created: true
		};
	}
	get(id) {
		return this.subscriptions.get(id);
	}
	delete(id) {
		const subscription = this.subscriptions.get(id);
		if (!subscription) return false;
		this.clearLease(subscription);
		if (subscription.retry_timer) clearTimeout(subscription.retry_timer);
		this.subscriptions.delete(id);
		return true;
	}
	addExplicitStreams(id, streams) {
		const subscription = this.get(id);
		if (!subscription) return false;
		for (const stream of streams) this.linkStream(subscription, stream, `explicit`, this.getTailOffset(stream));
		return true;
	}
	removeExplicitStream(id, streamPath) {
		const subscription = this.get(id);
		if (!subscription) return false;
		const normalized = normalizeRelativePath(streamPath);
		const link = subscription.streams.get(normalized);
		if (!link) return true;
		link.link_types.delete(`explicit`);
		if (link.link_types.size === 0) subscription.streams.delete(normalized);
		return true;
	}
	async onStreamAppend(absolutePath) {
		if (this.isShuttingDown) return;
		for (const subscription of this.subscriptions.values()) {
			const relative = toStreamRelativePath(absolutePath);
			if (!relative) continue;
			if (subscription.pattern && globMatch(subscription.pattern, relative)) {
				const existing = subscription.streams.get(relative);
				this.linkStream(subscription, relative, `glob`, existing?.acked_offset ?? BEFORE_FIRST_OFFSET);
			}
			if (subscription.streams.has(relative)) await this.maybeWake(subscription, relative);
		}
	}
	onStreamDeleted(absolutePath) {
		for (const subscription of this.subscriptions.values()) {
			const relative = toStreamRelativePath(absolutePath);
			if (relative) subscription.streams.delete(relative);
		}
	}
	async handleWebhookCallback(id, token, request) {
		const subscription = this.get(id);
		if (!subscription) return this.errorResponse(404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
		const fenced = this.validateWakeToken(subscription, token, request);
		if (fenced) return fenced;
		const ackError = this.applyAcks(subscription, request);
		if (ackError) return ackError;
		this.extendLease(subscription);
		let nextWake = false;
		if (request.done === true) {
			this.clearLease(subscription);
			subscription.token = null;
			subscription.holder = null;
			subscription.wake_id = null;
			subscription.wake_snapshot.clear();
			nextWake = await this.triggerNextWakeIfPending(subscription);
		}
		return {
			status: 200,
			body: {
				ok: true,
				next_wake: nextWake
			}
		};
	}
	async claim(id, worker) {
		const subscription = this.get(id);
		if (!subscription) return this.errorResponse(404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
		if (subscription.type !== `pull-wake`) return this.errorResponse(400, `INVALID_REQUEST`, `Subscription is not pull-wake`);
		if (subscription.holder) return {
			status: 409,
			body: { error: {
				code: `ALREADY_CLAIMED`,
				current_holder: subscription.holder,
				generation: subscription.generation
			} }
		};
		if (!this.hasPendingWork(subscription)) return this.errorResponse(409, `NO_PENDING_WORK`, `Subscription has no pending work`);
		if (!subscription.wake_id) await this.createWake(subscription, this.firstPendingStream(subscription));
		subscription.holder = worker;
		subscription.token = generateCallbackToken(this.tokenSubject(subscription), subscription.generation);
		this.extendLease(subscription);
		return {
			status: 200,
			body: {
				wake_id: subscription.wake_id,
				generation: subscription.generation,
				token: subscription.token,
				streams: this.streamInfos(subscription),
				lease_ttl_ms: subscription.lease_ttl_ms
			}
		};
	}
	async ack(id, token, request) {
		const subscription = this.get(id);
		if (!subscription) return this.errorResponse(404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
		if (subscription.type !== `pull-wake`) return this.errorResponse(400, `INVALID_REQUEST`, `Subscription is not pull-wake`);
		const fenced = this.validateWakeToken(subscription, token, request);
		if (fenced) return fenced;
		const ackError = this.applyAcks(subscription, request);
		if (ackError) return ackError;
		this.extendLease(subscription);
		let nextWake = false;
		if (request.done === true) {
			this.clearLease(subscription);
			subscription.token = null;
			subscription.holder = null;
			subscription.wake_id = null;
			subscription.wake_snapshot.clear();
			nextWake = await this.triggerNextWakeIfPending(subscription);
		}
		return {
			status: 200,
			body: {
				ok: true,
				next_wake: nextWake
			}
		};
	}
	async release(id, token, request) {
		const subscription = this.get(id);
		if (!subscription) return this.errorResponse(404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
		if (subscription.type !== `pull-wake`) return this.errorResponse(400, `INVALID_REQUEST`, `Subscription is not pull-wake`);
		const fenced = this.validateWakeToken(subscription, token, request);
		if (fenced) return fenced;
		this.clearLease(subscription);
		subscription.token = null;
		subscription.holder = null;
		subscription.wake_id = null;
		subscription.wake_snapshot.clear();
		await this.triggerNextWakeIfPending(subscription);
		return { status: 204 };
	}
	serialize(subscription) {
		return {
			id: subscription.id,
			subscription_id: subscription.id,
			type: subscription.type,
			pattern: subscription.pattern,
			streams: this.streamInfos(subscription).map((stream) => ({
				path: stream.path,
				link_type: stream.link_type,
				acked_offset: stream.acked_offset
			})),
			webhook: subscription.webhook ? {
				url: subscription.webhook.url,
				signing: this.webhookSigningMetadata()
			} : void 0,
			wake_stream: subscription.wake_stream,
			lease_ttl_ms: subscription.lease_ttl_ms,
			created_at: subscription.created_at,
			status: subscription.status,
			description: subscription.description
		};
	}
	getWebhookJwks() {
		return getWebhookJwks();
	}
	shutdown() {
		this.isShuttingDown = true;
		for (const subscription of this.subscriptions.values()) {
			this.clearLease(subscription);
			if (subscription.retry_timer) clearTimeout(subscription.retry_timer);
		}
		this.subscriptions.clear();
	}
	async maybeWake(subscription, triggeredBy) {
		if (subscription.wake_id || subscription.holder) return;
		if (!this.hasPendingWork(subscription)) return;
		await this.createWake(subscription, triggeredBy);
	}
	async createWake(subscription, triggeredBy) {
		subscription.generation++;
		subscription.wake_id = generateWakeId();
		subscription.wake_snapshot = new Map(this.streamInfos(subscription).map((stream) => [stream.path, stream.tail_offset]));
		if (subscription.type === `webhook`) {
			subscription.token = generateCallbackToken(this.tokenSubject(subscription), subscription.generation);
			this.extendLease(subscription);
			this.deliverWebhook(subscription, [triggeredBy]);
			return;
		}
		await this.writePullWakeEvent(subscription, triggeredBy);
	}
	async deliverWebhook(subscription, triggeredBy) {
		if (!subscription.webhook || !subscription.wake_id || !subscription.token) return;
		const body = JSON.stringify({
			subscription_id: subscription.id,
			wake_id: subscription.wake_id,
			generation: subscription.generation,
			streams: this.streamInfos(subscription),
			callback_url: this.subscriptionActionUrl(subscription, `callback`),
			callback_token: subscription.token
		});
		const headers = {
			"content-type": `application/json`,
			"webhook-signature": signWebhookPayload(body)
		};
		try {
			const response = await fetch(subscription.webhook.url, {
				method: `POST`,
				headers,
				body
			});
			if (!response.ok) {
				this.scheduleWebhookRetry(subscription, triggeredBy);
				return;
			}
			subscription.status = `active`;
			subscription.retry_count = 0;
			subscription.next_attempt_at = null;
			let parsed = null;
			try {
				parsed = await response.json();
			} catch {
				parsed = null;
			}
			if (parsed?.done === true) {
				this.autoAckWakeSnapshot(subscription);
				this.clearLease(subscription);
				subscription.token = null;
				subscription.holder = null;
				subscription.wake_id = null;
				subscription.wake_snapshot.clear();
				await this.triggerNextWakeIfPending(subscription);
			}
		} catch (err) {
			serverLog.warn(`[subscriptions] webhook delivery failed:`, err);
			this.scheduleWebhookRetry(subscription, triggeredBy);
		}
	}
	scheduleWebhookRetry(subscription, triggeredBy) {
		if (this.isShuttingDown) return;
		subscription.retry_count++;
		const baseDelay = Math.min(1e3 * Math.pow(2, Math.max(0, subscription.retry_count - 1)), MAX_RETRY_DELAY_MS$1);
		const jitter = baseDelay * .2 * (Math.random() * 2 - 1);
		const delay = Math.max(0, Math.round(baseDelay + jitter));
		subscription.status = `failed`;
		subscription.next_attempt_at = Date.now() + delay;
		if (subscription.retry_timer) clearTimeout(subscription.retry_timer);
		subscription.retry_timer = setTimeout(() => {
			subscription.retry_timer = null;
			this.deliverWebhook(subscription, triggeredBy);
		}, delay);
	}
	async writePullWakeEvent(subscription, streamPath) {
		if (!subscription.wake_stream) return;
		const wakeStream = toAbsoluteStreamPath(subscription.wake_stream);
		if (!this.streamStore.has(wakeStream)) {
			serverLog.warn(`[subscriptions] wake stream does not exist: ${wakeStream}`);
			return;
		}
		const event = {
			type: `wake`,
			subscription_id: subscription.id,
			stream: streamPath,
			generation: subscription.generation,
			ts: Date.now()
		};
		await Promise.resolve(this.streamStore.append(wakeStream, new TextEncoder().encode(JSON.stringify(event))));
	}
	autoAckWakeSnapshot(subscription) {
		for (const [stream, tail] of subscription.wake_snapshot) {
			const link = subscription.streams.get(stream);
			if (link) link.acked_offset = tail;
		}
	}
	applyAcks(subscription, request) {
		if (!request.acks) return null;
		for (const ack of request.acks) {
			const stream = normalizeRelativePath(ack.stream ?? ack.path ?? ``);
			const link = subscription.streams.get(stream);
			if (!stream || !link) return this.errorResponse(409, `INVALID_OFFSET`, `Ack references an unknown subscription stream`);
			if (ack.offset === BEFORE_FIRST_OFFSET) return this.errorResponse(409, `INVALID_OFFSET`, `Ack offset must not be -1`);
			if (compareOffsets(ack.offset, link.acked_offset) < 0) return this.errorResponse(409, `INVALID_OFFSET`, `Ack offset regresses the committed cursor`);
			if (compareOffsets(ack.offset, this.getTailOffset(stream)) > 0) return this.errorResponse(409, `INVALID_OFFSET`, `Ack offset is beyond stream tail`);
		}
		for (const ack of request.acks) {
			const stream = normalizeRelativePath(ack.stream ?? ack.path ?? ``);
			subscription.streams.get(stream).acked_offset = ack.offset;
		}
		return null;
	}
	validateWakeToken(subscription, token, request) {
		const tokenResult = validateCallbackToken(token, this.tokenSubject(subscription));
		if (!tokenResult.valid) return this.errorResponse(401, tokenResult.code, tokenResult.code === `TOKEN_EXPIRED` ? `Token expired` : `Token invalid`);
		if (tokenResult.epoch !== subscription.generation || request.generation !== subscription.generation || request.wake_id !== subscription.wake_id) return this.errorResponse(409, `FENCED`, `Wake generation is stale`);
		return null;
	}
	async triggerNextWakeIfPending(subscription) {
		if (!this.hasPendingWork(subscription)) return false;
		await this.createWake(subscription, this.firstPendingStream(subscription));
		return true;
	}
	hasPendingWork(subscription) {
		return this.streamInfos(subscription).some((stream) => stream.has_pending);
	}
	firstPendingStream(subscription) {
		return this.streamInfos(subscription).find((stream) => stream.has_pending)?.path ?? ``;
	}
	streamInfos(subscription) {
		return Array.from(subscription.streams.values()).map((link) => {
			const tail = this.getTailOffset(link.path);
			return {
				path: link.path,
				link_type: link.link_types.has(`explicit`) ? `explicit` : `glob`,
				acked_offset: link.acked_offset,
				tail_offset: tail,
				has_pending: compareOffsets(tail, link.acked_offset) > 0
			};
		});
	}
	linkStream(subscription, streamPath, linkType, ackedOffset) {
		const normalized = normalizeRelativePath(streamPath);
		const existing = subscription.streams.get(normalized);
		if (existing) {
			existing.link_types.add(linkType);
			return existing;
		}
		const link = {
			path: normalized,
			link_types: new Set([linkType]),
			acked_offset: ackedOffset
		};
		subscription.streams.set(normalized, link);
		return link;
	}
	listStreams() {
		return this.streamStore.list().map((path) => toStreamRelativePath(path)).filter((path) => path !== null);
	}
	getTailOffset(streamPath) {
		return this.streamStore.get(toAbsoluteStreamPath(streamPath))?.currentOffset ?? ZERO_OFFSET;
	}
	subscriptionActionUrl(subscription, action) {
		const url = new URL(`/v1/stream/__ds/subscriptions/${encodeURIComponent(subscription.id)}/${action}`, this.callbackBaseUrl);
		return url.toString();
	}
	webhookJwksUrl() {
		const url = new URL(`/v1/stream/__ds/jwks.json`, this.callbackBaseUrl);
		return url.toString();
	}
	webhookSigningMetadata() {
		return {
			alg: `ed25519`,
			kid: getWebhookSigningKeyId(),
			jwks_url: this.webhookJwksUrl()
		};
	}
	extendLease(subscription) {
		this.clearLease(subscription);
		subscription.lease_timer = setTimeout(() => {
			subscription.lease_timer = null;
			subscription.holder = null;
			subscription.token = null;
			subscription.wake_id = null;
			subscription.wake_snapshot.clear();
			this.triggerNextWakeIfPending(subscription);
		}, subscription.lease_ttl_ms);
	}
	clearLease(subscription) {
		if (subscription.lease_timer) {
			clearTimeout(subscription.lease_timer);
			subscription.lease_timer = null;
		}
	}
	tokenSubject(subscription) {
		return `subscription:${subscription.id}`;
	}
	errorResponse(status, code, message) {
		return {
			status,
			body: { error: {
				code,
				message
			} }
		};
	}
};

//#endregion
//#region src/subscription-routes.ts
const RESERVED_CONTROL_PREFIX = `/v1/stream/__ds`;
const SUBSCRIPTION_PREFIX = `${RESERVED_CONTROL_PREFIX}/subscriptions/`;
const JWKS_PATH = `${RESERVED_CONTROL_PREFIX}/jwks.json`;
const ERROR_STATUS = {
	INVALID_REQUEST: 400,
	SUBSCRIPTION_NOT_FOUND: 404,
	SUBSCRIPTION_ALREADY_EXISTS: 409,
	WEBHOOK_URL_REJECTED: 400,
	TOKEN_INVALID: 401,
	TOKEN_EXPIRED: 401,
	FENCED: 409,
	ALREADY_CLAIMED: 409,
	NO_PENDING_WORK: 409,
	INVALID_OFFSET: 409
};
var SubscriptionRoutes = class {
	manager;
	constructor(manager) {
		this.manager = manager;
	}
	async handleRequest(method, path, req, res) {
		if (path === JWKS_PATH) {
			this.handleJwks(method, res);
			return true;
		}
		const route = this.parseRoute(path);
		if (!route) {
			if (path === RESERVED_CONTROL_PREFIX || path.startsWith(`${RESERVED_CONTROL_PREFIX}/`)) {
				this.writeError(res, 404, `SUBSCRIPTION_NOT_FOUND`, `Durable Streams control route not found`);
				return true;
			}
			return false;
		}
		try {
			switch (route.action) {
				case `base`:
					await this.handleBase(route, method, req, res);
					return true;
				case `streams`:
					await this.handleStreams(route, method, req, res);
					return true;
				case `stream`:
					this.handleStream(route, method, res);
					return true;
				case `callback`:
					await this.handleCallback(route, req, res);
					return true;
				case `claim`:
					await this.handleClaim(route, req, res);
					return true;
				case `ack`:
					await this.handleAck(route, req, res);
					return true;
				case `release`:
					await this.handleRelease(route, req, res);
					return true;
			}
		} catch (err) {
			if (err instanceof SyntaxError) {
				this.writeError(res, 400, `INVALID_REQUEST`, `Invalid JSON body`);
				return true;
			}
			throw err;
		}
	}
	async handleBase(route, method, req, res) {
		if (method === `PUT`) {
			const parsed = await this.readJson(req);
			const input = this.parseCreateInput(parsed);
			if (`error` in input) {
				this.writeError(res, 400, `INVALID_REQUEST`, input.error);
				return;
			}
			const result = this.manager.createOrConfirm(route.subscriptionId, input.value);
			if (`error` in result) {
				this.writeError(res, ERROR_STATUS[result.error.code], result.error.code, result.error.message);
				return;
			}
			this.writeJson(res, result.created ? 201 : 200, this.manager.serialize(result.subscription));
			return;
		}
		if (method === `GET`) {
			const subscription = this.manager.get(route.subscriptionId);
			if (!subscription) {
				this.writeError(res, 404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
				return;
			}
			this.writeJson(res, 200, this.manager.serialize(subscription));
			return;
		}
		if (method === `DELETE`) {
			this.manager.delete(route.subscriptionId);
			res.writeHead(204);
			res.end();
			return;
		}
		this.methodNotAllowed(res);
	}
	handleJwks(method, res) {
		if (method !== `GET`) {
			this.methodNotAllowed(res);
			return;
		}
		res.writeHead(200, {
			"content-type": `application/jwk-set+json`,
			"cache-control": `public, max-age=300`
		});
		res.end(JSON.stringify(this.manager.getWebhookJwks()));
	}
	async handleStreams(route, method, req, res) {
		if (method !== `POST`) {
			this.methodNotAllowed(res);
			return;
		}
		const parsed = await this.readJson(req);
		const streams = parsed.streams;
		if (!Array.isArray(streams) || streams.some((stream) => typeof stream !== `string` || stream.length === 0)) {
			this.writeError(res, 400, `INVALID_REQUEST`, `streams must be a non-empty string array`);
			return;
		}
		const ok = this.manager.addExplicitStreams(route.subscriptionId, streams.map(normalizeRelativePath));
		if (!ok) {
			this.writeError(res, 404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
			return;
		}
		res.writeHead(204);
		res.end();
	}
	handleStream(route, method, res) {
		if (method !== `DELETE`) {
			this.methodNotAllowed(res);
			return;
		}
		const ok = this.manager.removeExplicitStream(route.subscriptionId, route.streamPath ?? ``);
		if (!ok) {
			this.writeError(res, 404, `SUBSCRIPTION_NOT_FOUND`, `Subscription not found`);
			return;
		}
		res.writeHead(204);
		res.end();
	}
	async handleCallback(route, req, res) {
		const token = this.readBearerToken(req);
		if (!token) {
			this.writeError(res, 401, `TOKEN_INVALID`, `Missing or malformed Authorization header`);
			return;
		}
		const body = await this.readJson(req);
		const result = await this.manager.handleWebhookCallback(route.subscriptionId, token, body);
		this.writeManagerResult(res, result);
	}
	async handleClaim(route, req, res) {
		const parsed = await this.readJson(req);
		const worker = parsed.worker;
		if (typeof worker !== `string` || worker.length === 0) {
			this.writeError(res, 400, `INVALID_REQUEST`, `worker must be a non-empty string`);
			return;
		}
		const result = await this.manager.claim(route.subscriptionId, worker);
		this.writeManagerResult(res, result);
	}
	async handleAck(route, req, res) {
		const token = this.readBearerToken(req);
		if (!token) {
			this.writeError(res, 401, `TOKEN_INVALID`, `Missing or malformed Authorization header`);
			return;
		}
		const body = await this.readJson(req);
		const result = await this.manager.ack(route.subscriptionId, token, body);
		this.writeManagerResult(res, result);
	}
	async handleRelease(route, req, res) {
		const token = this.readBearerToken(req);
		if (!token) {
			this.writeError(res, 401, `TOKEN_INVALID`, `Missing or malformed Authorization header`);
			return;
		}
		const body = await this.readJson(req);
		const result = await this.manager.release(route.subscriptionId, token, body);
		this.writeManagerResult(res, result);
	}
	parseCreateInput(value) {
		if (!value || typeof value !== `object`) return { error: `Request body must be a JSON object` };
		const payload = value;
		if (payload.type !== `webhook` && payload.type !== `pull-wake`) return { error: `type must be "webhook" or "pull-wake"` };
		const type = payload.type;
		const pattern = typeof payload.pattern === `string` && payload.pattern.length > 0 ? normalizeRelativePath(payload.pattern) : void 0;
		const streams = Array.isArray(payload.streams) && payload.streams.length > 0 ? payload.streams.map((stream) => typeof stream === `string` ? normalizeRelativePath(stream) : null) : [];
		if (streams.some((stream) => stream === null)) return { error: `streams must contain only strings` };
		if (!pattern && streams.length === 0) return { error: `At least one of pattern or streams is required` };
		const leaseTtl = payload.lease_ttl_ms === void 0 ? DEFAULT_LEASE_TTL_MS : payload.lease_ttl_ms;
		if (typeof leaseTtl !== `number` || !Number.isInteger(leaseTtl) || leaseTtl < MIN_LEASE_TTL_MS || leaseTtl > MAX_LEASE_TTL_MS) return { error: `lease_ttl_ms must be an integer from 1000 to 600000` };
		let webhook;
		if (type === `webhook`) {
			const rawWebhook = payload.webhook;
			if (!rawWebhook || typeof rawWebhook !== `object`) return { error: `webhook subscriptions require webhook.url` };
			const url = rawWebhook.url;
			if (typeof url !== `string` || url.length === 0) return { error: `webhook subscriptions require webhook.url` };
			webhook = { url };
		}
		const wakeStream = typeof payload.wake_stream === `string` && payload.wake_stream.length > 0 ? normalizeRelativePath(payload.wake_stream) : void 0;
		if (type === `pull-wake` && !wakeStream) return { error: `pull-wake subscriptions require wake_stream` };
		return { value: {
			type,
			pattern,
			streams,
			webhook,
			wake_stream: wakeStream,
			lease_ttl_ms: leaseTtl,
			description: typeof payload.description === `string` ? payload.description : void 0
		} };
	}
	parseRoute(path) {
		if (!path.startsWith(SUBSCRIPTION_PREFIX)) return null;
		const rest = path.slice(SUBSCRIPTION_PREFIX.length);
		const parts = rest.split(`/`);
		const subscriptionId = parts[0] ? decodeURIComponent(parts[0]) : ``;
		if (!subscriptionId) return null;
		const tail = parts.slice(1);
		if (tail.length === 0) return {
			subscriptionId,
			action: `base`
		};
		if (tail[0] === `streams` && tail.length === 1) return {
			subscriptionId,
			action: `streams`
		};
		if (tail[0] === `streams` && tail.length > 1) return {
			subscriptionId,
			action: `stream`,
			streamPath: normalizeRelativePath(decodeURIComponent(tail.slice(1).join(`/`)))
		};
		if (tail.length === 1 && [
			`callback`,
			`claim`,
			`ack`,
			`release`
		].includes(tail[0])) return {
			subscriptionId,
			action: tail[0]
		};
		return null;
	}
	readBearerToken(req) {
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith(`Bearer `)) return null;
		return authHeader.slice(`Bearer `.length);
	}
	async readJson(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const raw = Buffer.concat(chunks).toString(`utf8`);
		return raw.length > 0 ? JSON.parse(raw) : {};
	}
	writeManagerResult(res, result) {
		if (result.status === 204) {
			res.writeHead(204);
			res.end();
			return;
		}
		this.writeJson(res, result.status, result.body ?? {});
	}
	writeJson(res, status, body) {
		res.writeHead(status, { "content-type": `application/json` });
		res.end(JSON.stringify(body));
	}
	writeError(res, status, code, message) {
		this.writeJson(res, status, { error: {
			code,
			message
		} });
	}
	methodNotAllowed(res) {
		res.writeHead(405, { "content-type": `text/plain` });
		res.end(`Method not allowed`);
	}
};

//#endregion
//#region src/webhook-telemetry.ts
const tracer = __opentelemetry_api.trace.getTracer(`durable-streams.webhook`);
const SPAN_WAKE_CYCLE = `consumer.wake_cycle`;
const SPAN_WEBHOOK_DELIVER = `webhook.deliver`;
const SPAN_CONSUMER_CALLBACK = `consumer.callback`;
const ATTR = {
	CONSUMER_ID: `durable_streams.consumer_id`,
	SUBSCRIPTION_ID: `durable_streams.subscription_id`,
	PRIMARY_STREAM: `durable_streams.primary_stream`,
	EPOCH: `durable_streams.epoch`,
	WAKE_ID: `durable_streams.wake_id`,
	TRIGGERED_BY: `durable_streams.triggered_by`,
	RETRY_COUNT: `durable_streams.retry_count`,
	CALLBACK_ACTION: `durable_streams.callback_action`
};
const EVENT = {
	STATE_TRANSITION: `state_transition`,
	RETRY_SCHEDULED: `retry_scheduled`,
	LIVENESS_TIMEOUT: `liveness_timeout`,
	TOKEN_REFRESHED: `token_refreshed`,
	WAKE_CLAIMED: `wake_claimed`,
	ACKS_PROCESSED: `acks_processed`,
	DONE_RECEIVED: `done_received`,
	DONE_WITH_REWAKE: `done_with_rewake`,
	CONSUMER_GC: `consumer.gc`,
	SERVER_SHUTDOWN: `server.shutdown`
};
/**
* Inject W3C traceparent into outgoing HTTP headers.
*/
function injectTraceHeaders(ctx, headers) {
	__opentelemetry_api.propagation.inject(ctx, headers);
}
/**
* Record a state_transition event on a span.
*/
function recordStateTransition(span, from, to) {
	span.addEvent(EVENT.STATE_TRANSITION, {
		from,
		to
	});
}
/**
* End a wake cycle span, optionally with an error status.
*/
function endWakeCycleSpan(span, eventName, error) {
	if (eventName) span.addEvent(eventName);
	if (error) span.setStatus({ code: __opentelemetry_api.SpanStatusCode.ERROR });
	span.end();
}

//#endregion
//#region src/webhook-store.ts
/**
* In-memory store for webhook subscriptions and L2 webhook consumer instances.
*/
var WebhookStore = class WebhookStore {
	subscriptions = new Map();
	webhookConsumers = new Map();
	subscriptionConsumers = new Map();
	streamConsumers = new Map();
	createSubscription(subscriptionId, pattern, webhook, description) {
		const existing = this.subscriptions.get(subscriptionId);
		if (existing) {
			if (existing.pattern === pattern && existing.webhook === webhook) return {
				subscription: existing,
				created: false
			};
			throw new Error(`Subscription already exists with different configuration`);
		}
		const subscription = {
			subscription_id: subscriptionId,
			pattern,
			webhook,
			webhook_secret: generateWebhookSecret(),
			description
		};
		this.subscriptions.set(subscriptionId, subscription);
		this.subscriptionConsumers.set(subscriptionId, new Set());
		return {
			subscription,
			created: true
		};
	}
	getSubscription(subscriptionId) {
		return this.subscriptions.get(subscriptionId);
	}
	listSubscriptions(pattern) {
		if (!pattern || pattern === `/**`) return Array.from(this.subscriptions.values());
		return Array.from(this.subscriptions.values()).filter((s) => s.pattern === pattern);
	}
	getConsumersForSubscription(subscriptionId) {
		const set = this.subscriptionConsumers.get(subscriptionId);
		return set ? Array.from(set) : [];
	}
	deleteSubscription(subscriptionId) {
		const sub = this.subscriptions.get(subscriptionId);
		if (!sub) return false;
		const consumerIds = this.subscriptionConsumers.get(subscriptionId);
		if (consumerIds) for (const cid of consumerIds) this.removeWebhookConsumer(cid);
		this.subscriptionConsumers.delete(subscriptionId);
		this.subscriptions.delete(subscriptionId);
		return true;
	}
	/**
	* Find all subscriptions whose pattern matches a given stream path.
	*/
	findMatchingSubscriptions(streamPath) {
		return Array.from(this.subscriptions.values()).filter((sub) => globMatch(sub.pattern, streamPath));
	}
	getWebhookConsumer(consumerId) {
		return this.webhookConsumers.get(consumerId);
	}
	/**
	* Build the consumer ID from subscription_id and stream path.
	*/
	static CONSUMER_ID_PREFIX = `__wh__:`;
	static buildConsumerId(subscriptionId, streamPath) {
		return `${WebhookStore.CONSUMER_ID_PREFIX}${subscriptionId}:${encodeURIComponent(streamPath)}`;
	}
	/**
	* Create an L2 webhook consumer record. Does not create L1 consumer state.
	*/
	createWebhookConsumer(consumerId, subscriptionId, streamPath) {
		const existing = this.webhookConsumers.get(consumerId);
		if (existing) return existing;
		const wc = {
			consumer_id: consumerId,
			subscription_id: subscriptionId,
			primary_stream: streamPath,
			wake_id: null,
			wake_id_claimed: false,
			last_webhook_failure_at: null,
			first_webhook_failure_at: null,
			retry_count: 0,
			retry_timer: null,
			wake_cycle_span: null,
			wake_cycle_ctx: null
		};
		this.webhookConsumers.set(consumerId, wc);
		const subConsumers = this.subscriptionConsumers.get(subscriptionId);
		if (subConsumers) subConsumers.add(consumerId);
		this.addStreamIndex(streamPath, consumerId);
		return wc;
	}
	/**
	* Claim a wake_id. Returns true if claim succeeds or was already claimed
	* for this wake (idempotent). Returns false if the wake_id doesn't match.
	*/
	claimWakeId(wc, wakeId) {
		if (wc.wake_id !== wakeId) return false;
		if (wc.wake_id_claimed) return true;
		wc.wake_id_claimed = true;
		return true;
	}
	/**
	* Remove a webhook consumer and clean up L2 indexes.
	* Does NOT remove L1 consumer — caller must handle that separately.
	*/
	removeWebhookConsumer(consumerId) {
		const wc = this.webhookConsumers.get(consumerId);
		if (!wc) return;
		if (wc.retry_timer) clearTimeout(wc.retry_timer);
		if (wc.wake_cycle_span) {
			endWakeCycleSpan(wc.wake_cycle_span, EVENT.CONSUMER_GC, true);
			wc.wake_cycle_span = null;
			wc.wake_cycle_ctx = null;
		}
		this.removeStreamIndex(wc.primary_stream, consumerId);
		const subConsumers = this.subscriptionConsumers.get(wc.subscription_id);
		if (subConsumers) subConsumers.delete(consumerId);
		this.webhookConsumers.delete(consumerId);
	}
	/**
	* Get all consumer IDs subscribed to a given stream path.
	*/
	getConsumersForStream(streamPath) {
		const set = this.streamConsumers.get(streamPath);
		return set ? Array.from(set) : [];
	}
	/**
	* Get all webhook consumer instances (for shutdown span cleanup).
	*/
	getAllWebhookConsumers() {
		return this.webhookConsumers.values();
	}
	/**
	* Remove a stream from the L2 stream index.
	*/
	removeStreamFromIndex(streamPath) {
		this.streamConsumers.delete(streamPath);
	}
	/**
	* Shut down: clear all timers.
	*/
	shutdown() {
		for (const wc of this.webhookConsumers.values()) if (wc.retry_timer) clearTimeout(wc.retry_timer);
		this.webhookConsumers.clear();
		this.subscriptions.clear();
		this.subscriptionConsumers.clear();
		this.streamConsumers.clear();
	}
	addStreamIndex(streamPath, consumerId) {
		let set = this.streamConsumers.get(streamPath);
		if (!set) {
			set = new Set();
			this.streamConsumers.set(streamPath, set);
		}
		set.add(consumerId);
	}
	removeStreamIndex(streamPath, consumerId) {
		const set = this.streamConsumers.get(streamPath);
		if (set) {
			set.delete(consumerId);
			if (set.size === 0) this.streamConsumers.delete(streamPath);
		}
	}
};

//#endregion
//#region src/webhook-manager.ts
const WEBHOOK_REQUEST_TIMEOUT_MS = 3e4;
const MAX_RETRY_DELAY_MS = 3e4;
const STEADY_RETRY_DELAY_MS = 6e4;
const GC_FAILURE_MS = 3 * 24 * 60 * 60 * 1e3;
function firstString(...candidates) {
	for (const c of candidates) if (typeof c === `string`) return c;
	return ``;
}
function firstArray(...candidates) {
	for (const c of candidates) if (Array.isArray(c)) return c;
	return [];
}
function addWebhookPayloadAliases(payload, defaults) {
	const consumerId = firstString(payload.consumerId, payload.consumer_id, defaults.consumerId);
	const epoch = typeof payload.epoch === `number` ? payload.epoch : defaults.epoch;
	const wakeId = firstString(payload.wakeId, payload.wake_id, defaults.wakeId);
	const streamPath = firstString(payload.streamPath, payload.stream_path, payload.primaryStream, payload.primary_stream, defaults.streamPath);
	const triggeredBy = firstArray(payload.triggeredBy, payload.triggered_by, defaults.triggeredBy);
	const callback = firstString(payload.callback, defaults.callback);
	const token = firstString(payload.claimToken, payload.token, defaults.token);
	return {
		...payload,
		consumerId,
		consumer_id: consumerId,
		epoch,
		wakeId,
		wake_id: wakeId,
		streamPath,
		stream_path: streamPath,
		primaryStream: streamPath,
		primary_stream: streamPath,
		streams: payload.streams ?? defaults.streams,
		triggeredBy,
		triggered_by: triggeredBy,
		callback,
		claimToken: token,
		token
	};
}
function mapAckErrorToCallbackError(error) {
	switch (error.code) {
		case `OFFSET_REGRESSION`:
		case `INVALID_OFFSET`: return `INVALID_OFFSET`;
		case `STALE_EPOCH`: return `STALE_EPOCH`;
		case `TOKEN_EXPIRED`: return `TOKEN_EXPIRED`;
		case `TOKEN_INVALID`: return `TOKEN_INVALID`;
		case `CONSUMER_NOT_FOUND`:
		case `UNKNOWN_STREAM`:
		case `CONSUMER_ALREADY_EXISTS`:
		case `EPOCH_HELD`:
		case `INTERNAL_ERROR`: throw new Error(`Unexpected ack error in webhook callback path: ${error.code}`);
	}
}
/**
* Orchestrates webhook delivery, consumer lifecycle, and callbacks.
* L2 layer: delegates epoch/stream/offset management to L1 ConsumerManager.
*/
var WebhookManager = class {
	store;
	consumerManager;
	callbackBaseUrl;
	getTailOffset;
	isShuttingDown = false;
	directWebhookConfigs = new Map();
	/**
	* Optional callback to enrich webhook payloads with additional context.
	* Used by DARIX to inject entity metadata into webhook notifications.
	*/
	enrichPayload;
	/**
	* Optional callback to retrieve the entity write_token for a given primary stream.
	* Used to include write_token in claim responses so entities can authenticate writes.
	*/
	getEntityWriteToken = null;
	constructor(opts) {
		this.store = new WebhookStore();
		this.callbackBaseUrl = opts.callbackBaseUrl;
		this.getTailOffset = opts.getTailOffset;
		this.consumerManager = opts.consumerManager;
		this.consumerManager.onLeaseExpired((consumer) => {
			const wc = this.store.getWebhookConsumer(consumer.consumer_id);
			if (wc && this.consumerManager.hasPendingWork(consumer.consumer_id)) this.wakeConsumer(wc, [wc.primary_stream]);
		});
		this.consumerManager.onConsumerDeleted((consumerId) => {
			this.directWebhookConfigs.delete(consumerId);
			const wc = this.store.getWebhookConsumer(consumerId);
			if (wc) {
				if (wc.retry_timer) clearTimeout(wc.retry_timer);
				this.store.removeWebhookConsumer(consumerId);
			}
		});
	}
	/**
	* Called when events are appended to a stream.
	* Lazily creates consumers for matching subscriptions on first append,
	* then checks if any consumers need to be woken.
	*/
	onStreamAppend(streamPath) {
		if (this.isShuttingDown) return;
		const matchingSubs = this.store.findMatchingSubscriptions(streamPath);
		for (const sub of matchingSubs) this.getOrCreateWebhookConsumer(sub.subscription_id, streamPath);
		const consumerIds = this.store.getConsumersForStream(streamPath);
		for (const cid of consumerIds) {
			if (this.directWebhookConfigs.has(cid)) continue;
			const wc = this.store.getWebhookConsumer(cid);
			if (!wc) continue;
			const l1Consumer = this.consumerManager.store.getConsumer(cid);
			if (!l1Consumer) continue;
			if (l1Consumer.state === `REGISTERED` && wc.wake_id === null) {
				if (this.consumerManager.hasPendingWork(cid)) this.wakeConsumer(wc, [streamPath]);
			}
		}
		for (const cid of this.consumerManager.store.getConsumersForStream(streamPath)) {
			if (!this.directWebhookConfigs.has(cid)) continue;
			const wc = this.store.getWebhookConsumer(cid);
			const l1Consumer = this.consumerManager.store.getConsumer(cid);
			if (!wc || !l1Consumer) continue;
			if (l1Consumer.wake_preference.type !== `webhook`) continue;
			if (l1Consumer.state === `REGISTERED` && wc.wake_id === null) {
				if (this.consumerManager.hasPendingWork(cid)) this.wakeConsumer(wc, [streamPath]);
			}
		}
	}
	/**
	* Called when a new stream is created.
	* No-op: consumers are created lazily on first append via onStreamAppend().
	*/
	onStreamCreated(_streamPath) {}
	/**
	* Called when a new stream is created and should be bound to a specific
	* subscription only. Used by DARIX spawn to ensure the entity's streams
	* are only associated with the subscription that was selected during spawn,
	* preventing stale subscriptions from creating spurious consumers.
	*/
	onStreamCreatedForSubscription(streamPath, subscriptionId) {
		if (this.isShuttingDown) return;
		const sub = this.store.getSubscription(subscriptionId);
		if (sub) this.getOrCreateWebhookConsumer(sub.subscription_id, streamPath);
	}
	/**
	* Called when a stream is deleted.
	* Removes the stream from L2 indexes and adjusts primary_stream references.
	*/
	onStreamDeleted(streamPath) {
		this.store.removeStreamFromIndex(streamPath);
		for (const wc of this.store.getAllWebhookConsumers()) if (wc.primary_stream === streamPath) {
			const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id);
			if (!l1Consumer || l1Consumer.streams.size === 0) continue;
			wc.primary_stream = l1Consumer.streams.keys().next().value;
		}
	}
	async wakeConsumer(wc, triggeredBy) {
		const target = this.getDeliveryTarget(wc);
		if (!target) {
			this.consumerManager.deleteConsumer(wc.consumer_id);
			this.store.removeWebhookConsumer(wc.consumer_id);
			return;
		}
		const acqResult = this.consumerManager.acquire(wc.consumer_id);
		if (`error` in acqResult) return;
		const { epoch, token } = acqResult;
		const wake_id = generateWakeId();
		wc.wake_id = wake_id;
		wc.wake_id_claimed = false;
		const wakeCycleSpan = tracer.startSpan(SPAN_WAKE_CYCLE, { attributes: {
			[ATTR.CONSUMER_ID]: wc.consumer_id,
			[ATTR.SUBSCRIPTION_ID]: wc.subscription_id,
			[ATTR.PRIMARY_STREAM]: wc.primary_stream,
			[ATTR.EPOCH]: epoch,
			[ATTR.WAKE_ID]: wake_id,
			[ATTR.TRIGGERED_BY]: triggeredBy
		} });
		const wakeCycleCtx = __opentelemetry_api.trace.setSpan(__opentelemetry_api.context.active(), wakeCycleSpan);
		wc.wake_cycle_span = wakeCycleSpan;
		wc.wake_cycle_ctx = wakeCycleCtx;
		recordStateTransition(wakeCycleSpan, `IDLE`, `WAKING`);
		const callbackUrl = this.buildCallbackUrl(wc.consumer_id);
		const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id);
		const streamsData = l1Consumer ? this.consumerManager.store.getStreamsData(l1Consumer) : [];
		let payload = addWebhookPayloadAliases({}, {
			consumerId: wc.consumer_id,
			epoch,
			wakeId: wake_id,
			streamPath: wc.primary_stream,
			streams: streamsData,
			triggeredBy,
			callback: callbackUrl,
			token
		});
		if (this.enrichPayload) try {
			payload = addWebhookPayloadAliases(await this.enrichPayload(payload, wc), {
				consumerId: wc.consumer_id,
				epoch,
				wakeId: wake_id,
				streamPath: wc.primary_stream,
				streams: streamsData,
				triggeredBy,
				callback: callbackUrl,
				token
			});
		} catch (err) {
			serverLog.error(`[webhook-manager] enrichPayload failed for ${wc.consumer_id}, releasing epoch:`, err);
			this.consumerManager.release(wc.consumer_id, token);
			this.transitionToIdle(wc);
			if (this.consumerManager.hasPendingWork(wc.consumer_id)) {
				wc.retry_count++;
				const delay = this.calculateRetryDelay(wc.retry_count);
				wc.retry_timer = setTimeout(() => {
					wc.retry_timer = null;
					if (!this.isShuttingDown && this.consumerManager.hasPendingWork(wc.consumer_id)) this.wakeConsumer(wc, [wc.primary_stream]).catch((err$1) => {
						serverLog.error(`[webhook-manager] retry wake failed for ${wc.consumer_id}:`, err$1);
					});
				}, delay);
			}
			return;
		}
		this.deliverWebhook(wc, target, payload, token).catch(() => {});
	}
	async deliverWebhook(wc, sub, payload, token) {
		const parentCtx = wc.wake_cycle_ctx ?? __opentelemetry_api.context.active();
		const deliverSpan = tracer.startSpan(SPAN_WEBHOOK_DELIVER, { attributes: {
			"http.method": `POST`,
			"http.url": sub.webhook,
			[ATTR.RETRY_COUNT]: wc.retry_count
		} }, parentCtx);
		const body = JSON.stringify(payload);
		const signature = signWebhookPayload(body, sub.webhook_secret);
		const headers = {
			"content-type": `application/json`,
			"webhook-signature": signature
		};
		injectTraceHeaders(__opentelemetry_api.trace.setSpan(parentCtx, deliverSpan), headers);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(sub.webhook, {
				method: `POST`,
				headers,
				body,
				signal: controller.signal
			});
			clearTimeout(timeoutId);
			deliverSpan.setAttribute(`http.status_code`, response.status);
			if (response.ok) {
				wc.last_webhook_failure_at = null;
				wc.first_webhook_failure_at = null;
				wc.retry_count = 0;
				let resBody = null;
				try {
					resBody = await response.json();
				} catch {}
				if (resBody?.done) {
					wc.wake_id_claimed = true;
					const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id);
					if (l1Consumer) {
						const tailOffsets = Array.from(l1Consumer.streams.keys()).map((path) => ({
							path,
							offset: this.getTailOffset(path)
						}));
						if (tailOffsets.length > 0) this.consumerManager.ack(wc.consumer_id, token, { offsets: tailOffsets });
					}
					this.consumerManager.release(wc.consumer_id, token);
					deliverSpan.end();
					this.transitionToIdle(wc);
					if (this.consumerManager.hasPendingWork(wc.consumer_id)) this.wakeConsumer(wc, [wc.primary_stream]);
					return;
				}
				if (!wc.wake_id_claimed) {
					wc.wake_id_claimed = true;
					if (wc.wake_cycle_span) recordStateTransition(wc.wake_cycle_span, `WAKING`, `LIVE`);
				}
				deliverSpan.end();
				return;
			}
			deliverSpan.setStatus({
				code: __opentelemetry_api.SpanStatusCode.ERROR,
				message: `HTTP ${response.status}`
			});
			deliverSpan.end();
			if (!wc.wake_id_claimed) this.scheduleRetry(wc, sub, payload, token);
		} catch (err) {
			clearTimeout(timeoutId);
			deliverSpan.setStatus({
				code: __opentelemetry_api.SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : `Unknown error`
			});
			deliverSpan.end();
			const now = Date.now();
			wc.last_webhook_failure_at = now;
			if (!wc.first_webhook_failure_at) wc.first_webhook_failure_at = now;
			if (wc.first_webhook_failure_at && now - wc.first_webhook_failure_at > GC_FAILURE_MS) {
				this.consumerManager.deleteConsumer(wc.consumer_id);
				this.store.removeWebhookConsumer(wc.consumer_id);
				return;
			}
			const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id);
			if (l1Consumer && l1Consumer.state === `READING` && !wc.wake_id_claimed) this.scheduleRetry(wc, sub, payload, token);
		}
	}
	scheduleRetry(wc, sub, payload, token) {
		if (this.isShuttingDown) return;
		wc.retry_count++;
		const delay = this.calculateRetryDelay(wc.retry_count);
		if (wc.wake_cycle_span) wc.wake_cycle_span.addEvent(EVENT.RETRY_SCHEDULED, {
			[ATTR.RETRY_COUNT]: wc.retry_count,
			delay_ms: delay
		});
		wc.retry_timer = setTimeout(() => {
			wc.retry_timer = null;
			const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id);
			if (l1Consumer && l1Consumer.state === `READING` && !wc.wake_id_claimed && !this.isShuttingDown) this.deliverWebhook(wc, sub, payload, token);
		}, delay);
	}
	/**
	* Exponential backoff with jitter, capping at MAX_RETRY_DELAY_MS,
	* then settling to STEADY_RETRY_DELAY_MS.
	*/
	calculateRetryDelay(retryCount) {
		if (retryCount > 10) return STEADY_RETRY_DELAY_MS + Math.random() * 5e3;
		const base = Math.min(Math.pow(2, retryCount) * 100, MAX_RETRY_DELAY_MS);
		return base + Math.random() * 1e3;
	}
	/**
	* Process a callback request. Returns the response to send.
	*/
	async handleCallback(consumerId, token, request) {
		const wc = this.store.getWebhookConsumer(consumerId);
		if (!wc) return {
			ok: false,
			error: {
				code: `CONSUMER_GONE`,
				message: `Consumer instance not found`
			}
		};
		const l1Consumer = this.consumerManager.store.getConsumer(consumerId);
		if (!l1Consumer) return {
			ok: false,
			error: {
				code: `CONSUMER_GONE`,
				message: `Consumer instance not found`
			}
		};
		const parentCtx = wc.wake_cycle_ctx ?? __opentelemetry_api.context.active();
		let callbackAction;
		if (request.done) callbackAction = `done`;
		else if (request.wakeId) callbackAction = `claim`;
		else if (request.acks) callbackAction = `ack`;
		else callbackAction = `other`;
		const callbackSpan = tracer.startSpan(SPAN_CONSUMER_CALLBACK, { attributes: {
			[ATTR.CONSUMER_ID]: consumerId,
			[ATTR.EPOCH]: l1Consumer.epoch,
			[ATTR.CALLBACK_ACTION]: callbackAction
		} }, parentCtx);
		const tokenResult = validateCallbackToken(token, consumerId);
		if (!tokenResult.valid) {
			const newToken = generateCallbackToken(consumerId, l1Consumer.epoch);
			callbackSpan.setStatus({
				code: __opentelemetry_api.SpanStatusCode.ERROR,
				message: tokenResult.code
			});
			callbackSpan.end();
			if (tokenResult.code === `TOKEN_EXPIRED`) return {
				ok: false,
				error: {
					code: `TOKEN_EXPIRED`,
					message: `Callback token has expired`
				},
				claimToken: newToken,
				token: newToken
			};
			return {
				ok: false,
				error: {
					code: `TOKEN_INVALID`,
					message: `Callback token is invalid`
				}
			};
		}
		if (request.epoch !== l1Consumer.epoch) {
			const newToken = generateCallbackToken(consumerId, l1Consumer.epoch);
			callbackSpan.setStatus({
				code: __opentelemetry_api.SpanStatusCode.ERROR,
				message: `STALE_EPOCH`
			});
			callbackSpan.end();
			return {
				ok: false,
				error: {
					code: `STALE_EPOCH`,
					message: `Consumer epoch ${request.epoch} does not match current epoch ${l1Consumer.epoch}`
				},
				claimToken: newToken,
				token: newToken
			};
		}
		if (request.wakeId) {
			if (!this.store.claimWakeId(wc, request.wakeId)) {
				const newToken = generateCallbackToken(consumerId, l1Consumer.epoch);
				callbackSpan.setStatus({
					code: __opentelemetry_api.SpanStatusCode.ERROR,
					message: `ALREADY_CLAIMED`
				});
				callbackSpan.end();
				return {
					ok: false,
					error: {
						code: `ALREADY_CLAIMED`,
						message: `Wake ID ${request.wakeId} is invalid or already claimed`
					},
					claimToken: newToken,
					token: newToken
				};
			}
			callbackSpan.addEvent(EVENT.WAKE_CLAIMED);
			if (wc.wake_cycle_span) recordStateTransition(wc.wake_cycle_span, `WAKING`, `LIVE`);
		}
		this.consumerManager.ack(consumerId, token, { offsets: [] });
		if (request.acks) {
			const validAcks = request.acks.filter((a) => l1Consumer.streams.has(a.path));
			if (validAcks.length > 0) {
				const ackResult = this.consumerManager.ack(consumerId, token, { offsets: validAcks });
				if (`error` in ackResult) {
					callbackSpan.setStatus({
						code: __opentelemetry_api.SpanStatusCode.ERROR,
						message: ackResult.error.code
					});
					callbackSpan.end();
					return {
						ok: false,
						error: {
							code: mapAckErrorToCallbackError(ackResult.error),
							message: ackResult.error.message
						}
					};
				}
			}
			callbackSpan.addEvent(EVENT.ACKS_PROCESSED, { count: request.acks.length });
		}
		if (request.subscribe) {
			this.consumerManager.store.addStreams(l1Consumer, request.subscribe, this.getTailOffset);
			for (const path of request.subscribe) this.store.addStreamIndex(path, consumerId);
		}
		if (request.unsubscribe) {
			const shouldRemove = this.consumerManager.store.removeStreams(l1Consumer, request.unsubscribe);
			for (const path of request.unsubscribe) this.store.removeStreamIndex(path, consumerId);
			if (shouldRemove) {
				callbackSpan.end();
				this.consumerManager.deleteConsumer(consumerId);
				this.store.removeWebhookConsumer(consumerId);
				return {
					ok: false,
					error: {
						code: `CONSUMER_GONE`,
						message: `Consumer removed after unsubscribing from all streams`
					}
				};
			}
			if (request.unsubscribe.includes(wc.primary_stream)) {
				const nextStream = l1Consumer.streams.keys().next().value;
				if (nextStream) wc.primary_stream = nextStream;
			}
		}
		if (request.done) if (this.consumerManager.hasPendingWork(consumerId)) {
			callbackSpan.addEvent(EVENT.DONE_WITH_REWAKE);
			callbackSpan.end();
			this.consumerManager.release(consumerId, token);
			this.transitionToIdle(wc);
			this.wakeConsumer(wc, [wc.primary_stream]);
		} else {
			callbackSpan.addEvent(EVENT.DONE_RECEIVED);
			callbackSpan.end();
			this.consumerManager.release(consumerId, token);
			this.transitionToIdle(wc);
		}
		else callbackSpan.end();
		const responseToken = tokenNeedsRefresh(tokenResult.exp) ? generateCallbackToken(consumerId, l1Consumer.epoch) : token;
		if (responseToken !== token && wc.wake_cycle_span) wc.wake_cycle_span.addEvent(EVENT.TOKEN_REFRESHED);
		let entityWriteToken;
		if (request.wakeId && this.getEntityWriteToken) entityWriteToken = await this.getEntityWriteToken(wc.primary_stream);
		return {
			ok: true,
			claimToken: responseToken,
			token: responseToken,
			streams: this.consumerManager.store.getStreamsData(l1Consumer),
			...entityWriteToken && { writeToken: entityWriteToken }
		};
	}
	/**
	* Transition L2 webhook consumer to idle: clear wake state and end span.
	*/
	transitionToIdle(wc) {
		wc.wake_id = null;
		wc.wake_id_claimed = false;
		if (wc.wake_cycle_span) {
			recordStateTransition(wc.wake_cycle_span, `LIVE`, `IDLE`);
			wc.wake_cycle_span.end();
			wc.wake_cycle_span = null;
			wc.wake_cycle_ctx = null;
		}
	}
	/**
	* Delete a subscription and cascade to both L2 and L1 state.
	* Must be used instead of store.deleteSubscription() directly.
	*/
	deleteSubscription(subscriptionId) {
		const consumerIds = this.store.getConsumersForSubscription(subscriptionId);
		for (const cid of consumerIds) this.consumerManager.deleteConsumer(cid);
		return this.store.deleteSubscription(subscriptionId);
	}
	/**
	* Get or create both L1 consumer and L2 webhook consumer.
	*/
	getOrCreateWebhookConsumer(subscriptionId, streamPath) {
		const consumerId = WebhookStore.buildConsumerId(subscriptionId, streamPath);
		this.consumerManager.registerConsumer(consumerId, [streamPath]);
		return this.store.createWebhookConsumer(consumerId, subscriptionId, streamPath);
	}
	setDirectWebhookPreference(consumerId, webhookUrl) {
		const consumer = this.consumerManager.store.getConsumer(consumerId);
		if (!consumer) return false;
		const existing = this.directWebhookConfigs.get(consumerId);
		this.directWebhookConfigs.set(consumerId, {
			webhook: webhookUrl,
			webhook_secret: existing?.webhook_secret ?? generateWebhookSecret()
		});
		const directSubscriptionId = this.getDirectSubscriptionId(consumerId);
		const primaryStream = consumer.streams.keys().next().value;
		if (!primaryStream) return false;
		const wc = this.store.createWebhookConsumer(consumerId, directSubscriptionId, primaryStream);
		wc.primary_stream = primaryStream;
		if (consumer.state === `REGISTERED` && this.consumerManager.hasPendingWork(consumerId)) this.wakeConsumer(wc, [primaryStream]).catch(() => {});
		return true;
	}
	clearDirectWebhookPreference(consumerId) {
		this.directWebhookConfigs.delete(consumerId);
		const wc = this.store.getWebhookConsumer(consumerId);
		if (wc && wc.subscription_id === this.getDirectSubscriptionId(consumerId)) this.store.removeWebhookConsumer(consumerId);
	}
	buildCallbackUrl(consumerId) {
		return `${this.callbackBaseUrl}/callback/${consumerId}`;
	}
	getDirectSubscriptionId(consumerId) {
		return `__direct__:${consumerId}`;
	}
	getDeliveryTarget(wc) {
		const direct = this.directWebhookConfigs.get(wc.consumer_id);
		if (direct) return direct;
		const sub = this.store.getSubscription(wc.subscription_id);
		if (!sub) return null;
		return {
			webhook: sub.webhook,
			webhook_secret: sub.webhook_secret
		};
	}
	/**
	* Shut down the manager: cancel all timers.
	*/
	shutdown() {
		this.isShuttingDown = true;
		for (const wc of this.store.getAllWebhookConsumers()) if (wc.wake_cycle_span) {
			endWakeCycleSpan(wc.wake_cycle_span, EVENT.SERVER_SHUTDOWN);
			wc.wake_cycle_span = null;
			wc.wake_cycle_ctx = null;
		}
		this.store.shutdown();
	}
};

//#endregion
//#region src/webhook-routes.ts
const ERROR_CODE_TO_STATUS = {
	INVALID_REQUEST: 400,
	TOKEN_EXPIRED: 401,
	TOKEN_INVALID: 401,
	ALREADY_CLAIMED: 409,
	INVALID_OFFSET: 409,
	STALE_EPOCH: 409,
	CONSUMER_GONE: 410
};
/**
* Serialize a subscription for API responses, omitting internal fields.
*/
function serializeSubscription(sub) {
	return {
		subscription_id: sub.subscription_id,
		pattern: sub.pattern,
		webhook: sub.webhook,
		description: sub.description
	};
}
/**
* Handles webhook-related HTTP routes.
*/
var WebhookRoutes = class {
	manager;
	constructor(manager) {
		this.manager = manager;
	}
	/**
	* Try to handle a request as a webhook route.
	* Returns true if the request was handled, false if it should be passed through.
	*/
	async handleRequest(method, url, path, req, res) {
		if (path.startsWith(`/callback/`)) {
			await this.handleCallback(path, req, res);
			return true;
		}
		const hasSubscription = url.searchParams.has(`subscription`);
		const hasSubscriptions = url.searchParams.has(`subscriptions`);
		if (!hasSubscription && !hasSubscriptions) return false;
		if (hasSubscription) {
			const subscriptionId = url.searchParams.get(`subscription`);
			switch (method) {
				case `PUT`:
					await this.handleCreateSubscription(path, subscriptionId, req, res);
					return true;
				case `GET`:
					this.handleGetSubscription(subscriptionId, res);
					return true;
				case `DELETE`:
					this.handleDeleteSubscription(subscriptionId, res);
					return true;
				default:
					res.writeHead(405, { "content-type": `text/plain` });
					res.end(`Method not allowed`);
					return true;
			}
		}
		if (hasSubscriptions && method === `GET`) {
			this.handleListSubscriptions(path, res);
			return true;
		}
		return false;
	}
	async handleCreateSubscription(pattern, subscriptionId, req, res) {
		const body = await this.readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body));
		} catch {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`Invalid JSON body`);
			return;
		}
		if (!parsed.webhook) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`Missing required field: webhook`);
			return;
		}
		try {
			const { subscription, created } = this.manager.store.createSubscription(subscriptionId, pattern, parsed.webhook, parsed.description);
			const responseBody = serializeSubscription(subscription);
			if (created) responseBody.webhook_secret = subscription.webhook_secret;
			res.writeHead(created ? 201 : 200, { "content-type": `application/json` });
			res.end(JSON.stringify(responseBody));
		} catch (err) {
			if (err instanceof Error && err.message.includes(`different configuration`)) {
				res.writeHead(409, { "content-type": `text/plain` });
				res.end(`Subscription already exists with different configuration`);
			} else throw err;
		}
	}
	handleGetSubscription(subscriptionId, res) {
		const sub = this.manager.store.getSubscription(subscriptionId);
		if (!sub) {
			res.writeHead(404, { "content-type": `text/plain` });
			res.end(`Subscription not found`);
			return;
		}
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify(serializeSubscription(sub)));
	}
	handleDeleteSubscription(subscriptionId, res) {
		this.manager.deleteSubscription(subscriptionId);
		res.writeHead(204);
		res.end();
	}
	handleListSubscriptions(pattern, res) {
		const subs = this.manager.store.listSubscriptions(pattern);
		const sanitized = subs.map(serializeSubscription);
		res.writeHead(200, { "content-type": `application/json` });
		res.end(JSON.stringify({ subscriptions: sanitized }));
	}
	async handleCallback(path, req, res) {
		const consumerId = path.slice(`/callback/`.length);
		const authHeader = req.headers[`authorization`];
		if (!authHeader || !authHeader.startsWith(`Bearer `)) {
			res.writeHead(401, { "content-type": `application/json` });
			res.end(JSON.stringify({
				ok: false,
				error: {
					code: `TOKEN_INVALID`,
					message: `Missing or malformed Authorization header`
				}
			}));
			return;
		}
		const token = authHeader.slice(`Bearer `.length);
		const body = await this.readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body));
		} catch {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({
				ok: false,
				error: {
					code: `INVALID_REQUEST`,
					message: `Invalid JSON body`
				}
			}));
			return;
		}
		if (parsed.epoch === void 0) {
			res.writeHead(400, { "content-type": `application/json` });
			res.end(JSON.stringify({
				ok: false,
				error: {
					code: `INVALID_REQUEST`,
					message: `Missing required field: epoch`
				}
			}));
			return;
		}
		const rawWakeId = parsed.wakeId ?? parsed.wake_id;
		const request = {
			...parsed,
			wakeId: typeof rawWakeId === `string` ? rawWakeId : void 0
		};
		const result = await this.manager.handleCallback(consumerId, token, request);
		const status = result.ok ? 200 : ERROR_CODE_TO_STATUS[result.error.code] ?? 500;
		res.writeHead(status, { "content-type": `application/json` });
		res.end(JSON.stringify(result));
	}
	readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			req.on(`data`, (chunk) => chunks.push(chunk));
			req.on(`end`, () => resolve(new Uint8Array(Buffer.concat(chunks))));
			req.on(`error`, reject);
		});
	}
};

//#endregion
//#region src/server.ts
const STREAM_SSE_DATA_ENCODING_HEADER = `Stream-SSE-Data-Encoding`;
const SSE_UP_TO_DATE_FIELD = `upToDate`;
const STREAM_FORKED_FROM_HEADER = `Stream-Forked-From`;
const STREAM_FORK_OFFSET_HEADER = `Stream-Fork-Offset`;
const STREAM_FORK_SUB_OFFSET_HEADER = `Stream-Fork-Sub-Offset`;
/**
* Encode data for SSE format.
* Per SSE spec, each line in the payload needs its own "data:" prefix.
* Line terminators in the payload (CR, LF, or CRLF) become separate data: lines.
* This prevents CRLF injection attacks where malicious payloads could inject
* fake SSE events using CR-only line terminators.
*
* Note: We don't add a space after "data:" because clients strip exactly one
* leading space per the SSE spec. Adding one would cause data starting with
* spaces to lose an extra space character.
*/
function encodeSSEData(payload) {
	const lines = payload.split(/\r\n|\r|\n/);
	return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`;
}
/**
* Minimum response size to consider for compression.
* Responses smaller than this won't benefit from compression.
*/
const COMPRESSION_THRESHOLD = 1024;
/**
* Determine the best compression encoding from Accept-Encoding header.
* Returns 'gzip', 'deflate', or null if no compression should be used.
*/
function getCompressionEncoding(acceptEncoding) {
	if (!acceptEncoding) return null;
	const encodings = acceptEncoding.toLowerCase().split(`,`).map((e) => e.trim());
	for (const encoding of encodings) {
		const name = encoding.split(`;`)[0]?.trim();
		if (name === `gzip`) return `gzip`;
	}
	for (const encoding of encodings) {
		const name = encoding.split(`;`)[0]?.trim();
		if (name === `deflate`) return `deflate`;
	}
	return null;
}
/**
* Compress data using the specified encoding.
*/
function compressData(data, encoding) {
	if (encoding === `gzip`) return (0, node_zlib.gzipSync)(data);
	else return (0, node_zlib.deflateSync)(data);
}
var DurableStreamTestServer = class {
	store;
	server = null;
	options;
	_url = null;
	activeSSEResponses = new Set();
	isShuttingDown = false;
	/** Injected faults for testing retry/resilience */
	injectedFaults = new Map();
	consumerManager = null;
	consumerRoutes = null;
	pullWakeManager = null;
	subscriptionManager = null;
	subscriptionRoutes = null;
	webhookManager = null;
	webhookRoutes = null;
	constructor(options = {}) {
		if (options.dataDir) this.store = new FileBackedStreamStore({ dataDir: options.dataDir });
		else this.store = new StreamStore();
		this.options = {
			port: options.port ?? 4437,
			host: options.host ?? `127.0.0.1`,
			longPollTimeout: options.longPollTimeout ?? 3e4,
			dataDir: options.dataDir,
			onStreamCreated: options.onStreamCreated,
			onStreamDeleted: options.onStreamDeleted,
			compression: options.compression ?? true,
			cursorOptions: {
				intervalSeconds: options.cursorIntervalSeconds,
				epoch: options.cursorEpoch
			},
			webhooks: options.webhooks ?? false
		};
	}
	/**
	* Start the server.
	*/
	async start() {
		if (this.server) throw new Error(`Server already started`);
		return new Promise((resolve, reject) => {
			this.server = (0, node_http.createServer)((req, res) => {
				this.handleRequest(req, res).catch((err) => {
					serverLog.error(`Request error:`, err);
					if (!res.headersSent) {
						res.writeHead(500, { "content-type": `text/plain` });
						res.end(`Internal server error`);
					}
				});
			});
			this.server.on(`error`, reject);
			this.server.listen(this.options.port, this.options.host, () => {
				const addr = this.server.address();
				if (typeof addr === `string`) this._url = addr;
				else if (addr) this._url = `http://${this.options.host}:${addr.port}`;
				this.subscriptionManager = new SubscriptionManager({
					callbackBaseUrl: this._url,
					streamStore: this.store,
					webhooksEnabled: this.options.webhooks
				});
				this.subscriptionRoutes = new SubscriptionRoutes(this.subscriptionManager);
				this.consumerManager = new ConsumerManager({ getTailOffset: (path) => {
					const stream = this.store.get(path);
					return stream ? stream.currentOffset : `-1`;
				} });
				this.pullWakeManager = new PullWakeManager({
					consumerManager: this.consumerManager,
					streamStore: this.store
				});
				if (this.options.webhooks) {
					this.webhookManager = new WebhookManager({
						callbackBaseUrl: this._url,
						getTailOffset: (path) => {
							const stream = this.store.get(path);
							return stream ? stream.currentOffset : `-1`;
						},
						consumerManager: this.consumerManager
					});
					this.webhookRoutes = new WebhookRoutes(this.webhookManager);
				}
				this.consumerRoutes = new ConsumerRoutes(this.consumerManager, {
					webhookManager: this.webhookManager,
					pullWakeManager: this.pullWakeManager
				});
				resolve(this._url);
			});
		});
	}
	/**
	* Stop the server.
	*/
	async stop() {
		if (!this.server) return;
		this.isShuttingDown = true;
		if (this.pullWakeManager) {
			this.pullWakeManager.shutdown();
			this.pullWakeManager = null;
		}
		if (this.consumerManager) {
			this.consumerManager.shutdown();
			this.consumerManager = null;
			this.consumerRoutes = null;
		}
		if (this.webhookManager) {
			this.webhookManager.shutdown();
			this.webhookManager = null;
			this.webhookRoutes = null;
		}
		if (this.subscriptionManager) {
			this.subscriptionManager.shutdown();
			this.subscriptionManager = null;
			this.subscriptionRoutes = null;
		}
		if (`cancelAllWaits` in this.store) this.store.cancelAllWaits();
		for (const res of this.activeSSEResponses) res.end();
		this.activeSSEResponses.clear();
		return new Promise((resolve, reject) => {
			this.server.close(async (err) => {
				if (err) {
					reject(err);
					return;
				}
				try {
					if (this.store instanceof FileBackedStreamStore) await this.store.close();
					this.server = null;
					this._url = null;
					this.isShuttingDown = false;
					resolve();
				} catch (closeErr) {
					reject(closeErr);
				}
			});
		});
	}
	/**
	* Get the server URL.
	*/
	get url() {
		if (!this._url) throw new Error(`Server not started`);
		return this._url;
	}
	/**
	* Clear all streams.
	*/
	clear() {
		this.store.clear();
	}
	/**
	* Inject an error to be returned on the next N requests to a path.
	* Used for testing retry/resilience behavior.
	* @deprecated Use injectFault for full fault injection capabilities
	*/
	injectError(path, status, count = 1, retryAfter) {
		this.injectedFaults.set(path, {
			status,
			count,
			retryAfter
		});
	}
	/**
	* Inject a fault to be triggered on the next N requests to a path.
	* Supports various fault types: delays, connection drops, body corruption, etc.
	*/
	injectFault(path, fault) {
		this.injectedFaults.set(path, {
			count: 1,
			...fault
		});
	}
	/**
	* Clear all injected faults.
	*/
	clearInjectedFaults() {
		this.injectedFaults.clear();
	}
	setEnrichPayload(fn) {
		if (this.webhookManager) this.webhookManager.enrichPayload = fn;
	}
	/**
	* Check if there's an injected fault for this path/method and consume it.
	* Returns the fault config if one should be triggered, null otherwise.
	*/
	consumeInjectedFault(path, method) {
		const fault = this.injectedFaults.get(path);
		if (!fault) return null;
		if (fault.method && fault.method.toUpperCase() !== method.toUpperCase()) return null;
		if (fault.probability !== void 0 && Math.random() > fault.probability) return null;
		fault.count--;
		if (fault.count <= 0) this.injectedFaults.delete(path);
		return fault;
	}
	/**
	* Apply delay from fault config (including jitter).
	*/
	async applyFaultDelay(fault) {
		if (fault.delayMs !== void 0 && fault.delayMs > 0) {
			const jitter = fault.jitterMs ? Math.random() * fault.jitterMs : 0;
			await new Promise((resolve) => setTimeout(resolve, fault.delayMs + jitter));
		}
	}
	/**
	* Apply body modifications from stored fault (truncation, corruption).
	* Returns modified body, or original if no modifications needed.
	*/
	applyFaultBodyModification(res, body) {
		const fault = res._injectedFault;
		if (!fault) return body;
		let modified = body;
		if (fault.truncateBodyBytes !== void 0 && modified.length > fault.truncateBodyBytes) modified = modified.slice(0, fault.truncateBodyBytes);
		if (fault.corruptBody && modified.length > 0) {
			modified = new Uint8Array(modified);
			modified[0] = 88;
			if (modified.length > 1) modified[1] = 89;
			const numCorrupt = Math.max(1, Math.floor(modified.length * .1));
			for (let i = 0; i < numCorrupt; i++) {
				const pos = Math.floor(Math.random() * modified.length);
				modified[pos] = 90;
			}
		}
		return modified;
	}
	async handleRequest(req, res) {
		const url = new URL(req.url ?? `/`, `http://${req.headers.host}`);
		const path = url.pathname;
		const method = req.method?.toUpperCase();
		res.setHeader(`access-control-allow-origin`, `*`);
		res.setHeader(`access-control-allow-methods`, `GET, POST, PUT, DELETE, HEAD, OPTIONS`);
		res.setHeader(`access-control-allow-headers`, `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq, Stream-Forked-From, Stream-Fork-Offset, Stream-Fork-Sub-Offset`);
		res.setHeader(`access-control-expose-headers`, `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`);
		res.setHeader(`x-content-type-options`, `nosniff`);
		res.setHeader(`cross-origin-resource-policy`, `cross-origin`);
		if (method === `OPTIONS`) {
			res.writeHead(204);
			res.end();
			return;
		}
		if (path === `/_test/inject-error`) {
			await this.handleTestInjectError(method, req, res);
			return;
		}
		const fault = this.consumeInjectedFault(path, method ?? `GET`);
		if (fault) {
			await this.applyFaultDelay(fault);
			if (fault.dropConnection) {
				res.socket?.destroy();
				return;
			}
			if (fault.status !== void 0) {
				const headers = { "content-type": `text/plain` };
				if (fault.retryAfter !== void 0) headers[`retry-after`] = fault.retryAfter.toString();
				res.writeHead(fault.status, headers);
				res.end(`Injected error for testing`);
				return;
			}
			if (fault.truncateBodyBytes !== void 0 || fault.corruptBody || fault.injectSseEvent) res._injectedFault = fault;
		}
		if (this.subscriptionRoutes && method) {
			const handled = await this.subscriptionRoutes.handleRequest(method, path, req, res);
			if (handled) return;
		}
		if (this.consumerRoutes && method) {
			const handled = await this.consumerRoutes.handleRequest(method, path, req, res);
			if (handled) return;
		}
		if (this.webhookRoutes && method) {
			const handled = await this.webhookRoutes.handleRequest(method, url, path, req, res);
			if (handled) return;
		}
		try {
			switch (method) {
				case `PUT`:
					await this.handleCreate(path, req, res);
					break;
				case `HEAD`:
					this.handleHead(path, res);
					break;
				case `GET`:
					await this.handleRead(path, url, req, res);
					break;
				case `POST`:
					await this.handleAppend(path, req, res);
					break;
				case `DELETE`:
					await this.handleDelete(path, res);
					break;
				default:
					res.writeHead(405, { "content-type": `text/plain` });
					res.end(`Method not allowed`);
			}
		} catch (err) {
			if (err instanceof Error) if (err.message.includes(`active forks`)) {
				res.writeHead(409, { "content-type": `text/plain` });
				res.end(`stream was deleted but still has active forks — path cannot be reused until all forks are removed`);
			} else if (err.message.includes(`soft-deleted`)) {
				res.writeHead(410, { "content-type": `text/plain` });
				res.end(`Stream is gone`);
			} else if (err.message.includes(`not found`)) {
				res.writeHead(404, { "content-type": `text/plain` });
				res.end(`Stream not found`);
			} else if (err.message.includes(`already exists with different configuration`)) {
				res.writeHead(409, { "content-type": `text/plain` });
				res.end(`Stream already exists with different configuration`);
			} else if (err.message.includes(`Sequence conflict`)) {
				res.writeHead(409, { "content-type": `text/plain` });
				res.end(`Sequence conflict`);
			} else if (err.message.includes(`Content-type mismatch`)) {
				res.writeHead(409, { "content-type": `text/plain` });
				res.end(`Content-type mismatch`);
			} else if (err.message.includes(`Invalid JSON`)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid JSON`);
			} else if (err.message.includes(`Empty arrays are not allowed`)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Empty arrays are not allowed`);
			} else throw err;
			else throw err;
		}
	}
	/**
	* Handle PUT - create stream
	*/
	async handleCreate(path, req, res) {
		let contentType = req.headers[`content-type`];
		const forkedFromHeader = req.headers[STREAM_FORKED_FROM_HEADER.toLowerCase()];
		const forkOffsetHeader = req.headers[STREAM_FORK_OFFSET_HEADER.toLowerCase()];
		const forkSubOffsetHeaderRaw = req.headers[STREAM_FORK_SUB_OFFSET_HEADER.toLowerCase()];
		const forkSubOffsetHeaderPresent = forkSubOffsetHeaderRaw !== void 0;
		const forkSubOffsetHeader = Array.isArray(forkSubOffsetHeaderRaw) ? forkSubOffsetHeaderRaw[0] : forkSubOffsetHeaderRaw;
		if (!contentType || contentType.trim() === `` || !/^[\w-]+\/[\w-]+/.test(contentType)) contentType = forkedFromHeader ? void 0 : `application/octet-stream`;
		const ttlHeader = req.headers[__durable_streams_client.STREAM_TTL_HEADER.toLowerCase()];
		const expiresAtHeader = req.headers[__durable_streams_client.STREAM_EXPIRES_AT_HEADER.toLowerCase()];
		const closedHeader = req.headers[__durable_streams_client.STREAM_CLOSED_HEADER.toLowerCase()];
		const createClosed = closedHeader === `true`;
		if (ttlHeader && expiresAtHeader) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`Cannot specify both Stream-TTL and Stream-Expires-At`);
			return;
		}
		let ttlSeconds;
		if (ttlHeader) {
			const ttlPattern = /^(0|[1-9]\d*)$/;
			if (!ttlPattern.test(ttlHeader)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Stream-TTL value`);
				return;
			}
			ttlSeconds = parseInt(ttlHeader, 10);
			if (isNaN(ttlSeconds) || ttlSeconds < 0) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Stream-TTL value`);
				return;
			}
		}
		if (expiresAtHeader) {
			const timestamp = new Date(expiresAtHeader);
			if (isNaN(timestamp.getTime())) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Stream-Expires-At timestamp`);
				return;
			}
		}
		if (forkOffsetHeader) {
			const validOffsetPattern = /^\d+_\d+$/;
			if (!validOffsetPattern.test(forkOffsetHeader)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Stream-Fork-Offset format`);
				return;
			}
		}
		let forkSubOffset;
		if (forkSubOffsetHeaderPresent) {
			if (!forkedFromHeader) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Stream-Fork-Sub-Offset requires Stream-Forked-From`);
				return;
			}
			const subOffsetPattern = /^(0|[1-9]\d*)$/;
			if (forkSubOffsetHeader === void 0 || !subOffsetPattern.test(forkSubOffsetHeader)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Stream-Fork-Sub-Offset format`);
				return;
			}
			forkSubOffset = parseInt(forkSubOffsetHeader, 10);
		}
		const body = await this.readBody(req);
		const isNew = !this.store.has(path);
		try {
			await Promise.resolve(this.store.create(path, {
				contentType,
				ttlSeconds,
				expiresAt: expiresAtHeader,
				initialData: body.length > 0 ? body : void 0,
				closed: createClosed,
				forkedFrom: forkedFromHeader,
				forkOffset: forkOffsetHeader,
				forkSubOffset
			}));
		} catch (err) {
			if (err instanceof Error) {
				if (err.message.includes(`Source stream not found`)) {
					res.writeHead(404, { "content-type": `text/plain` });
					res.end(`Source stream not found`);
					return;
				}
				if (err.message.includes(`Invalid fork sub-offset`)) {
					res.writeHead(400, { "content-type": `text/plain` });
					res.end(`Invalid fork sub-offset`);
					return;
				}
				if (err.message.includes(`Invalid fork offset`)) {
					res.writeHead(400, { "content-type": `text/plain` });
					res.end(`Fork offset beyond source stream length`);
					return;
				}
				if (err.message.includes(`soft-deleted`)) {
					res.writeHead(409, { "content-type": `text/plain` });
					res.end(`source stream was deleted but still has active forks`);
					return;
				}
				if (err.message.includes(`Content type mismatch`)) {
					res.writeHead(409, { "content-type": `text/plain` });
					res.end(`Content type mismatch with source stream`);
					return;
				}
			}
			throw err;
		}
		const stream = this.store.get(path);
		const resolvedContentType = stream.contentType ?? contentType ?? `application/octet-stream`;
		if (isNew && this.options.onStreamCreated) await Promise.resolve(this.options.onStreamCreated({
			type: `created`,
			path,
			contentType: resolvedContentType,
			timestamp: Date.now()
		}));
		if (isNew && this.webhookManager) this.webhookManager.onStreamCreated(path);
		if (isNew && body.length > 0) await this.notifyStreamAppend(path);
		const headers = {
			"content-type": resolvedContentType,
			[__durable_streams_client.STREAM_OFFSET_HEADER]: stream.currentOffset
		};
		if (isNew) headers[`location`] = `${this._url}${path}`;
		if (stream.closed) headers[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
		res.writeHead(isNew ? 201 : 200, headers);
		res.end();
	}
	/**
	* Handle HEAD - get metadata
	*/
	handleHead(path, res) {
		const stream = this.store.get(path);
		if (!stream) {
			res.writeHead(404, { "content-type": `text/plain` });
			res.end();
			return;
		}
		if (stream.softDeleted) {
			res.writeHead(410, { "content-type": `text/plain` });
			res.end();
			return;
		}
		const headers = {
			[__durable_streams_client.STREAM_OFFSET_HEADER]: stream.currentOffset,
			"cache-control": `no-store`
		};
		if (stream.contentType) headers[`content-type`] = stream.contentType;
		if (stream.closed) headers[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
		if (stream.ttlSeconds !== void 0) headers[__durable_streams_client.STREAM_TTL_HEADER] = String(stream.ttlSeconds);
		if (stream.expiresAt) headers[__durable_streams_client.STREAM_EXPIRES_AT_HEADER] = stream.expiresAt;
		const closedSuffix = stream.closed ? `:c` : ``;
		headers[`etag`] = `"${Buffer.from(path).toString(`base64`)}:-1:${stream.currentOffset}${closedSuffix}"`;
		res.writeHead(200, headers);
		res.end();
	}
	/**
	* Handle GET - read data
	*/
	async handleRead(path, url, req, res) {
		const stream = this.store.get(path);
		if (!stream) {
			res.writeHead(404, { "content-type": `text/plain` });
			res.end(`Stream not found`);
			return;
		}
		if (stream.softDeleted) {
			res.writeHead(410, { "content-type": `text/plain` });
			res.end(`Stream is gone`);
			return;
		}
		const offset = url.searchParams.get(__durable_streams_client.OFFSET_QUERY_PARAM) ?? void 0;
		const live = url.searchParams.get(__durable_streams_client.LIVE_QUERY_PARAM);
		const cursor = url.searchParams.get(__durable_streams_client.CURSOR_QUERY_PARAM) ?? void 0;
		if (offset !== void 0) {
			if (offset === ``) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Empty offset parameter`);
				return;
			}
			const allOffsets = url.searchParams.getAll(__durable_streams_client.OFFSET_QUERY_PARAM);
			if (allOffsets.length > 1) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Multiple offset parameters not allowed`);
				return;
			}
			const validOffsetPattern = /^(-1|now|\d+_\d+)$/;
			if (!validOffsetPattern.test(offset)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid offset format`);
				return;
			}
		}
		if ((live === `long-poll` || live === `sse`) && !offset) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`${live === `sse` ? `SSE` : `Long-poll`} requires offset parameter`);
			return;
		}
		let useBase64 = false;
		if (live === `sse`) {
			const ct = stream.contentType?.toLowerCase().split(`;`)[0]?.trim() ?? ``;
			const isTextCompatible = ct.startsWith(`text/`) || ct === `application/json`;
			useBase64 = !isTextCompatible;
		}
		if (live === `sse`) {
			const sseOffset = offset === `now` ? stream.currentOffset : offset;
			await this.handleSSE(path, stream, sseOffset, cursor, useBase64, res);
			return;
		}
		const effectiveOffset = offset === `now` ? stream.currentOffset : offset;
		if (offset === `now` && live !== `long-poll`) {
			const headers$1 = {
				[__durable_streams_client.STREAM_OFFSET_HEADER]: stream.currentOffset,
				[__durable_streams_client.STREAM_UP_TO_DATE_HEADER]: `true`,
				[`cache-control`]: `no-store`
			};
			if (stream.contentType) headers$1[`content-type`] = stream.contentType;
			if (stream.closed) headers$1[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
			const isJsonMode = stream.contentType?.includes(`application/json`);
			const responseBody = isJsonMode ? `[]` : ``;
			res.writeHead(200, headers$1);
			res.end(responseBody);
			return;
		}
		let { messages, upToDate } = this.store.read(path, effectiveOffset);
		this.store.touchAccess(path);
		const clientIsCaughtUp = effectiveOffset && effectiveOffset === stream.currentOffset || offset === `now`;
		if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
			if (stream.closed) {
				res.writeHead(204, {
					[__durable_streams_client.STREAM_OFFSET_HEADER]: stream.currentOffset,
					[__durable_streams_client.STREAM_UP_TO_DATE_HEADER]: `true`,
					[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`
				});
				res.end();
				return;
			}
			const result = await this.store.waitForMessages(path, effectiveOffset ?? stream.currentOffset, this.options.longPollTimeout);
			this.store.touchAccess(path);
			if (result.streamClosed) {
				const responseCursor = generateResponseCursor(cursor, this.options.cursorOptions);
				res.writeHead(204, {
					[__durable_streams_client.STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
					[__durable_streams_client.STREAM_UP_TO_DATE_HEADER]: `true`,
					[__durable_streams_client.STREAM_CURSOR_HEADER]: responseCursor,
					[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`
				});
				res.end();
				return;
			}
			if (result.timedOut) {
				const responseCursor = generateResponseCursor(cursor, this.options.cursorOptions);
				const currentStream$1 = this.store.get(path);
				const timeoutHeaders = {
					[__durable_streams_client.STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
					[__durable_streams_client.STREAM_UP_TO_DATE_HEADER]: `true`,
					[__durable_streams_client.STREAM_CURSOR_HEADER]: responseCursor
				};
				if (currentStream$1?.closed) timeoutHeaders[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
				res.writeHead(204, timeoutHeaders);
				res.end();
				return;
			}
			messages = result.messages;
			upToDate = true;
		}
		const headers = {};
		if (stream.contentType) headers[`content-type`] = stream.contentType;
		const lastMessage = messages[messages.length - 1];
		const responseOffset = lastMessage?.offset ?? stream.currentOffset;
		headers[__durable_streams_client.STREAM_OFFSET_HEADER] = responseOffset;
		if (live === `long-poll`) headers[__durable_streams_client.STREAM_CURSOR_HEADER] = generateResponseCursor(cursor, this.options.cursorOptions);
		if (upToDate) headers[__durable_streams_client.STREAM_UP_TO_DATE_HEADER] = `true`;
		const currentStream = this.store.get(path);
		const clientAtTail = responseOffset === currentStream?.currentOffset;
		if (currentStream?.closed && clientAtTail && upToDate) headers[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
		const startOffset = offset ?? `-1`;
		const closedSuffix = currentStream?.closed && clientAtTail && upToDate ? `:c` : ``;
		const etag = `"${Buffer.from(path).toString(`base64`)}:${startOffset}:${responseOffset}${closedSuffix}"`;
		headers[`etag`] = etag;
		const ifNoneMatch = req.headers[`if-none-match`];
		if (ifNoneMatch && ifNoneMatch === etag) {
			res.writeHead(304, { etag });
			res.end();
			return;
		}
		const responseData = this.store.formatResponse(path, messages);
		let finalData = responseData;
		if (this.options.compression && responseData.length >= COMPRESSION_THRESHOLD) {
			const acceptEncoding = req.headers[`accept-encoding`];
			const compressionEncoding = getCompressionEncoding(acceptEncoding);
			if (compressionEncoding) {
				finalData = compressData(responseData, compressionEncoding);
				headers[`content-encoding`] = compressionEncoding;
				headers[`vary`] = `accept-encoding`;
			}
		}
		finalData = this.applyFaultBodyModification(res, finalData);
		res.writeHead(200, headers);
		res.end(Buffer.from(finalData));
	}
	/**
	* Handle SSE (Server-Sent Events) mode
	*/
	async handleSSE(path, stream, initialOffset, cursor, useBase64, res) {
		this.activeSSEResponses.add(res);
		const sseHeaders = {
			"content-type": `text/event-stream`,
			"cache-control": `no-cache`,
			connection: `keep-alive`,
			"access-control-allow-origin": `*`,
			"x-content-type-options": `nosniff`,
			"cross-origin-resource-policy": `cross-origin`
		};
		if (useBase64) sseHeaders[STREAM_SSE_DATA_ENCODING_HEADER] = `base64`;
		res.writeHead(200, sseHeaders);
		const fault = res._injectedFault;
		if (fault?.injectSseEvent) {
			res.write(`event: ${fault.injectSseEvent.eventType}\n`);
			res.write(`data: ${fault.injectSseEvent.data}\n\n`);
		}
		let currentOffset = initialOffset;
		let isConnected = true;
		const decoder = new TextDecoder();
		res.on(`close`, () => {
			isConnected = false;
			this.activeSSEResponses.delete(res);
		});
		const isJsonStream = stream?.contentType?.includes(`application/json`);
		while (isConnected && !this.isShuttingDown) {
			const { messages, upToDate } = this.store.read(path, currentOffset);
			this.store.touchAccess(path);
			for (const message of messages) {
				let dataPayload;
				if (useBase64) dataPayload = Buffer.from(message.data).toString(`base64`);
				else if (isJsonStream) {
					const jsonBytes = this.store.formatResponse(path, [message]);
					dataPayload = decoder.decode(jsonBytes);
				} else dataPayload = decoder.decode(message.data);
				res.write(`event: data\n`);
				res.write(encodeSSEData(dataPayload));
				currentOffset = message.offset;
			}
			const currentStream = this.store.get(path);
			const controlOffset = messages[messages.length - 1]?.offset ?? currentStream.currentOffset;
			const streamIsClosed = currentStream?.closed ?? false;
			const clientAtTail = controlOffset === currentStream.currentOffset;
			const responseCursor = generateResponseCursor(cursor, this.options.cursorOptions);
			const controlData = { [__durable_streams_client.SSE_OFFSET_FIELD]: controlOffset };
			if (streamIsClosed && clientAtTail) controlData[__durable_streams_client.SSE_CLOSED_FIELD] = true;
			else {
				controlData[__durable_streams_client.SSE_CURSOR_FIELD] = responseCursor;
				if (upToDate) controlData[SSE_UP_TO_DATE_FIELD] = true;
			}
			res.write(`event: control\n`);
			res.write(encodeSSEData(JSON.stringify(controlData)));
			if (streamIsClosed && clientAtTail) break;
			currentOffset = controlOffset;
			if (upToDate) {
				if (currentStream?.closed) {
					const finalControlData = {
						[__durable_streams_client.SSE_OFFSET_FIELD]: currentOffset,
						[__durable_streams_client.SSE_CLOSED_FIELD]: true
					};
					res.write(`event: control\n`);
					res.write(encodeSSEData(JSON.stringify(finalControlData)));
					break;
				}
				const result = await this.store.waitForMessages(path, currentOffset, this.options.longPollTimeout);
				this.store.touchAccess(path);
				if (this.isShuttingDown || !isConnected) break;
				if (result.streamClosed && result.messages.length === 0) {
					const finalControlData = {
						[__durable_streams_client.SSE_OFFSET_FIELD]: currentOffset,
						[__durable_streams_client.SSE_CLOSED_FIELD]: true
					};
					res.write(`event: control\n`);
					res.write(encodeSSEData(JSON.stringify(finalControlData)));
					break;
				}
				if (result.timedOut) {
					const keepAliveCursor = generateResponseCursor(cursor, this.options.cursorOptions);
					const streamAfterWait = this.store.get(path);
					if (streamAfterWait?.closed) {
						const closedControlData = {
							[__durable_streams_client.SSE_OFFSET_FIELD]: currentOffset,
							[__durable_streams_client.SSE_CLOSED_FIELD]: true
						};
						res.write(`event: control\n`);
						res.write(encodeSSEData(JSON.stringify(closedControlData)));
						break;
					}
					const keepAliveData = {
						[__durable_streams_client.SSE_OFFSET_FIELD]: currentOffset,
						[__durable_streams_client.SSE_CURSOR_FIELD]: keepAliveCursor,
						[SSE_UP_TO_DATE_FIELD]: true
					};
					res.write(`event: control\n` + encodeSSEData(JSON.stringify(keepAliveData)));
				}
			}
		}
		this.activeSSEResponses.delete(res);
		res.end();
	}
	/**
	* Handle POST - append data
	*/
	async handleAppend(path, req, res) {
		const contentType = req.headers[`content-type`];
		const seq = req.headers[__durable_streams_client.STREAM_SEQ_HEADER.toLowerCase()];
		const closedHeader = req.headers[__durable_streams_client.STREAM_CLOSED_HEADER.toLowerCase()];
		const closeStream = closedHeader === `true`;
		const producerId = req.headers[__durable_streams_client.PRODUCER_ID_HEADER.toLowerCase()];
		const producerEpochStr = req.headers[__durable_streams_client.PRODUCER_EPOCH_HEADER.toLowerCase()];
		const producerSeqStr = req.headers[__durable_streams_client.PRODUCER_SEQ_HEADER.toLowerCase()];
		const hasProducerHeaders = producerId !== void 0 || producerEpochStr !== void 0 || producerSeqStr !== void 0;
		const hasAllProducerHeaders = producerId !== void 0 && producerEpochStr !== void 0 && producerSeqStr !== void 0;
		if (hasProducerHeaders && !hasAllProducerHeaders) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together`);
			return;
		}
		if (hasAllProducerHeaders && producerId === ``) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`Invalid Producer-Id: must not be empty`);
			return;
		}
		const STRICT_INTEGER_REGEX = /^\d+$/;
		let producerEpoch;
		let producerSeq;
		if (hasAllProducerHeaders) {
			if (!STRICT_INTEGER_REGEX.test(producerEpochStr)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Producer-Epoch: must be a non-negative integer`);
				return;
			}
			producerEpoch = Number(producerEpochStr);
			if (!Number.isSafeInteger(producerEpoch)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Producer-Epoch: must be a non-negative integer`);
				return;
			}
			if (!STRICT_INTEGER_REGEX.test(producerSeqStr)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Producer-Seq: must be a non-negative integer`);
				return;
			}
			producerSeq = Number(producerSeqStr);
			if (!Number.isSafeInteger(producerSeq)) {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid Producer-Seq: must be a non-negative integer`);
				return;
			}
		}
		const body = await this.readBody(req);
		if (body.length === 0 && closeStream) {
			if (hasAllProducerHeaders) {
				const closeResult$1 = await this.store.closeStreamWithProducer(path, {
					producerId,
					producerEpoch,
					producerSeq
				});
				if (!closeResult$1) {
					res.writeHead(404, { "content-type": `text/plain` });
					res.end(`Stream not found`);
					return;
				}
				if (closeResult$1.producerResult?.status === `duplicate`) {
					res.writeHead(204, {
						[__durable_streams_client.STREAM_OFFSET_HEADER]: closeResult$1.finalOffset,
						[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`,
						[__durable_streams_client.PRODUCER_EPOCH_HEADER]: producerEpoch.toString(),
						[__durable_streams_client.PRODUCER_SEQ_HEADER]: closeResult$1.producerResult.lastSeq.toString()
					});
					res.end();
					return;
				}
				if (closeResult$1.producerResult?.status === `stale_epoch`) {
					res.writeHead(403, {
						"content-type": `text/plain`,
						[__durable_streams_client.PRODUCER_EPOCH_HEADER]: closeResult$1.producerResult.currentEpoch.toString()
					});
					res.end(`Stale producer epoch`);
					return;
				}
				if (closeResult$1.producerResult?.status === `invalid_epoch_seq`) {
					res.writeHead(400, { "content-type": `text/plain` });
					res.end(`New epoch must start with sequence 0`);
					return;
				}
				if (closeResult$1.producerResult?.status === `sequence_gap`) {
					res.writeHead(409, {
						"content-type": `text/plain`,
						[__durable_streams_client.PRODUCER_EXPECTED_SEQ_HEADER]: closeResult$1.producerResult.expectedSeq.toString(),
						[__durable_streams_client.PRODUCER_RECEIVED_SEQ_HEADER]: closeResult$1.producerResult.receivedSeq.toString()
					});
					res.end(`Producer sequence gap`);
					return;
				}
				if (closeResult$1.producerResult?.status === `stream_closed`) {
					const stream = this.store.get(path);
					res.writeHead(409, {
						"content-type": `text/plain`,
						[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`,
						[__durable_streams_client.STREAM_OFFSET_HEADER]: stream?.currentOffset ?? ``
					});
					res.end(`Stream is closed`);
					return;
				}
				res.writeHead(204, {
					[__durable_streams_client.STREAM_OFFSET_HEADER]: closeResult$1.finalOffset,
					[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`,
					[__durable_streams_client.PRODUCER_EPOCH_HEADER]: producerEpoch.toString(),
					[__durable_streams_client.PRODUCER_SEQ_HEADER]: producerSeq.toString()
				});
				res.end();
				return;
			}
			const closeResult = await Promise.resolve(this.store.closeStream(path));
			if (!closeResult) {
				res.writeHead(404, { "content-type": `text/plain` });
				res.end(`Stream not found`);
				return;
			}
			res.writeHead(204, {
				[__durable_streams_client.STREAM_OFFSET_HEADER]: closeResult.finalOffset,
				[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`
			});
			res.end();
			return;
		}
		if (body.length === 0) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`Empty body`);
			return;
		}
		if (!contentType) {
			res.writeHead(400, { "content-type": `text/plain` });
			res.end(`Content-Type header is required`);
			return;
		}
		const appendOptions = {
			seq,
			contentType,
			producerId,
			producerEpoch,
			producerSeq,
			close: closeStream
		};
		let result;
		if (producerId !== void 0) result = await this.store.appendWithProducer(path, body, appendOptions);
		else result = await Promise.resolve(this.store.append(path, body, appendOptions));
		this.store.touchAccess(path);
		if (result && typeof result === `object` && `message` in result) {
			const { message: message$1, producerResult, streamClosed } = result;
			if (streamClosed && !message$1) {
				if (producerResult?.status === `duplicate`) {
					const stream = this.store.get(path);
					res.writeHead(204, {
						[__durable_streams_client.STREAM_OFFSET_HEADER]: stream?.currentOffset ?? ``,
						[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`,
						[__durable_streams_client.PRODUCER_EPOCH_HEADER]: producerEpoch.toString(),
						[__durable_streams_client.PRODUCER_SEQ_HEADER]: producerResult.lastSeq.toString()
					});
					res.end();
					return;
				}
				const closedStream = this.store.get(path);
				res.writeHead(409, {
					"content-type": `text/plain`,
					[__durable_streams_client.STREAM_CLOSED_HEADER]: `true`,
					[__durable_streams_client.STREAM_OFFSET_HEADER]: closedStream?.currentOffset ?? ``
				});
				res.end(`Stream is closed`);
				return;
			}
			if (!producerResult || producerResult.status === `accepted`) {
				const responseHeaders$1 = { [__durable_streams_client.STREAM_OFFSET_HEADER]: message$1.offset };
				if (producerEpoch !== void 0) responseHeaders$1[__durable_streams_client.PRODUCER_EPOCH_HEADER] = producerEpoch.toString();
				if (producerSeq !== void 0) responseHeaders$1[__durable_streams_client.PRODUCER_SEQ_HEADER] = producerSeq.toString();
				if (streamClosed) responseHeaders$1[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
				const statusCode = producerId !== void 0 ? 200 : 204;
				res.writeHead(statusCode, responseHeaders$1);
				res.end();
				await this.notifyStreamAppend(path);
				return;
			}
			switch (producerResult.status) {
				case `duplicate`: {
					const dupHeaders = {
						[__durable_streams_client.PRODUCER_EPOCH_HEADER]: producerEpoch.toString(),
						[__durable_streams_client.PRODUCER_SEQ_HEADER]: producerResult.lastSeq.toString()
					};
					if (streamClosed) dupHeaders[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
					res.writeHead(204, dupHeaders);
					res.end();
					return;
				}
				case `stale_epoch`: {
					res.writeHead(403, {
						"content-type": `text/plain`,
						[__durable_streams_client.PRODUCER_EPOCH_HEADER]: producerResult.currentEpoch.toString()
					});
					res.end(`Stale producer epoch`);
					return;
				}
				case `invalid_epoch_seq`:
					res.writeHead(400, { "content-type": `text/plain` });
					res.end(`New epoch must start with sequence 0`);
					return;
				case `sequence_gap`:
					res.writeHead(409, {
						"content-type": `text/plain`,
						[__durable_streams_client.PRODUCER_EXPECTED_SEQ_HEADER]: producerResult.expectedSeq.toString(),
						[__durable_streams_client.PRODUCER_RECEIVED_SEQ_HEADER]: producerResult.receivedSeq.toString()
					});
					res.end(`Producer sequence gap`);
					return;
			}
		}
		const message = result;
		const responseHeaders = { [__durable_streams_client.STREAM_OFFSET_HEADER]: message.offset };
		if (closeStream) responseHeaders[__durable_streams_client.STREAM_CLOSED_HEADER] = `true`;
		res.writeHead(204, responseHeaders);
		res.end();
		await this.notifyStreamAppend(path);
	}
	async notifyStreamAppend(path) {
		if (this.subscriptionManager) try {
			await this.subscriptionManager.onStreamAppend(path);
		} catch (err) {
			serverLog.error(`[server] subscription append hook failed:`, err);
		}
		if (this.webhookManager) try {
			this.webhookManager.onStreamAppend(path);
		} catch (err) {
			serverLog.error(`[server] webhook append hook failed:`, err);
		}
		if (this.pullWakeManager) try {
			this.pullWakeManager.onStreamAppend(path);
		} catch (err) {
			serverLog.error(`[server] pull-wake append hook failed:`, err);
		}
	}
	/**
	* Handle DELETE - delete stream
	*/
	async handleDelete(path, res) {
		const existing = this.store.get(path);
		if (existing?.softDeleted) {
			res.writeHead(410, { "content-type": `text/plain` });
			res.end(`Stream is gone`);
			return;
		}
		const deleted = this.store.delete(path);
		if (!deleted) {
			res.writeHead(404, { "content-type": `text/plain` });
			res.end(`Stream not found`);
			return;
		}
		if (this.options.onStreamDeleted) await Promise.resolve(this.options.onStreamDeleted({
			type: `deleted`,
			path,
			timestamp: Date.now()
		}));
		if (this.subscriptionManager) this.subscriptionManager.onStreamDeleted(path);
		if (this.consumerManager) this.consumerManager.onStreamDeleted(path);
		if (this.webhookManager) this.webhookManager.onStreamDeleted(path);
		res.writeHead(204);
		res.end();
	}
	/**
	* Handle test control endpoints for error injection.
	* POST /_test/inject-error - inject an error
	* DELETE /_test/inject-error - clear all injected errors
	*/
	async handleTestInjectError(method, req, res) {
		if (method === `POST`) {
			const body = await this.readBody(req);
			try {
				const config = JSON.parse(new TextDecoder().decode(body));
				if (!config.path) {
					res.writeHead(400, { "content-type": `text/plain` });
					res.end(`Missing required field: path`);
					return;
				}
				const hasFaultType = config.status !== void 0 || config.delayMs !== void 0 || config.dropConnection || config.truncateBodyBytes !== void 0 || config.corruptBody || config.injectSseEvent !== void 0;
				if (!hasFaultType) {
					res.writeHead(400, { "content-type": `text/plain` });
					res.end(`Must specify at least one fault type: status, delayMs, dropConnection, truncateBodyBytes, corruptBody, or injectSseEvent`);
					return;
				}
				this.injectFault(config.path, {
					status: config.status,
					count: config.count ?? 1,
					retryAfter: config.retryAfter,
					delayMs: config.delayMs,
					dropConnection: config.dropConnection,
					truncateBodyBytes: config.truncateBodyBytes,
					probability: config.probability,
					method: config.method,
					corruptBody: config.corruptBody,
					jitterMs: config.jitterMs,
					injectSseEvent: config.injectSseEvent
				});
				res.writeHead(200, { "content-type": `application/json` });
				res.end(JSON.stringify({ ok: true }));
			} catch {
				res.writeHead(400, { "content-type": `text/plain` });
				res.end(`Invalid JSON body`);
			}
		} else if (method === `DELETE`) {
			this.clearInjectedFaults();
			res.writeHead(200, { "content-type": `application/json` });
			res.end(JSON.stringify({ ok: true }));
		} else {
			res.writeHead(405, { "content-type": `text/plain` });
			res.end(`Method not allowed`);
		}
	}
	readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			req.on(`data`, (chunk) => {
				chunks.push(chunk);
			});
			req.on(`end`, () => {
				const body = Buffer.concat(chunks);
				resolve(new Uint8Array(body));
			});
			req.on(`error`, reject);
		});
	}
};

//#endregion
//#region src/registry-hook.ts
const REGISTRY_PATH = `/v1/stream/__registry__`;
const streamMetadataSchema = { "~standard": {
	version: 1,
	vendor: `durable-streams`,
	validate: (value) => {
		if (typeof value !== `object` || value === null) return { issues: [{ message: `value must be an object` }] };
		const data = value;
		if (typeof data.path !== `string` || data.path.length === 0) return { issues: [{ message: `path must be a non-empty string` }] };
		if (typeof data.contentType !== `string` || data.contentType.length === 0) return { issues: [{ message: `contentType must be a non-empty string` }] };
		if (typeof data.createdAt !== `number`) return { issues: [{ message: `createdAt must be a number` }] };
		return { value: data };
	}
} };
const registryStateSchema = (0, __durable_streams_state.createStateSchema)({ streams: {
	schema: streamMetadataSchema,
	type: `stream`,
	primaryKey: `path`
} });
/**
* Creates lifecycle hooks that write to a __registry__ stream.
* Any client can read this stream to discover all streams and their lifecycle events.
*/
function createRegistryHooks(store, serverUrl) {
	const registryStream = new __durable_streams_client.DurableStream({
		url: `${serverUrl}${REGISTRY_PATH}`,
		contentType: `application/json`
	});
	const ensureRegistryExists = async () => {
		if (!store.has(REGISTRY_PATH)) await __durable_streams_client.DurableStream.create({
			url: `${serverUrl}${REGISTRY_PATH}`,
			contentType: `application/json`
		});
	};
	const extractStreamName = (fullPath) => {
		return fullPath.replace(/^\/v1\/stream\//, ``);
	};
	return {
		onStreamCreated: async (event) => {
			await ensureRegistryExists();
			const streamName = extractStreamName(event.path);
			const changeEvent = registryStateSchema.streams.insert({
				key: streamName,
				value: {
					path: streamName,
					contentType: event.contentType || `application/octet-stream`,
					createdAt: event.timestamp
				}
			});
			await registryStream.append(JSON.stringify(changeEvent));
		},
		onStreamDeleted: async (event) => {
			await ensureRegistryExists();
			const streamName = extractStreamName(event.path);
			const changeEvent = registryStateSchema.streams.delete({ key: streamName });
			await registryStream.append(JSON.stringify(changeEvent));
		}
	};
}

//#endregion
exports.ConsumerManager = ConsumerManager
exports.ConsumerRoutes = ConsumerRoutes
exports.DEFAULT_CURSOR_EPOCH = DEFAULT_CURSOR_EPOCH
exports.DEFAULT_CURSOR_INTERVAL_SECONDS = DEFAULT_CURSOR_INTERVAL_SECONDS
exports.DurableStreamTestServer = DurableStreamTestServer
exports.FileBackedStreamStore = FileBackedStreamStore
exports.PullWakeManager = PullWakeManager
exports.StreamStore = StreamStore
exports.SubscriptionManager = SubscriptionManager
exports.SubscriptionRoutes = SubscriptionRoutes
exports.WebhookManager = WebhookManager
exports.WebhookRoutes = WebhookRoutes
exports.WebhookStore = WebhookStore
exports.calculateCursor = calculateCursor
exports.createRegistryHooks = createRegistryHooks
exports.decodeStreamPath = decodeStreamPath
exports.encodeStreamPath = encodeStreamPath
exports.generateResponseCursor = generateResponseCursor
exports.globMatch = globMatch
exports.handleCursorCollision = handleCursorCollision
exports.validateWebhookUrl = validateWebhookUrl