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
const fastq = __toESM(require("fastq"));

//#region src/constants.ts
/**
* Durable Streams Protocol Constants
*
* Header and query parameter names following the Electric Durable Stream Protocol.
*/
/**
* Response header containing the next offset to read from.
* Offsets are opaque tokens - clients MUST NOT interpret the format.
*/
const STREAM_OFFSET_HEADER = `Stream-Next-Offset`;
/**
* Response header for cursor (used for CDN collapsing).
* Echo this value in subsequent long-poll requests.
*/
const STREAM_CURSOR_HEADER = `Stream-Cursor`;
/**
* Presence header indicating response ends at current end of stream.
* When present (any value), indicates up-to-date.
*/
const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`;
/**
* Response/request header indicating stream is closed (EOF).
* When present with value "true", the stream is permanently closed.
*/
const STREAM_CLOSED_HEADER = `Stream-Closed`;
/**
* Request header for writer coordination sequence.
* Monotonic, lexicographic. If lower than last appended seq -> 409 Conflict.
*/
const STREAM_SEQ_HEADER = `Stream-Seq`;
/**
* Request header for stream TTL in seconds (on create).
*/
const STREAM_TTL_HEADER = `Stream-TTL`;
/**
* Request header for absolute stream expiry time (RFC3339, on create).
*/
const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`;
/**
* Request header for producer ID (client-supplied stable identifier).
*/
const PRODUCER_ID_HEADER = `Producer-Id`;
/**
* Request/response header for producer epoch.
* Client-declared, server-validated monotonically increasing.
*/
const PRODUCER_EPOCH_HEADER = `Producer-Epoch`;
/**
* Request header for producer sequence number.
* Monotonically increasing per epoch, per-batch (not per-message).
*/
const PRODUCER_SEQ_HEADER = `Producer-Seq`;
/**
* Response header indicating expected sequence number on 409 Conflict.
*/
const PRODUCER_EXPECTED_SEQ_HEADER = `Producer-Expected-Seq`;
/**
* Response header indicating received sequence number on 409 Conflict.
*/
const PRODUCER_RECEIVED_SEQ_HEADER = `Producer-Received-Seq`;
/**
* Query parameter for starting offset.
*/
const OFFSET_QUERY_PARAM = `offset`;
/**
* Query parameter for live mode.
* Values: "long-poll", "sse"
*/
const LIVE_QUERY_PARAM = `live`;
/**
* Query parameter for echoing cursor (CDN collapsing).
*/
const CURSOR_QUERY_PARAM = `cursor`;
/**
* Response header indicating SSE data encoding (e.g., base64 for binary streams).
*/
const STREAM_SSE_DATA_ENCODING_HEADER = `stream-sse-data-encoding`;
/**
* SSE control event field for the next offset.
* Note: Different from HTTP header name (camelCase vs Header-Case).
*/
const SSE_OFFSET_FIELD = `streamNextOffset`;
/**
* SSE control event field for cursor.
* Note: Different from HTTP header name (camelCase vs Header-Case).
*/
const SSE_CURSOR_FIELD = `streamCursor`;
/**
* SSE control event field for stream closed state.
* Note: Different from HTTP header name (camelCase vs Header-Case).
*/
const SSE_CLOSED_FIELD = `streamClosed`;
/**
* Content types that are natively compatible with SSE (UTF-8 text).
* Binary content types are also supported via automatic base64 encoding.
*/
const SSE_COMPATIBLE_CONTENT_TYPES = [`text/`, `application/json`];
/**
* Protocol query parameters that should not be set by users.
*/
const DURABLE_STREAM_PROTOCOL_QUERY_PARAMS = [
	OFFSET_QUERY_PARAM,
	LIVE_QUERY_PARAM,
	CURSOR_QUERY_PARAM
];

//#endregion
//#region src/error.ts
/**
* Error thrown for transport/network errors.
* Following the @electric-sql/client FetchError pattern.
*/
var FetchError = class FetchError extends Error {
	status;
	text;
	json;
	headers;
	constructor(status, text, json, headers, url, message) {
		super(message || `HTTP Error ${status} at ${url}: ${text ?? JSON.stringify(json)}`);
		this.url = url;
		this.name = `FetchError`;
		this.status = status;
		this.text = text;
		this.json = json;
		this.headers = headers;
	}
	static async fromResponse(response, url) {
		const status = response.status;
		const headers = Object.fromEntries([...response.headers.entries()]);
		let text = void 0;
		let json = void 0;
		const contentType = response.headers.get(`content-type`);
		if (!response.bodyUsed && response.body !== null) if (contentType && contentType.includes(`application/json`)) try {
			json = await response.json();
		} catch {
			text = await response.text();
		}
		else text = await response.text();
		return new FetchError(status, text, json, headers, url);
	}
};
/**
* Error thrown when a fetch operation is aborted during backoff.
*/
var FetchBackoffAbortError = class extends Error {
	constructor() {
		super(`Fetch with backoff aborted`);
		this.name = `FetchBackoffAbortError`;
	}
};
/**
* Protocol-level error for Durable Streams operations.
* Provides structured error handling with error codes.
*/
var DurableStreamError = class DurableStreamError extends Error {
	/**
	* HTTP status code, if applicable.
	*/
	status;
	/**
	* Structured error code for programmatic handling.
	*/
	code;
	/**
	* Additional error details (e.g., raw response body).
	*/
	details;
	constructor(message, code, status, details) {
		super(message);
		this.name = `DurableStreamError`;
		this.code = code;
		this.status = status;
		this.details = details;
	}
	/**
	* Create a DurableStreamError from an HTTP response.
	*/
	static async fromResponse(response, url) {
		const status = response.status;
		let details;
		const contentType = response.headers.get(`content-type`);
		if (!response.bodyUsed && response.body !== null) if (contentType && contentType.includes(`application/json`)) try {
			details = await response.json();
		} catch {
			details = await response.text();
		}
		else details = await response.text();
		const code = statusToCode(status);
		const message = `Durable stream error at ${url}: ${response.statusText || status}`;
		return new DurableStreamError(message, code, status, details);
	}
	/**
	* Create a DurableStreamError from a FetchError.
	*/
	static fromFetchError(error) {
		const code = statusToCode(error.status);
		return new DurableStreamError(error.message, code, error.status, error.json ?? error.text);
	}
};
/**
* Map HTTP status codes to DurableStreamErrorCode.
*/
function statusToCode(status) {
	switch (status) {
		case 400: return `BAD_REQUEST`;
		case 401: return `UNAUTHORIZED`;
		case 403: return `FORBIDDEN`;
		case 404: return `NOT_FOUND`;
		case 409: return `CONFLICT_SEQ`;
		case 429: return `RATE_LIMITED`;
		case 503: return `BUSY`;
		default: return `UNKNOWN`;
	}
}
/**
* Error thrown when stream URL is missing.
*/
var MissingStreamUrlError = class extends Error {
	constructor() {
		super(`Invalid stream options: missing required url parameter`);
		this.name = `MissingStreamUrlError`;
	}
};
/**
* Error thrown when attempting to append to a closed stream.
*/
var StreamClosedError = class extends DurableStreamError {
	code = `STREAM_CLOSED`;
	status = 409;
	streamClosed = true;
	/**
	* The final offset of the stream, if available from the response.
	*/
	finalOffset;
	constructor(url, finalOffset) {
		super(`Cannot append to closed stream`, `STREAM_CLOSED`, 409, url);
		this.name = `StreamClosedError`;
		this.finalOffset = finalOffset;
	}
};
/**
* Error thrown when signal option is invalid.
*/
var InvalidSignalError = class extends Error {
	constructor() {
		super(`Invalid signal option. It must be an instance of AbortSignal.`);
		this.name = `InvalidSignalError`;
	}
};

//#endregion
//#region src/fetch.ts
/**
* HTTP status codes that should be retried.
*/
const HTTP_RETRY_STATUS_CODES = [429, 503];
/**
* Default backoff options.
*/
const BackoffDefaults = {
	initialDelay: 100,
	maxDelay: 6e4,
	multiplier: 1.3,
	maxRetries: Infinity
};
/**
* Parse Retry-After header value and return delay in milliseconds.
* Supports both delta-seconds format and HTTP-date format.
* Returns 0 if header is not present or invalid.
*/
function parseRetryAfterHeader(retryAfter) {
	if (!retryAfter) return 0;
	const retryAfterSec = Number(retryAfter);
	if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return retryAfterSec * 1e3;
	const retryDate = Date.parse(retryAfter);
	if (!isNaN(retryDate)) {
		const deltaMs = retryDate - Date.now();
		return Math.max(0, Math.min(deltaMs, 36e5));
	}
	return 0;
}
/**
* Creates a fetch client that retries failed requests with exponential backoff.
*
* @param fetchClient - The base fetch client to wrap
* @param backoffOptions - Options for retry behavior
* @returns A fetch function with automatic retry
*/
function createFetchWithBackoff(fetchClient, backoffOptions = BackoffDefaults) {
	const { initialDelay, maxDelay, multiplier, debug = false, onFailedAttempt, maxRetries = Infinity } = backoffOptions;
	return async (...args) => {
		const url = args[0];
		const options = args[1];
		let delay = initialDelay;
		let attempt = 0;
		while (true) try {
			const result = await fetchClient(...args);
			if (result.ok) return result;
			const err = await FetchError.fromResponse(result, url.toString());
			throw err;
		} catch (e) {
			onFailedAttempt?.();
			if (options?.signal?.aborted) throw new FetchBackoffAbortError();
			else if (e instanceof FetchError && !HTTP_RETRY_STATUS_CODES.includes(e.status) && e.status >= 400 && e.status < 500) throw e;
			else {
				attempt++;
				if (attempt > maxRetries) {
					if (debug) console.log(`Max retries reached (${attempt}/${maxRetries}), giving up`);
					throw e;
				}
				const serverMinimumMs = e instanceof FetchError ? parseRetryAfterHeader(e.headers[`retry-after`]) : 0;
				const jitter = Math.random() * delay;
				const clientBackoffMs = Math.min(jitter, maxDelay);
				const waitMs = Math.max(serverMinimumMs, clientBackoffMs);
				if (debug) {
					const source = serverMinimumMs > 0 ? `server+client` : `client`;
					console.log(`Retry attempt #${attempt} after ${waitMs}ms (${source}, serverMin=${serverMinimumMs}ms, clientBackoff=${clientBackoffMs}ms)`);
				}
				await new Promise((resolve) => setTimeout(resolve, waitMs));
				delay = Math.min(delay * multiplier, maxDelay);
			}
		}
	};
}
/**
* Status codes where we shouldn't try to read the body.
*/
const NO_BODY_STATUS_CODES = [
	201,
	204,
	205
];
/**
* Creates a fetch client that ensures the response body is fully consumed.
* This prevents issues with connection pooling when bodies aren't read.
*
* Uses arrayBuffer() instead of text() to preserve binary data integrity.
*
* @param fetchClient - The base fetch client to wrap
* @returns A fetch function that consumes response bodies
*/
function createFetchWithConsumedBody(fetchClient) {
	return async (...args) => {
		const url = args[0];
		const res = await fetchClient(...args);
		try {
			if (res.status < 200 || NO_BODY_STATUS_CODES.includes(res.status)) return res;
			const buf = await res.arrayBuffer();
			return new Response(buf, {
				status: res.status,
				statusText: res.statusText,
				headers: res.headers
			});
		} catch (err) {
			if (args[1]?.signal?.aborted) throw new FetchBackoffAbortError();
			throw new FetchError(res.status, void 0, void 0, Object.fromEntries([...res.headers.entries()]), url.toString(), err instanceof Error ? err.message : typeof err === `string` ? err : `failed to read body`);
		}
	};
}

//#endregion
//#region src/asyncIterableReadableStream.ts
/**
* Check if a value has Symbol.asyncIterator defined.
*/
function hasAsyncIterator(stream$1) {
	return typeof Symbol !== `undefined` && typeof Symbol.asyncIterator === `symbol` && typeof stream$1[Symbol.asyncIterator] === `function`;
}
/**
* Define [Symbol.asyncIterator] and .values() on a ReadableStream instance.
*
* Uses getReader().read() to implement spec-consistent iteration.
* On completion or early exit (break/return/throw), releases lock and cancels as appropriate.
*
* **Iterator behavior notes:**
* - `return(value?)` accepts an optional cancellation reason passed to `reader.cancel()`
* - `return()` always resolves with `{ done: true, value: undefined }` regardless of the
*   input value. This matches `for await...of` semantics where the return value is ignored.
*   Manual iteration users should be aware of this behavior.
*/
function defineAsyncIterator(stream$1) {
	if (typeof Symbol === `undefined` || typeof Symbol.asyncIterator !== `symbol`) return;
	if (typeof stream$1[Symbol.asyncIterator] === `function`) return;
	const createIterator = function() {
		const reader = this.getReader();
		let finished = false;
		let pendingReads = 0;
		const iterator = {
			async next() {
				if (finished) return {
					done: true,
					value: void 0
				};
				pendingReads++;
				try {
					const { value, done } = await reader.read();
					if (done) {
						finished = true;
						reader.releaseLock();
						return {
							done: true,
							value: void 0
						};
					}
					return {
						done: false,
						value
					};
				} catch (err) {
					finished = true;
					try {
						reader.releaseLock();
					} catch {}
					throw err;
				} finally {
					pendingReads--;
				}
			},
			async return(value) {
				if (pendingReads > 0) throw new TypeError(`Cannot close a readable stream reader when it has pending read requests`);
				finished = true;
				const cancelPromise = reader.cancel(value);
				reader.releaseLock();
				await cancelPromise;
				return {
					done: true,
					value: void 0
				};
			},
			async throw(err) {
				if (pendingReads > 0) throw new TypeError(`Cannot close a readable stream reader when it has pending read requests`);
				finished = true;
				const cancelPromise = reader.cancel(err);
				reader.releaseLock();
				await cancelPromise;
				throw err;
			},
			[Symbol.asyncIterator]() {
				return this;
			}
		};
		return iterator;
	};
	try {
		Object.defineProperty(stream$1, Symbol.asyncIterator, {
			configurable: true,
			writable: true,
			value: createIterator
		});
	} catch {
		return;
	}
	try {
		Object.defineProperty(stream$1, `values`, {
			configurable: true,
			writable: true,
			value: createIterator
		});
	} catch {}
}
/**
* Ensure a ReadableStream is async-iterable.
*
* If the stream already has [Symbol.asyncIterator] defined (native or polyfilled),
* it is returned as-is. Otherwise, [Symbol.asyncIterator] is defined on the
* stream instance (not the prototype).
*
* The returned value is the same ReadableStream instance, so:
* - `stream instanceof ReadableStream` remains true
* - Any code relying on native branding/internal slots continues to work
*
* @example
* ```typescript
* const stream = someApiReturningReadableStream();
* const iterableStream = asAsyncIterableReadableStream(stream);
*
* // Now works on Safari/iOS:
* for await (const chunk of iterableStream) {
*   console.log(chunk);
* }
* ```
*/
function asAsyncIterableReadableStream(stream$1) {
	if (!hasAsyncIterator(stream$1)) defineAsyncIterator(stream$1);
	return stream$1;
}

//#endregion
//#region src/sse.ts
/**
* Parse SSE events from a ReadableStream<Uint8Array>.
* Yields parsed events as they arrive.
*/
async function* parseSSEStream(stream$1, signal) {
	const reader = stream$1.getReader();
	const decoder = new TextDecoder();
	let buffer = ``;
	let currentEvent = { data: [] };
	try {
		while (true) {
			if (signal?.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, `\n`).replace(/\r/g, `\n`);
			const lines = buffer.split(`\n`);
			buffer = lines.pop() ?? ``;
			for (const line of lines) if (line === ``) {
				if (currentEvent.type && currentEvent.data.length > 0) {
					const dataStr = currentEvent.data.join(`\n`);
					if (currentEvent.type === `data`) yield {
						type: `data`,
						data: dataStr
					};
					else if (currentEvent.type === `control`) try {
						const control = JSON.parse(dataStr);
						yield {
							type: `control`,
							streamNextOffset: control.streamNextOffset,
							streamCursor: control.streamCursor,
							upToDate: control.upToDate,
							streamClosed: control.streamClosed
						};
					} catch (err) {
						const preview = dataStr.length > 100 ? dataStr.slice(0, 100) + `...` : dataStr;
						throw new DurableStreamError(`Failed to parse SSE control event: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`, `PARSE_ERROR`);
					}
				}
				currentEvent = { data: [] };
			} else if (line.startsWith(`event:`)) {
				const eventType = line.slice(6);
				currentEvent.type = eventType.startsWith(` `) ? eventType.slice(1) : eventType;
			} else if (line.startsWith(`data:`)) {
				const content = line.slice(5);
				currentEvent.data.push(content.startsWith(` `) ? content.slice(1) : content);
			}
		}
		const remaining = decoder.decode();
		if (remaining) buffer += remaining;
		if (buffer && currentEvent.type && currentEvent.data.length > 0) {
			const dataStr = currentEvent.data.join(`\n`);
			if (currentEvent.type === `data`) yield {
				type: `data`,
				data: dataStr
			};
			else if (currentEvent.type === `control`) try {
				const control = JSON.parse(dataStr);
				yield {
					type: `control`,
					streamNextOffset: control.streamNextOffset,
					streamCursor: control.streamCursor,
					upToDate: control.upToDate,
					streamClosed: control.streamClosed
				};
			} catch (err) {
				const preview = dataStr.length > 100 ? dataStr.slice(0, 100) + `...` : dataStr;
				throw new DurableStreamError(`Failed to parse SSE control event: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`, `PARSE_ERROR`);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

//#endregion
//#region src/stream-response-state.ts
/**
* Abstract base class for stream response state.
* All state transitions return new immutable state objects.
*/
var StreamResponseState = class {
	shouldContinueLive(stopAfterUpToDate, liveMode) {
		if (stopAfterUpToDate && this.upToDate) return false;
		if (liveMode === false) return false;
		if (this.streamClosed) return false;
		return true;
	}
};
/**
* State for long-poll mode. shouldUseSse() returns false.
*/
var LongPollState = class LongPollState extends StreamResponseState {
	offset;
	cursor;
	upToDate;
	streamClosed;
	constructor(fields) {
		super();
		this.offset = fields.offset;
		this.cursor = fields.cursor;
		this.upToDate = fields.upToDate;
		this.streamClosed = fields.streamClosed;
	}
	shouldUseSse() {
		return false;
	}
	withResponseMetadata(update) {
		return new LongPollState({
			offset: update.offset ?? this.offset,
			cursor: update.cursor ?? this.cursor,
			upToDate: update.upToDate,
			streamClosed: this.streamClosed || update.streamClosed
		});
	}
	withSSEControl(event) {
		const streamClosed = this.streamClosed || (event.streamClosed ?? false);
		return new LongPollState({
			offset: event.streamNextOffset,
			cursor: event.streamCursor || this.cursor,
			upToDate: event.streamClosed ?? false ? true : event.upToDate ?? this.upToDate,
			streamClosed
		});
	}
	pause() {
		return new PausedState(this);
	}
};
/**
* State for SSE mode. shouldUseSse() returns true.
* Tracks SSE connection resilience (short connection detection).
*/
var SSEState = class SSEState extends StreamResponseState {
	offset;
	cursor;
	upToDate;
	streamClosed;
	consecutiveShortConnections;
	connectionStartTime;
	constructor(fields) {
		super();
		this.offset = fields.offset;
		this.cursor = fields.cursor;
		this.upToDate = fields.upToDate;
		this.streamClosed = fields.streamClosed;
		this.consecutiveShortConnections = fields.consecutiveShortConnections ?? 0;
		this.connectionStartTime = fields.connectionStartTime;
	}
	shouldUseSse() {
		return true;
	}
	withResponseMetadata(update) {
		return new SSEState({
			offset: update.offset ?? this.offset,
			cursor: update.cursor ?? this.cursor,
			upToDate: update.upToDate,
			streamClosed: this.streamClosed || update.streamClosed,
			consecutiveShortConnections: this.consecutiveShortConnections,
			connectionStartTime: this.connectionStartTime
		});
	}
	withSSEControl(event) {
		const streamClosed = this.streamClosed || (event.streamClosed ?? false);
		return new SSEState({
			offset: event.streamNextOffset,
			cursor: event.streamCursor || this.cursor,
			upToDate: event.streamClosed ?? false ? true : event.upToDate ?? this.upToDate,
			streamClosed,
			consecutiveShortConnections: this.consecutiveShortConnections,
			connectionStartTime: this.connectionStartTime
		});
	}
	startConnection(now) {
		return new SSEState({
			offset: this.offset,
			cursor: this.cursor,
			upToDate: this.upToDate,
			streamClosed: this.streamClosed,
			consecutiveShortConnections: this.consecutiveShortConnections,
			connectionStartTime: now
		});
	}
	handleConnectionEnd(now, wasAborted, config) {
		if (this.connectionStartTime === void 0) return {
			action: `healthy`,
			state: this
		};
		const duration = now - this.connectionStartTime;
		if (duration < config.minConnectionDuration && !wasAborted) {
			const newCount = this.consecutiveShortConnections + 1;
			if (newCount >= config.maxShortConnections) return {
				action: `fallback`,
				state: new LongPollState({
					offset: this.offset,
					cursor: this.cursor,
					upToDate: this.upToDate,
					streamClosed: this.streamClosed
				})
			};
			return {
				action: `reconnect`,
				state: new SSEState({
					offset: this.offset,
					cursor: this.cursor,
					upToDate: this.upToDate,
					streamClosed: this.streamClosed,
					consecutiveShortConnections: newCount,
					connectionStartTime: this.connectionStartTime
				}),
				backoffAttempt: newCount
			};
		}
		if (duration >= config.minConnectionDuration) return {
			action: `healthy`,
			state: new SSEState({
				offset: this.offset,
				cursor: this.cursor,
				upToDate: this.upToDate,
				streamClosed: this.streamClosed,
				consecutiveShortConnections: 0,
				connectionStartTime: this.connectionStartTime
			})
		};
		return {
			action: `healthy`,
			state: this
		};
	}
	pause() {
		return new PausedState(this);
	}
};
/**
* Paused state wrapper. Delegates all sync field access to the inner state.
* resume() returns the wrapped state unchanged (identity preserved).
*/
var PausedState = class PausedState extends StreamResponseState {
	#inner;
	constructor(inner) {
		super();
		this.#inner = inner;
	}
	get offset() {
		return this.#inner.offset;
	}
	get cursor() {
		return this.#inner.cursor;
	}
	get upToDate() {
		return this.#inner.upToDate;
	}
	get streamClosed() {
		return this.#inner.streamClosed;
	}
	shouldUseSse() {
		return this.#inner.shouldUseSse();
	}
	withResponseMetadata(update) {
		const newInner = this.#inner.withResponseMetadata(update);
		return new PausedState(newInner);
	}
	withSSEControl(event) {
		const newInner = this.#inner.withSSEControl(event);
		return new PausedState(newInner);
	}
	pause() {
		return this;
	}
	resume() {
		return {
			state: this.#inner,
			justResumed: true
		};
	}
};

//#endregion
//#region src/response.ts
/**
* Constant used as abort reason when pausing the stream due to visibility change.
*/
const PAUSE_STREAM = `PAUSE_STREAM`;
/**
* Implementation of the StreamResponse interface.
*/
var StreamResponseImpl = class {
	url;
	contentType;
	live;
	startOffset;
	#headers;
	#status;
	#statusText;
	#ok;
	#isLoading;
	#syncState;
	#isJsonMode;
	#abortController;
	#fetchNext;
	#startSSE;
	#closedResolve;
	#closedReject;
	#closed;
	#stopAfterUpToDate = false;
	#consumptionMethod = null;
	#state = `active`;
	#requestAbortController;
	#unsubscribeFromVisibilityChanges;
	#pausePromise;
	#pauseResolve;
	#sseResilience;
	#encoding;
	#responseStream;
	constructor(config) {
		this.url = config.url;
		this.contentType = config.contentType;
		this.live = config.live;
		this.startOffset = config.startOffset;
		const syncFields = {
			offset: config.initialOffset,
			cursor: config.initialCursor,
			upToDate: config.initialUpToDate,
			streamClosed: config.initialStreamClosed
		};
		this.#syncState = config.startSSE ? new SSEState(syncFields) : new LongPollState(syncFields);
		this.#headers = config.firstResponse.headers;
		this.#status = config.firstResponse.status;
		this.#statusText = config.firstResponse.statusText;
		this.#ok = config.firstResponse.ok;
		this.#isLoading = false;
		this.#isJsonMode = config.isJsonMode;
		this.#abortController = config.abortController;
		this.#fetchNext = config.fetchNext;
		this.#startSSE = config.startSSE;
		this.#sseResilience = {
			minConnectionDuration: config.sseResilience?.minConnectionDuration ?? 1e3,
			maxShortConnections: config.sseResilience?.maxShortConnections ?? 3,
			backoffBaseDelay: config.sseResilience?.backoffBaseDelay ?? 100,
			backoffMaxDelay: config.sseResilience?.backoffMaxDelay ?? 5e3,
			logWarnings: config.sseResilience?.logWarnings ?? true
		};
		this.#encoding = config.encoding;
		this.#closed = new Promise((resolve, reject) => {
			this.#closedResolve = resolve;
			this.#closedReject = reject;
		});
		this.#responseStream = this.#createResponseStream(config.firstResponse);
		this.#abortController.signal.addEventListener(`abort`, () => {
			this.#requestAbortController?.abort(this.#abortController.signal.reason);
			this.#pauseResolve?.();
			this.#pausePromise = void 0;
			this.#pauseResolve = void 0;
		}, { once: true });
		this.#subscribeToVisibilityChanges();
	}
	/**
	* Subscribe to document visibility changes to pause/resume syncing.
	* When the page is hidden, we pause to save battery and bandwidth.
	* When visible again, we resume syncing.
	*/
	#subscribeToVisibilityChanges() {
		if (typeof document === `object` && typeof document.hidden === `boolean` && typeof document.addEventListener === `function`) {
			const visibilityHandler = () => {
				if (document.hidden) this.#pause();
				else this.#resume();
			};
			document.addEventListener(`visibilitychange`, visibilityHandler);
			this.#unsubscribeFromVisibilityChanges = () => {
				if (typeof document === `object`) document.removeEventListener(`visibilitychange`, visibilityHandler);
			};
			if (document.hidden) this.#pause();
		}
	}
	/**
	* Pause the stream when page becomes hidden.
	* Aborts any in-flight request to free resources.
	* Creates a promise that pull() will await while paused.
	*/
	#pause() {
		if (this.#state === `active`) {
			this.#state = `pause-requested`;
			this.#syncState = this.#syncState.pause();
			this.#pausePromise = new Promise((resolve) => {
				this.#pauseResolve = resolve;
			});
			this.#requestAbortController?.abort(PAUSE_STREAM);
		}
	}
	/**
	* Resume the stream when page becomes visible.
	* Resolves the pause promise to unblock pull().
	*/
	#resume() {
		if (this.#state === `paused` || this.#state === `pause-requested`) {
			if (this.#abortController.signal.aborted) return;
			if (this.#syncState instanceof PausedState) this.#syncState = this.#syncState.resume().state;
			this.#state = `active`;
			this.#pauseResolve?.();
			this.#pausePromise = void 0;
			this.#pauseResolve = void 0;
		}
	}
	get headers() {
		return this.#headers;
	}
	get status() {
		return this.#status;
	}
	get statusText() {
		return this.#statusText;
	}
	get ok() {
		return this.#ok;
	}
	get isLoading() {
		return this.#isLoading;
	}
	get offset() {
		return this.#syncState.offset;
	}
	get cursor() {
		return this.#syncState.cursor;
	}
	get upToDate() {
		return this.#syncState.upToDate;
	}
	get streamClosed() {
		return this.#syncState.streamClosed;
	}
	#ensureJsonMode() {
		if (!this.#isJsonMode) throw new DurableStreamError(`JSON methods are only valid for JSON-mode streams. Content-Type is "${this.contentType}" and json hint was not set.`, `BAD_REQUEST`);
	}
	#markClosed() {
		this.#unsubscribeFromVisibilityChanges?.();
		this.#closedResolve();
	}
	#markError(err) {
		this.#unsubscribeFromVisibilityChanges?.();
		this.#closedReject(err);
	}
	/**
	* Ensure only one consumption method is used per StreamResponse.
	* Throws if any consumption method was already called.
	*/
	#ensureNoConsumption(method) {
		if (this.#consumptionMethod !== null) throw new DurableStreamError(`Cannot call ${method}() - this StreamResponse is already being consumed via ${this.#consumptionMethod}()`, `ALREADY_CONSUMED`);
		this.#consumptionMethod = method;
	}
	/**
	* Determine if we should continue with live updates based on live mode
	* and whether we've received upToDate or streamClosed.
	*/
	#shouldContinueLive() {
		return this.#syncState.shouldContinueLive(this.#stopAfterUpToDate, this.live);
	}
	/**
	* Update state from response headers.
	*/
	#updateStateFromResponse(response) {
		this.#syncState = this.#syncState.withResponseMetadata({
			offset: response.headers.get(STREAM_OFFSET_HEADER) || void 0,
			cursor: response.headers.get(STREAM_CURSOR_HEADER) || void 0,
			upToDate: response.headers.has(STREAM_UP_TO_DATE_HEADER),
			streamClosed: response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`
		});
		this.#headers = response.headers;
		this.#status = response.status;
		this.#statusText = response.statusText;
		this.#ok = response.ok;
	}
	/**
	* Update instance state from an SSE control event.
	*/
	#updateStateFromSSEControl(controlEvent) {
		this.#syncState = this.#syncState.withSSEControl(controlEvent);
	}
	#updateEncodingFromSSEResponse(response) {
		this.#encoding = response.headers.get(STREAM_SSE_DATA_ENCODING_HEADER) === `base64` ? `base64` : void 0;
	}
	/**
	* Mark the start of an SSE connection for duration tracking.
	* If the state is not SSEState (e.g., auto-detected SSE from content-type),
	* transitions to SSEState first.
	*/
	#markSSEConnectionStart() {
		if (!(this.#syncState instanceof SSEState)) this.#syncState = new SSEState({
			offset: this.#syncState.offset,
			cursor: this.#syncState.cursor,
			upToDate: this.#syncState.upToDate,
			streamClosed: this.#syncState.streamClosed
		});
		this.#syncState = this.#syncState.startConnection(Date.now());
	}
	/**
	* Try to reconnect SSE and return the new iterator, or null if reconnection
	* is not possible or fails.
	*/
	async #trySSEReconnect() {
		if (!this.#syncState.shouldUseSse()) return null;
		if (!this.#shouldContinueLive() || !this.#startSSE) return null;
		const result = this.#syncState.handleConnectionEnd(Date.now(), this.#abortController.signal.aborted, this.#sseResilience);
		this.#syncState = result.state;
		if (result.action === `fallback`) {
			if (this.#sseResilience.logWarnings) console.warn("[Durable Streams] SSE connections are closing immediately (possibly due to proxy buffering or misconfiguration). Falling back to long polling. Your proxy must support streaming SSE responses (not buffer the complete response). Configuration: Nginx add 'X-Accel-Buffering: no', Caddy add 'flush_interval -1' to reverse_proxy.");
			return null;
		}
		if (result.action === `reconnect`) {
			const maxDelay = Math.min(this.#sseResilience.backoffMaxDelay, this.#sseResilience.backoffBaseDelay * Math.pow(2, result.backoffAttempt));
			const delayMs = Math.floor(Math.random() * maxDelay);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		this.#markSSEConnectionStart();
		this.#requestAbortController = new AbortController();
		const newSSEResponse = await this.#startSSE(this.offset, this.cursor, this.#requestAbortController.signal);
		this.#updateEncodingFromSSEResponse(newSSEResponse);
		if (newSSEResponse.body) return parseSSEStream(newSSEResponse.body, this.#requestAbortController.signal);
		return null;
	}
	/**
	* Process SSE events from the iterator.
	* Returns an object indicating the result:
	* - { type: 'response', response, newIterator? } - yield this response
	* - { type: 'closed' } - stream should be closed
	* - { type: 'error', error } - an error occurred
	* - { type: 'continue', newIterator? } - continue processing (control-only event)
	*/
	async #processSSEEvents(sseEventIterator) {
		const { done, value: event } = await sseEventIterator.next();
		if (done) {
			try {
				const newIterator = await this.#trySSEReconnect();
				if (newIterator) return {
					type: `continue`,
					newIterator
				};
			} catch (err) {
				return {
					type: `error`,
					error: err instanceof Error ? err : new Error(`SSE reconnection failed`)
				};
			}
			return { type: `closed` };
		}
		if (event.type === `data`) return this.#processSSEDataEvent(event.data, sseEventIterator);
		this.#updateStateFromSSEControl(event);
		if (event.upToDate) {
			const response = createSSESyntheticResponse(``, event.streamNextOffset, event.streamCursor, true, event.streamClosed ?? false, this.contentType, this.#encoding);
			return {
				type: `response`,
				response
			};
		}
		return { type: `continue` };
	}
	/**
	* Process an SSE data event by waiting for its corresponding control event.
	* In SSE protocol, control events come AFTER data events.
	* Multiple data events may arrive before a single control event - we buffer them.
	*
	* For base64 mode, each data event is independently base64 encoded, so we
	* collect them as an array and decode each separately.
	*/
	async #processSSEDataEvent(pendingData, sseEventIterator) {
		const bufferedDataParts = [pendingData];
		while (true) {
			const { done: controlDone, value: controlEvent } = await sseEventIterator.next();
			if (controlDone) {
				const response = createSSESyntheticResponseFromParts(bufferedDataParts, this.offset, this.cursor, this.upToDate, this.streamClosed, this.contentType, this.#encoding, this.#isJsonMode);
				try {
					const newIterator = await this.#trySSEReconnect();
					return {
						type: `response`,
						response,
						newIterator: newIterator ?? void 0
					};
				} catch (err) {
					return {
						type: `error`,
						error: err instanceof Error ? err : new Error(`SSE reconnection failed`)
					};
				}
			}
			if (controlEvent.type === `control`) {
				this.#updateStateFromSSEControl(controlEvent);
				const response = createSSESyntheticResponseFromParts(bufferedDataParts, controlEvent.streamNextOffset, controlEvent.streamCursor, controlEvent.upToDate ?? false, controlEvent.streamClosed ?? false, this.contentType, this.#encoding, this.#isJsonMode);
				return {
					type: `response`,
					response
				};
			}
			bufferedDataParts.push(controlEvent.data);
		}
	}
	/**
	* Create the core ReadableStream<Response> that yields responses.
	* This is consumed once - all consumption methods use this same stream.
	*
	* For long-poll mode: yields actual Response objects.
	* For SSE mode: yields synthetic Response objects created from SSE data events.
	*/
	#createResponseStream(firstResponse) {
		let firstResponseYielded = false;
		let sseEventIterator = null;
		return new ReadableStream({
			pull: async (controller) => {
				try {
					if (!firstResponseYielded) {
						firstResponseYielded = true;
						const isSSE = firstResponse.headers.get(`content-type`)?.includes(`text/event-stream`) ?? false;
						if (isSSE && firstResponse.body) {
							this.#markSSEConnectionStart();
							this.#updateEncodingFromSSEResponse(firstResponse);
							this.#requestAbortController = new AbortController();
							sseEventIterator = parseSSEStream(firstResponse.body, this.#requestAbortController.signal);
						} else {
							controller.enqueue(firstResponse);
							if (this.upToDate && !this.#shouldContinueLive()) {
								this.#markClosed();
								controller.close();
								return;
							}
							return;
						}
					}
					if (!sseEventIterator && this.upToDate && this.#startSSE && this.#shouldContinueLive()) {
						if (this.#state === `pause-requested` || this.#state === `paused`) {
							this.#state = `paused`;
							if (this.#pausePromise) await this.#pausePromise;
							if (this.#abortController.signal.aborted) {
								this.#markClosed();
								controller.close();
								return;
							}
						}
						this.#markSSEConnectionStart();
						this.#requestAbortController = new AbortController();
						const sseResponse = await this.#startSSE(this.offset, this.cursor, this.#requestAbortController.signal);
						this.#updateEncodingFromSSEResponse(sseResponse);
						if (sseResponse.body) sseEventIterator = parseSSEStream(sseResponse.body, this.#requestAbortController.signal);
					}
					if (sseEventIterator) {
						if (this.#state === `pause-requested` || this.#state === `paused`) {
							this.#state = `paused`;
							if (this.#pausePromise) await this.#pausePromise;
							if (this.#abortController.signal.aborted) {
								this.#markClosed();
								controller.close();
								return;
							}
							const newIterator = await this.#trySSEReconnect();
							if (newIterator) sseEventIterator = newIterator;
							else {
								this.#markClosed();
								controller.close();
								return;
							}
						}
						while (true) {
							const result = await this.#processSSEEvents(sseEventIterator);
							switch (result.type) {
								case `response`:
									if (result.newIterator) sseEventIterator = result.newIterator;
									controller.enqueue(result.response);
									return;
								case `closed`:
									this.#markClosed();
									controller.close();
									return;
								case `error`:
									this.#markError(result.error);
									controller.error(result.error);
									return;
								case `continue`:
									if (result.newIterator) sseEventIterator = result.newIterator;
									continue;
							}
						}
					}
					if (this.#shouldContinueLive()) {
						let resumingFromPause = false;
						if (this.#state === `pause-requested` || this.#state === `paused`) {
							this.#state = `paused`;
							if (this.#pausePromise) await this.#pausePromise;
							if (this.#abortController.signal.aborted) {
								this.#markClosed();
								controller.close();
								return;
							}
							resumingFromPause = true;
						}
						if (this.#abortController.signal.aborted) {
							this.#markClosed();
							controller.close();
							return;
						}
						this.#requestAbortController = new AbortController();
						const response = await this.#fetchNext(this.offset, this.cursor, this.#requestAbortController.signal, this.upToDate, resumingFromPause);
						this.#updateStateFromResponse(response);
						controller.enqueue(response);
						return;
					}
					this.#markClosed();
					controller.close();
				} catch (err) {
					if (this.#requestAbortController?.signal.aborted && this.#requestAbortController.signal.reason === PAUSE_STREAM) {
						if (this.#state === `pause-requested`) this.#state = `paused`;
						return;
					}
					if (this.#abortController.signal.aborted) {
						this.#markClosed();
						controller.close();
					} else {
						this.#markError(err instanceof Error ? err : new Error(String(err)));
						controller.error(err);
					}
				}
			},
			cancel: () => {
				this.#abortController.abort();
				this.#unsubscribeFromVisibilityChanges?.();
				this.#markClosed();
			}
		});
	}
	/**
	* Get the response stream reader. Can only be called once.
	*/
	#getResponseReader() {
		return this.#responseStream.getReader();
	}
	async body() {
		this.#ensureNoConsumption(`body`);
		this.#stopAfterUpToDate = true;
		const reader = this.#getResponseReader();
		const blobs = [];
		try {
			let result = await reader.read();
			while (!result.done) {
				const wasUpToDate = this.upToDate;
				const blob = await result.value.blob();
				if (blob.size > 0) blobs.push(blob);
				if (wasUpToDate) break;
				result = await reader.read();
			}
		} finally {
			reader.releaseLock();
		}
		this.#markClosed();
		if (blobs.length === 0) return new Uint8Array(0);
		if (blobs.length === 1) return new Uint8Array(await blobs[0].arrayBuffer());
		const combined = new Blob(blobs);
		return new Uint8Array(await combined.arrayBuffer());
	}
	async json() {
		this.#ensureNoConsumption(`json`);
		this.#ensureJsonMode();
		this.#stopAfterUpToDate = true;
		const reader = this.#getResponseReader();
		const items = [];
		try {
			let result = await reader.read();
			while (!result.done) {
				const wasUpToDate = this.upToDate;
				const text = await result.value.text();
				const content = text.trim() || `[]`;
				let parsed;
				try {
					parsed = JSON.parse(content);
				} catch (err) {
					const preview = content.length > 100 ? content.slice(0, 100) + `...` : content;
					throw new DurableStreamError(`Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`, `PARSE_ERROR`);
				}
				if (Array.isArray(parsed)) items.push(...parsed);
				else items.push(parsed);
				if (wasUpToDate) break;
				result = await reader.read();
			}
		} finally {
			reader.releaseLock();
		}
		this.#markClosed();
		return items;
	}
	async text() {
		this.#ensureNoConsumption(`text`);
		this.#stopAfterUpToDate = true;
		const reader = this.#getResponseReader();
		const parts = [];
		try {
			let result = await reader.read();
			while (!result.done) {
				const wasUpToDate = this.upToDate;
				const text = await result.value.text();
				if (text) parts.push(text);
				if (wasUpToDate) break;
				result = await reader.read();
			}
		} finally {
			reader.releaseLock();
		}
		this.#markClosed();
		return parts.join(``);
	}
	/**
	* Internal helper to create the body stream without consumption check.
	* Used by both bodyStream() and textStream().
	*/
	#createBodyStreamInternal() {
		const { readable, writable } = new TransformStream();
		const reader = this.#getResponseReader();
		const pipeBodyStream = async () => {
			try {
				let result = await reader.read();
				while (!result.done) {
					const wasUpToDate = this.upToDate;
					const body = result.value.body;
					if (body) await body.pipeTo(writable, {
						preventClose: true,
						preventAbort: true,
						preventCancel: true
					});
					if (wasUpToDate && !this.#shouldContinueLive()) break;
					result = await reader.read();
				}
				await writable.close();
				this.#markClosed();
			} catch (err) {
				if (this.#abortController.signal.aborted) {
					try {
						await writable.close();
					} catch {}
					this.#markClosed();
				} else {
					try {
						await writable.abort(err);
					} catch {}
					this.#markError(err instanceof Error ? err : new Error(String(err)));
				}
			} finally {
				reader.releaseLock();
			}
		};
		pipeBodyStream();
		return readable;
	}
	bodyStream() {
		this.#ensureNoConsumption(`bodyStream`);
		return asAsyncIterableReadableStream(this.#createBodyStreamInternal());
	}
	jsonStream() {
		this.#ensureNoConsumption(`jsonStream`);
		this.#ensureJsonMode();
		const reader = this.#getResponseReader();
		let pendingItems = [];
		const stream$1 = new ReadableStream({
			pull: async (controller) => {
				if (pendingItems.length > 0) {
					controller.enqueue(pendingItems.shift());
					return;
				}
				let result = await reader.read();
				while (!result.done) {
					const response = result.value;
					const text = await response.text();
					const content = text.trim() || `[]`;
					let parsed;
					try {
						parsed = JSON.parse(content);
					} catch (err) {
						const preview = content.length > 100 ? content.slice(0, 100) + `...` : content;
						throw new DurableStreamError(`Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`, `PARSE_ERROR`);
					}
					pendingItems = Array.isArray(parsed) ? parsed : [parsed];
					if (pendingItems.length > 0) {
						controller.enqueue(pendingItems.shift());
						return;
					}
					result = await reader.read();
				}
				this.#markClosed();
				controller.close();
				return;
			},
			cancel: () => {
				reader.releaseLock();
				this.cancel();
			}
		});
		return asAsyncIterableReadableStream(stream$1);
	}
	textStream() {
		this.#ensureNoConsumption(`textStream`);
		const decoder = new TextDecoder();
		const stream$1 = this.#createBodyStreamInternal().pipeThrough(new TransformStream({
			transform(chunk, controller) {
				controller.enqueue(decoder.decode(chunk, { stream: true }));
			},
			flush(controller) {
				const remaining = decoder.decode();
				if (remaining) controller.enqueue(remaining);
			}
		}));
		return asAsyncIterableReadableStream(stream$1);
	}
	subscribeJson(subscriber) {
		this.#ensureNoConsumption(`subscribeJson`);
		this.#ensureJsonMode();
		const abortController = new AbortController();
		const reader = this.#getResponseReader();
		const consumeJsonSubscription = async () => {
			try {
				let result = await reader.read();
				while (!result.done) {
					if (abortController.signal.aborted) break;
					const response = result.value;
					const { offset, cursor, upToDate, streamClosed } = getMetadataFromResponse(response, this.offset, this.cursor, this.streamClosed);
					const text = await response.text();
					const content = text.trim() || `[]`;
					let parsed;
					try {
						parsed = JSON.parse(content);
					} catch (err) {
						const preview = content.length > 100 ? content.slice(0, 100) + `...` : content;
						throw new DurableStreamError(`Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`, `PARSE_ERROR`);
					}
					const items = Array.isArray(parsed) ? parsed : [parsed];
					await subscriber({
						items,
						offset,
						cursor,
						upToDate,
						streamClosed
					});
					result = await reader.read();
				}
				this.#markClosed();
			} catch (e) {
				const isAborted = abortController.signal.aborted;
				const isBodyError = e instanceof TypeError && String(e).includes(`Body`);
				if (!isAborted && !isBodyError) this.#markError(e instanceof Error ? e : new Error(String(e)));
				else this.#markClosed();
			} finally {
				reader.releaseLock();
			}
		};
		consumeJsonSubscription();
		return () => {
			abortController.abort();
			this.cancel();
		};
	}
	subscribeBytes(subscriber) {
		this.#ensureNoConsumption(`subscribeBytes`);
		const abortController = new AbortController();
		const reader = this.#getResponseReader();
		const consumeBytesSubscription = async () => {
			try {
				let result = await reader.read();
				while (!result.done) {
					if (abortController.signal.aborted) break;
					const response = result.value;
					const { offset, cursor, upToDate, streamClosed } = getMetadataFromResponse(response, this.offset, this.cursor, this.streamClosed);
					const buffer = await response.arrayBuffer();
					await subscriber({
						data: new Uint8Array(buffer),
						offset,
						cursor,
						upToDate,
						streamClosed
					});
					result = await reader.read();
				}
				this.#markClosed();
			} catch (e) {
				const isAborted = abortController.signal.aborted;
				const isBodyError = e instanceof TypeError && String(e).includes(`Body`);
				if (!isAborted && !isBodyError) this.#markError(e instanceof Error ? e : new Error(String(e)));
				else this.#markClosed();
			} finally {
				reader.releaseLock();
			}
		};
		consumeBytesSubscription();
		return () => {
			abortController.abort();
			this.cancel();
		};
	}
	subscribeText(subscriber) {
		this.#ensureNoConsumption(`subscribeText`);
		const abortController = new AbortController();
		const reader = this.#getResponseReader();
		const consumeTextSubscription = async () => {
			try {
				let result = await reader.read();
				while (!result.done) {
					if (abortController.signal.aborted) break;
					const response = result.value;
					const { offset, cursor, upToDate, streamClosed } = getMetadataFromResponse(response, this.offset, this.cursor, this.streamClosed);
					const text = await response.text();
					await subscriber({
						text,
						offset,
						cursor,
						upToDate,
						streamClosed
					});
					result = await reader.read();
				}
				this.#markClosed();
			} catch (e) {
				const isAborted = abortController.signal.aborted;
				const isBodyError = e instanceof TypeError && String(e).includes(`Body`);
				if (!isAborted && !isBodyError) this.#markError(e instanceof Error ? e : new Error(String(e)));
				else this.#markClosed();
			} finally {
				reader.releaseLock();
			}
		};
		consumeTextSubscription();
		return () => {
			abortController.abort();
			this.cancel();
		};
	}
	cancel(reason) {
		this.#abortController.abort(reason);
		this.#unsubscribeFromVisibilityChanges?.();
		this.#markClosed();
	}
	get closed() {
		return this.#closed;
	}
};
/**
* Extract stream metadata from Response headers.
* Falls back to the provided defaults when headers are absent.
*/
function getMetadataFromResponse(response, fallbackOffset, fallbackCursor, fallbackStreamClosed) {
	const offset = response.headers.get(STREAM_OFFSET_HEADER);
	const cursor = response.headers.get(STREAM_CURSOR_HEADER);
	const upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER);
	const streamClosed = response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`;
	return {
		offset: offset ?? fallbackOffset,
		cursor: cursor ?? fallbackCursor,
		upToDate,
		streamClosed: streamClosed || fallbackStreamClosed
	};
}
/**
* Decode base64 string to Uint8Array.
* Per protocol: concatenate data lines, remove \n and \r, then decode.
*/
function decodeBase64(base64Str) {
	const cleaned = base64Str.replace(/[\n\r]/g, ``);
	if (cleaned.length === 0) return new Uint8Array(0);
	if (cleaned.length % 4 !== 0) throw new DurableStreamError(`Invalid base64 data: length ${cleaned.length} is not a multiple of 4`, `PARSE_ERROR`);
	try {
		if (typeof Buffer !== `undefined`) return new Uint8Array(Buffer.from(cleaned, `base64`));
		else {
			const binaryStr = atob(cleaned);
			const bytes = new Uint8Array(binaryStr.length);
			for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
			return bytes;
		}
	} catch (err) {
		throw new DurableStreamError(`Failed to decode base64 data: ${err instanceof Error ? err.message : String(err)}`, `PARSE_ERROR`);
	}
}
/**
* Create a synthetic Response from SSE data with proper headers.
* Includes offset/cursor/upToDate/streamClosed in headers so subscribers can read them.
*/
function createSSESyntheticResponse(data, offset, cursor, upToDate, streamClosed, contentType, encoding) {
	return createSSESyntheticResponseFromParts([data], offset, cursor, upToDate, streamClosed, contentType, encoding);
}
/**
* Create a synthetic Response from multiple SSE data parts.
* For base64 mode, each part is independently encoded, so we decode each
* separately and concatenate the binary results.
* For text mode, parts are simply concatenated as strings.
*/
function createSSESyntheticResponseFromParts(dataParts, offset, cursor, upToDate, streamClosed, contentType, encoding, isJsonMode) {
	const headers = {
		"content-type": contentType ?? `application/json`,
		[STREAM_OFFSET_HEADER]: String(offset)
	};
	if (cursor) headers[STREAM_CURSOR_HEADER] = cursor;
	if (upToDate) headers[STREAM_UP_TO_DATE_HEADER] = `true`;
	if (streamClosed) headers[STREAM_CLOSED_HEADER] = `true`;
	let body;
	if (encoding === `base64`) {
		const decodedParts = dataParts.filter((part) => part.length > 0).map((part) => decodeBase64(part));
		if (decodedParts.length === 0) body = new ArrayBuffer(0);
		else if (decodedParts.length === 1) {
			const decoded = decodedParts[0];
			body = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
		} else {
			const totalLength = decodedParts.reduce((sum, part) => sum + part.length, 0);
			const combined = new Uint8Array(totalLength);
			let offset$1 = 0;
			for (const part of decodedParts) {
				combined.set(part, offset$1);
				offset$1 += part.length;
			}
			body = combined.buffer;
		}
	} else if (isJsonMode) {
		const mergedParts = [];
		for (const part of dataParts) {
			const trimmed = part.trim();
			if (trimmed.length === 0) continue;
			if (trimmed.startsWith(`[`) && trimmed.endsWith(`]`)) {
				const inner = trimmed.slice(1, -1).trim();
				if (inner.length > 0) mergedParts.push(inner);
			} else mergedParts.push(trimmed);
		}
		body = `[${mergedParts.join(`,`)}]`;
	} else body = dataParts.join(``);
	return new Response(body, {
		status: 200,
		headers
	});
}

//#endregion
//#region src/utils.ts
/**
* Resolve headers from HeadersRecord (supports async functions).
* Unified implementation used by both stream() and DurableStream.
*/
async function resolveHeaders(headers) {
	const resolved = {};
	if (!headers) return resolved;
	for (const [key, value] of Object.entries(headers)) if (typeof value === `function`) resolved[key] = await value();
	else resolved[key] = value;
	return resolved;
}
/**
* Handle error responses from the server.
* Throws appropriate DurableStreamError based on status code.
*/
async function handleErrorResponse(response, url, context) {
	const status = response.status;
	if (status === 404) throw new DurableStreamError(`Stream not found: ${url}`, `NOT_FOUND`, 404);
	if (status === 409) {
		const streamClosedHeader = response.headers.get(STREAM_CLOSED_HEADER);
		if (streamClosedHeader?.toLowerCase() === `true`) {
			const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? void 0;
			throw new StreamClosedError(url, finalOffset);
		}
		const message = context?.operation === `create` ? `Stream already exists: ${url}` : `Sequence conflict: seq is lower than last appended`;
		const code = context?.operation === `create` ? `CONFLICT_EXISTS` : `CONFLICT_SEQ`;
		throw new DurableStreamError(message, code, 409);
	}
	if (status === 400) throw new DurableStreamError(`Bad request (possibly content-type mismatch)`, `BAD_REQUEST`, 400);
	throw await DurableStreamError.fromResponse(response, url);
}
/**
* Resolve params from ParamsRecord (supports async functions).
*/
async function resolveParams(params) {
	const resolved = {};
	if (!params) return resolved;
	for (const [key, value] of Object.entries(params)) if (value !== void 0) if (typeof value === `function`) resolved[key] = await value();
	else resolved[key] = value;
	return resolved;
}
const warnedOrigins = new Set();
/**
* Safely read NODE_ENV without triggering "process is not defined" errors.
* Works in both browser and Node.js environments.
*/
function getNodeEnvSafely() {
	if (typeof process === `undefined`) return void 0;
	return process.env?.NODE_ENV;
}
/**
* Check if we're in a browser environment.
*/
function isBrowserEnvironment() {
	return typeof globalThis.window !== `undefined`;
}
/**
* Get window.location.href safely, returning undefined if not available.
*/
function getWindowLocationHref() {
	if (typeof globalThis.window !== `undefined` && typeof globalThis.window.location !== `undefined`) return globalThis.window.location.href;
	return void 0;
}
/**
* Resolve a URL string, handling relative URLs in browser environments.
* Returns undefined if the URL cannot be parsed.
*/
function resolveUrlMaybe(urlString) {
	try {
		return new URL(urlString);
	} catch {
		const base = getWindowLocationHref();
		if (base) try {
			return new URL(urlString, base);
		} catch {
			return void 0;
		}
		return void 0;
	}
}
/**
* Warn if using HTTP (not HTTPS) URL in a browser environment.
* HTTP typically limits browsers to ~6 concurrent connections per origin under HTTP/1.1,
* which can cause slow streams and app freezes with multiple active streams.
*
* Features:
* - Warns only once per origin to prevent log spam
* - Handles relative URLs by resolving against window.location.href
* - Safe to call in Node.js environments (no-op)
* - Skips warning during tests (NODE_ENV=test)
*/
function warnIfUsingHttpInBrowser(url, warnOnHttp) {
	if (warnOnHttp === false) return;
	const nodeEnv = getNodeEnvSafely();
	if (nodeEnv === `test`) return;
	if (!isBrowserEnvironment() || typeof console === `undefined` || typeof console.warn !== `function`) return;
	const urlStr = url instanceof URL ? url.toString() : url;
	const parsedUrl = resolveUrlMaybe(urlStr);
	if (!parsedUrl) return;
	if (parsedUrl.protocol === `http:`) {
		if (!warnedOrigins.has(parsedUrl.origin)) {
			warnedOrigins.add(parsedUrl.origin);
			console.warn("[DurableStream] Using HTTP (not HTTPS) typically limits browsers to ~6 concurrent connections per origin under HTTP/1.1. This can cause slow streams and app freezes with multiple active streams. Use HTTPS for HTTP/2 support. See https://electric-sql.com/r/electric-http2 for more information.");
		}
	}
}
/**
* Reset the HTTP warning state. Only exported for testing purposes.
* @internal
*/
function _resetHttpWarningForTesting() {
	warnedOrigins.clear();
}

//#endregion
//#region src/stream-api.ts
/**
* Create a streaming session to read from a durable stream.
*
* This is a fetch-like API:
* - The promise resolves after the first network request succeeds
* - It rejects for auth/404/other protocol errors
* - Returns a StreamResponse for consuming the data
*
* @example
* ```typescript
* // Catch-up JSON:
* const res = await stream<{ message: string }>({
*   url,
*   auth,
*   offset: "0",
*   live: false,
* })
* const items = await res.json()
*
* // Live JSON:
* const live = await stream<{ message: string }>({
*   url,
*   auth,
*   offset: savedOffset,
*   live: true,
* })
* live.subscribeJson(async (batch) => {
*   for (const item of batch.items) {
*     handle(item)
*   }
* })
* ```
*/
async function stream(options) {
	if (!options.url) throw new DurableStreamError(`Invalid stream options: missing required url parameter`, `BAD_REQUEST`);
	let currentHeaders = options.headers;
	let currentParams = options.params;
	while (true) try {
		return await streamInternal({
			...options,
			headers: currentHeaders,
			params: currentParams
		});
	} catch (err) {
		if (options.onError) {
			const retryOpts = await options.onError(err instanceof Error ? err : new Error(String(err)));
			if (retryOpts === void 0) throw err;
			if (retryOpts.params) currentParams = {
				...currentParams,
				...retryOpts.params
			};
			if (retryOpts.headers) currentHeaders = {
				...currentHeaders,
				...retryOpts.headers
			};
			continue;
		}
		throw err;
	}
}
/**
* Internal implementation of stream that doesn't handle onError retries.
*/
async function streamInternal(options) {
	const url = options.url instanceof URL ? options.url.toString() : options.url;
	warnIfUsingHttpInBrowser(url, options.warnOnHttp);
	const fetchUrl = new URL(url);
	const startOffset = options.offset ?? `-1`;
	fetchUrl.searchParams.set(OFFSET_QUERY_PARAM, startOffset);
	const live = options.live ?? true;
	const params = await resolveParams(options.params);
	for (const [key, value] of Object.entries(params)) fetchUrl.searchParams.set(key, value);
	const headers = await resolveHeaders(options.headers);
	const abortController = new AbortController();
	if (options.signal) options.signal.addEventListener(`abort`, () => abortController.abort(options.signal?.reason), { once: true });
	const baseFetchClient = options.fetch ?? ((...args) => fetch(...args));
	const backoffOptions = options.backoffOptions ?? BackoffDefaults;
	const fetchClient = createFetchWithBackoff(baseFetchClient, backoffOptions);
	let firstResponse;
	try {
		firstResponse = await fetchClient(fetchUrl.toString(), {
			method: `GET`,
			headers,
			signal: abortController.signal
		});
	} catch (err) {
		if (err instanceof FetchBackoffAbortError) throw new DurableStreamError(`Stream request was aborted`, `UNKNOWN`);
		throw err;
	}
	const contentType = firstResponse.headers.get(`content-type`) ?? void 0;
	const initialOffset = firstResponse.headers.get(STREAM_OFFSET_HEADER) ?? startOffset;
	const initialCursor = firstResponse.headers.get(STREAM_CURSOR_HEADER) ?? void 0;
	const initialUpToDate = firstResponse.headers.has(STREAM_UP_TO_DATE_HEADER);
	const initialStreamClosed = firstResponse.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`;
	const isJsonMode = options.json === true || (contentType?.includes(`application/json`) ?? false);
	const sseDataEncoding = firstResponse.headers.get(STREAM_SSE_DATA_ENCODING_HEADER);
	const encoding = sseDataEncoding === `base64` ? `base64` : void 0;
	const fetchNext = async (offset, cursor, signal, upToDate, resumingFromPause) => {
		const nextUrl = new URL(url);
		nextUrl.searchParams.set(OFFSET_QUERY_PARAM, offset);
		if (upToDate && !resumingFromPause) {
			if (live === true || live === `long-poll`) nextUrl.searchParams.set(LIVE_QUERY_PARAM, `long-poll`);
		}
		if (cursor) nextUrl.searchParams.set(`cursor`, cursor);
		const nextParams = await resolveParams(options.params);
		for (const [key, value] of Object.entries(nextParams)) nextUrl.searchParams.set(key, value);
		const nextHeaders = await resolveHeaders(options.headers);
		const response = await fetchClient(nextUrl.toString(), {
			method: `GET`,
			headers: nextHeaders,
			signal
		});
		if (!response.ok) await handleErrorResponse(response, url);
		return response;
	};
	const startSSE = live === `sse` ? async (offset, cursor, signal) => {
		const sseUrl = new URL(url);
		sseUrl.searchParams.set(OFFSET_QUERY_PARAM, offset);
		sseUrl.searchParams.set(LIVE_QUERY_PARAM, `sse`);
		if (cursor) sseUrl.searchParams.set(`cursor`, cursor);
		const sseParams = await resolveParams(options.params);
		for (const [key, value] of Object.entries(sseParams)) sseUrl.searchParams.set(key, value);
		const sseHeaders = await resolveHeaders(options.headers);
		const response = await fetchClient(sseUrl.toString(), {
			method: `GET`,
			headers: sseHeaders,
			signal
		});
		if (!response.ok) await handleErrorResponse(response, url);
		return response;
	} : void 0;
	return new StreamResponseImpl({
		url,
		contentType,
		live,
		startOffset,
		isJsonMode,
		initialOffset,
		initialCursor,
		initialUpToDate,
		initialStreamClosed,
		firstResponse,
		abortController,
		fetchNext,
		startSSE,
		sseResilience: options.sseResilience,
		encoding
	});
}

//#endregion
//#region src/idempotent-producer.ts
/**
* Error thrown when a producer's epoch is stale (zombie fencing).
*/
var StaleEpochError = class extends Error {
	/**
	* The current epoch on the server.
	*/
	currentEpoch;
	constructor(currentEpoch) {
		super(`Producer epoch is stale. Current server epoch: ${currentEpoch}. Call restart() or create a new producer with a higher epoch.`);
		this.name = `StaleEpochError`;
		this.currentEpoch = currentEpoch;
	}
};
/**
* Error thrown when an unrecoverable sequence gap is detected.
*
* With maxInFlight > 1, HTTP requests can arrive out of order at the server,
* causing temporary 409 responses. The client automatically handles these
* by waiting for earlier sequences to complete, then retrying.
*
* This error is only thrown when the gap cannot be resolved (e.g., the
* expected sequence is >= our sequence, indicating a true protocol violation).
*/
var SequenceGapError = class extends Error {
	expectedSeq;
	receivedSeq;
	constructor(expectedSeq, receivedSeq) {
		super(`Producer sequence gap: expected ${expectedSeq}, received ${receivedSeq}`);
		this.name = `SequenceGapError`;
		this.expectedSeq = expectedSeq;
		this.receivedSeq = receivedSeq;
	}
};
/**
* Normalize content-type by extracting the media type (before any semicolon).
*/
function normalizeContentType$1(contentType) {
	if (!contentType) return ``;
	return contentType.split(`;`)[0].trim().toLowerCase();
}
/**
* An idempotent producer for exactly-once writes to a durable stream.
*
* Features:
* - Fire-and-forget: append() returns immediately, batches in background
* - Exactly-once: server deduplicates using (producerId, epoch, seq)
* - Batching: multiple appends batched into single HTTP request
* - Pipelining: up to maxInFlight concurrent batches
* - Zombie fencing: stale producers rejected via epoch validation
*
* @example
* ```typescript
* const stream = new DurableStream({ url: "https://..." });
* const producer = new IdempotentProducer(stream, "order-service-1", {
*   epoch: 0,
*   autoClaim: true,
* });
*
* // Fire-and-forget writes (synchronous, returns immediately)
* producer.append("message 1");
* producer.append("message 2");
*
* // Ensure all messages are delivered before shutdown
* await producer.flush();
* await producer.close();
* ```
*/
var IdempotentProducer = class {
	#stream;
	#producerId;
	#epoch;
	#nextSeq = 0;
	#autoClaim;
	#maxBatchBytes;
	#lingerMs;
	#fetchClient;
	#headers;
	#signal;
	#onError;
	#pendingBatch = [];
	#batchBytes = 0;
	#lingerTimeout = null;
	#queue;
	#maxInFlight;
	#deferredEnqueues = new Set();
	#closed = false;
	#closeResult = null;
	#pendingFinalMessage;
	#lastSuccessfulOffset;
	#epochClaimed;
	#seqState = new Map();
	/**
	* Create an idempotent producer for a stream.
	*
	* @param stream - The DurableStream to write to
	* @param producerId - Stable identifier for this producer (e.g., "order-service-1")
	* @param opts - Producer options
	*/
	constructor(stream$1, producerId, opts) {
		const epoch = opts?.epoch ?? 0;
		const maxBatchBytes = opts?.maxBatchBytes ?? 1024 * 1024;
		const maxInFlight = opts?.maxInFlight ?? 5;
		const lingerMs = opts?.lingerMs ?? 5;
		if (epoch < 0) throw new Error(`epoch must be >= 0`);
		if (maxBatchBytes <= 0) throw new Error(`maxBatchBytes must be > 0`);
		if (maxInFlight <= 0) throw new Error(`maxInFlight must be > 0`);
		if (lingerMs < 0) throw new Error(`lingerMs must be >= 0`);
		this.#stream = stream$1;
		this.#producerId = producerId;
		this.#epoch = epoch;
		this.#autoClaim = opts?.autoClaim ?? false;
		this.#maxBatchBytes = maxBatchBytes;
		this.#lingerMs = lingerMs;
		this.#signal = opts?.signal;
		this.#headers = opts?.headers;
		this.#onError = opts?.onError;
		this.#fetchClient = opts?.fetch ?? ((...args) => fetch(...args));
		this.#maxInFlight = maxInFlight;
		this.#epochClaimed = !this.#autoClaim;
		this.#queue = fastq.default.promise(this.#batchWorker.bind(this), this.#maxInFlight);
		if (this.#signal) this.#signal.addEventListener(`abort`, () => {
			this.#rejectPendingBatch(new DurableStreamError(`Producer aborted`, `ALREADY_CLOSED`, void 0, void 0));
		}, { once: true });
	}
	/**
	* Append data to the stream.
	*
	* This is fire-and-forget: returns immediately after adding to the batch.
	* The message is batched and sent when:
	* - maxBatchBytes is reached
	* - lingerMs elapses
	* - flush() is called
	*
	* Errors are reported via onError callback if configured. Use flush() to
	* wait for all pending messages to be sent.
	*
	* For JSON streams, pass pre-serialized JSON strings.
	* For byte streams, pass string or Uint8Array.
	*
	* @param body - Data to append (string or Uint8Array)
	*
	* @example
	* ```typescript
	* // JSON stream
	* producer.append(JSON.stringify({ message: "hello" }));
	*
	* // Byte stream
	* producer.append("raw text data");
	* producer.append(new Uint8Array([1, 2, 3]));
	* ```
	*/
	append(body) {
		if (this.#closed) throw new DurableStreamError(`Producer is closed`, `ALREADY_CLOSED`, void 0, void 0);
		let bytes;
		if (typeof body === `string`) bytes = new TextEncoder().encode(body);
		else if (body instanceof Uint8Array) bytes = body;
		else throw new DurableStreamError(`append() requires string or Uint8Array. For objects, use JSON.stringify().`, `BAD_REQUEST`, 400, void 0);
		this.#pendingBatch.push({ body: bytes });
		this.#batchBytes += bytes.length;
		if (this.#batchBytes >= this.#maxBatchBytes) this.#enqueuePendingBatch();
		else if (!this.#lingerTimeout) this.#lingerTimeout = setTimeout(() => {
			this.#lingerTimeout = null;
			if (this.#pendingBatch.length > 0) this.#enqueuePendingBatch();
		}, this.#lingerMs);
	}
	/**
	* Send any pending batch immediately and wait for all in-flight batches.
	*
	* Call this before shutdown to ensure all messages are delivered.
	*/
	async flush() {
		if (this.#lingerTimeout) {
			clearTimeout(this.#lingerTimeout);
			this.#lingerTimeout = null;
		}
		if (this.#pendingBatch.length > 0) this.#enqueuePendingBatch();
		do {
			await this.#queue.drained();
			await Promise.all(this.#deferredEnqueues);
		} while (this.#deferredEnqueues.size > 0 || this.inFlightCount > 0);
	}
	/**
	* Stop the producer without closing the underlying stream.
	*
	* Use this when you want to:
	* - Hand off writing to another producer
	* - Keep the stream open for future writes
	* - Stop this producer but not signal EOF to readers
	*
	* Flushes any pending messages before detaching.
	* After calling detach(), further append() calls will throw.
	*/
	async detach() {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.flush();
		} catch {}
	}
	/**
	* Flush pending messages and close the underlying stream (EOF).
	*
	* This is the typical way to end a producer session. It:
	* 1. Flushes all pending messages
	* 2. Optionally appends a final message
	* 3. Closes the stream (no further appends permitted)
	*
	* **Idempotent**: Unlike `DurableStream.close({ body })`, this method is
	* idempotent even with a final message because it uses producer headers
	* for deduplication. Safe to retry on network failures.
	*
	* @param finalMessage - Optional final message to append atomically with close
	* @returns CloseResult with the final offset
	*/
	async close(finalMessage) {
		if (this.#closed) {
			if (this.#closeResult) return this.#closeResult;
			await this.flush();
			const result$1 = await this.#doClose(this.#pendingFinalMessage);
			this.#closeResult = result$1;
			return result$1;
		}
		this.#closed = true;
		this.#pendingFinalMessage = finalMessage;
		await this.flush();
		const result = await this.#doClose(finalMessage);
		this.#closeResult = result;
		return result;
	}
	/**
	* Actually close the stream with optional final message.
	* Uses producer headers for idempotency.
	*/
	async #doClose(finalMessage) {
		const contentType = this.#stream.contentType ?? `application/octet-stream`;
		const isJson = normalizeContentType$1(contentType) === `application/json`;
		let body;
		if (finalMessage !== void 0) {
			const bodyBytes = typeof finalMessage === `string` ? new TextEncoder().encode(finalMessage) : finalMessage;
			if (isJson) {
				const jsonStr = new TextDecoder().decode(bodyBytes);
				body = `[${jsonStr}]`;
			} else body = bodyBytes;
		}
		const seqForThisRequest = this.#nextSeq;
		const headers = await this.#buildHeaders({
			"content-type": contentType,
			[PRODUCER_ID_HEADER]: this.#producerId,
			[PRODUCER_EPOCH_HEADER]: this.#epoch.toString(),
			[PRODUCER_SEQ_HEADER]: seqForThisRequest.toString(),
			[STREAM_CLOSED_HEADER]: `true`
		});
		const response = await this.#fetchClient(this.#stream.url, {
			method: `POST`,
			headers,
			body,
			signal: this.#signal
		});
		if (response.status === 204) {
			this.#nextSeq = seqForThisRequest + 1;
			const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``;
			this.#recordSuccessfulOffset(finalOffset);
			return { finalOffset };
		}
		if (response.status === 200) {
			this.#nextSeq = seqForThisRequest + 1;
			const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``;
			this.#recordSuccessfulOffset(finalOffset);
			return { finalOffset };
		}
		if (response.status === 403) {
			const currentEpochStr = response.headers.get(PRODUCER_EPOCH_HEADER);
			const currentEpoch = currentEpochStr ? parseInt(currentEpochStr, 10) : this.#epoch;
			if (this.#autoClaim) {
				const newEpoch = currentEpoch + 1;
				this.#epoch = newEpoch;
				this.#nextSeq = 0;
				return this.#doClose(finalMessage);
			}
			throw new StaleEpochError(currentEpoch);
		}
		const error = await FetchError.fromResponse(response, this.#stream.url);
		throw error;
	}
	/**
	* Increment epoch and reset sequence.
	*
	* Call this when restarting the producer to establish a new session.
	* Flushes any pending messages first.
	*/
	async restart() {
		await this.flush();
		this.#epoch++;
		this.#nextSeq = 0;
	}
	/**
	* Current epoch for this producer.
	*/
	get epoch() {
		return this.#epoch;
	}
	/**
	* Next sequence number to be assigned.
	*/
	get nextSeq() {
		return this.#nextSeq;
	}
	/**
	* Number of messages in the current pending batch.
	*/
	get pendingCount() {
		return this.#pendingBatch.length;
	}
	/**
	* Number of batches currently in flight.
	*/
	get inFlightCount() {
		return this.#queue.length() + this.#queue.running();
	}
	/**
	* The greatest non-empty stream offset returned by a successful producer
	* append or close request.
	*/
	get lastSuccessfulOffset() {
		return this.#lastSuccessfulOffset;
	}
	/**
	* Enqueue the current pending batch for processing.
	*/
	#enqueuePendingBatch() {
		if (this.#pendingBatch.length === 0) return;
		const batch = this.#pendingBatch;
		this.#pendingBatch = [];
		this.#batchBytes = 0;
		if (this.#autoClaim && !this.#epochClaimed && this.inFlightCount > 0) {
			const deferred = this.#queue.drained().then(() => {
				this.#pushBatch(batch);
			}).finally(() => {
				this.#deferredEnqueues.delete(deferred);
			});
			this.#deferredEnqueues.add(deferred);
			deferred.catch(() => {});
		} else this.#pushBatch(batch);
	}
	#pushBatch(batch) {
		const seq = this.#nextSeq;
		this.#nextSeq++;
		this.#queue.push({
			batch,
			seq
		}).catch(() => {});
	}
	/**
	* Batch worker - processes batches via fastq.
	*/
	async #batchWorker(task) {
		const { batch, seq } = task;
		const epoch = this.#epoch;
		try {
			const result = await this.#doSendBatch(batch, seq, epoch);
			this.#recordSuccessfulOffset(result.offset);
			if (!this.#epochClaimed) this.#epochClaimed = true;
			this.#signalSeqComplete(epoch, seq, void 0);
		} catch (error) {
			this.#signalSeqComplete(epoch, seq, error);
			if (this.#onError) this.#onError(error);
			throw error;
		}
	}
	#recordSuccessfulOffset(offset) {
		if (offset && (!this.#lastSuccessfulOffset || offset > this.#lastSuccessfulOffset)) this.#lastSuccessfulOffset = offset;
	}
	/**
	* Signal that a sequence has completed (success or failure).
	*/
	#signalSeqComplete(epoch, seq, error) {
		let epochMap = this.#seqState.get(epoch);
		if (!epochMap) {
			epochMap = new Map();
			this.#seqState.set(epoch, epochMap);
		}
		const state = epochMap.get(seq);
		if (state) {
			state.resolved = true;
			state.error = error;
			for (const waiter of state.waiters) waiter(error);
			state.waiters = [];
		} else epochMap.set(seq, {
			resolved: true,
			error,
			waiters: []
		});
		const cleanupThreshold = seq - this.#maxInFlight * 3;
		if (cleanupThreshold > 0) {
			for (const oldSeq of epochMap.keys()) if (oldSeq < cleanupThreshold) epochMap.delete(oldSeq);
		}
	}
	/**
	* Wait for a specific sequence to complete.
	* Returns immediately if already completed.
	* Throws if the sequence failed.
	*/
	#waitForSeq(epoch, seq) {
		let epochMap = this.#seqState.get(epoch);
		if (!epochMap) {
			epochMap = new Map();
			this.#seqState.set(epoch, epochMap);
		}
		const state = epochMap.get(seq);
		if (state?.resolved) {
			if (state.error) return Promise.reject(state.error);
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const waiter = (err) => {
				if (err) reject(err);
				else resolve();
			};
			if (state) state.waiters.push(waiter);
			else epochMap.set(seq, {
				resolved: false,
				waiters: [waiter]
			});
		});
	}
	/**
	* Actually send the batch to the server.
	* Handles auto-claim retry on 403 (stale epoch) if autoClaim is enabled.
	* Does NOT implement general retry/backoff for network errors or 5xx responses.
	*/
	async #doSendBatch(batch, seq, epoch) {
		const contentType = this.#stream.contentType ?? `application/octet-stream`;
		const isJson = normalizeContentType$1(contentType) === `application/json`;
		let batchedBody;
		if (isJson) {
			const jsonStrings = batch.map((e) => new TextDecoder().decode(e.body));
			batchedBody = `[${jsonStrings.join(`,`)}]`;
		} else {
			const totalSize = batch.reduce((sum, e) => sum + e.body.length, 0);
			const concatenated = new Uint8Array(totalSize);
			let offset = 0;
			for (const entry of batch) {
				concatenated.set(entry.body, offset);
				offset += entry.body.length;
			}
			batchedBody = concatenated;
		}
		const url = this.#stream.url;
		const headers = await this.#buildHeaders({
			"content-type": contentType,
			[PRODUCER_ID_HEADER]: this.#producerId,
			[PRODUCER_EPOCH_HEADER]: epoch.toString(),
			[PRODUCER_SEQ_HEADER]: seq.toString()
		});
		const response = await this.#fetchClient(url, {
			method: `POST`,
			headers,
			body: batchedBody,
			signal: this.#signal
		});
		if (response.status === 204) return {
			offset: ``,
			duplicate: true
		};
		if (response.status === 200) {
			const resultOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``;
			return {
				offset: resultOffset,
				duplicate: false
			};
		}
		if (response.status === 403) {
			const currentEpochStr = response.headers.get(PRODUCER_EPOCH_HEADER);
			const currentEpoch = currentEpochStr ? parseInt(currentEpochStr, 10) : epoch;
			if (this.#autoClaim) {
				const newEpoch = currentEpoch + 1;
				this.#epoch = newEpoch;
				this.#nextSeq = 1;
				return this.#doSendBatch(batch, 0, newEpoch);
			}
			throw new StaleEpochError(currentEpoch);
		}
		if (response.status === 409) {
			const expectedSeqStr = response.headers.get(PRODUCER_EXPECTED_SEQ_HEADER);
			const expectedSeq = expectedSeqStr ? parseInt(expectedSeqStr, 10) : 0;
			if (expectedSeq < seq) {
				const waitPromises = [];
				for (let s = expectedSeq; s < seq; s++) waitPromises.push(this.#waitForSeq(epoch, s));
				await Promise.all(waitPromises);
				return this.#doSendBatch(batch, seq, epoch);
			}
			const receivedSeqStr = response.headers.get(PRODUCER_RECEIVED_SEQ_HEADER);
			const receivedSeq = receivedSeqStr ? parseInt(receivedSeqStr, 10) : seq;
			throw new SequenceGapError(expectedSeq, receivedSeq);
		}
		if (response.status === 400) {
			const error$1 = await DurableStreamError.fromResponse(response, url);
			throw error$1;
		}
		const error = await FetchError.fromResponse(response, url);
		throw error;
	}
	async #buildHeaders(protocolHeaders) {
		const streamHeaders = await this.#stream.resolveHeaders();
		const producerHeaders = await resolveHeaders(this.#headers);
		return {
			...streamHeaders,
			...producerHeaders,
			...protocolHeaders
		};
	}
	/**
	* Clear pending batch and report error.
	*/
	#rejectPendingBatch(error) {
		if (this.#onError && this.#pendingBatch.length > 0) this.#onError(error);
		this.#pendingBatch = [];
		this.#batchBytes = 0;
		if (this.#lingerTimeout) {
			clearTimeout(this.#lingerTimeout);
			this.#lingerTimeout = null;
		}
	}
};

//#endregion
//#region src/stream.ts
/**
* Normalize content-type by extracting the media type (before any semicolon).
* Handles cases like "application/json; charset=utf-8".
*/
function normalizeContentType(contentType) {
	if (!contentType) return ``;
	return contentType.split(`;`)[0].trim().toLowerCase();
}
/**
* Check if a value is a Promise or Promise-like (thenable).
*/
function isPromiseLike(value) {
	return value != null && typeof value.then === `function`;
}
/**
* A handle to a remote durable stream for read/write operations.
*
* This is a lightweight, reusable handle - not a persistent connection.
* It does not automatically start reading or listening.
* Create sessions as needed via stream().
*
* @example
* ```typescript
* // Create a new stream
* const stream = await DurableStream.create({
*   url: "https://streams.example.com/my-stream",
*   headers: { Authorization: "Bearer my-token" },
*   contentType: "application/json"
* });
*
* // Single write
* await stream.append(JSON.stringify({ message: "hello" }));
*
* // Read with the new API
* const res = await stream.stream<{ message: string }>();
* res.subscribeJson(async (batch) => {
*   for (const item of batch.items) {
*     console.log(item.message);
*   }
* });
* ```
*/
var DurableStream = class DurableStream {
	/**
	* The URL of the durable stream.
	*/
	url;
	/**
	* The content type of the stream (populated after connect/head/read).
	*/
	contentType;
	#options;
	#fetchClient;
	#baseFetchClient;
	#onError;
	#batchingEnabled;
	#queue;
	#buffer = [];
	/**
	* Create a cold handle to a stream.
	* No network IO is performed by the constructor.
	*/
	constructor(opts) {
		validateOptions(opts);
		const urlStr = opts.url instanceof URL ? opts.url.toString() : opts.url;
		this.url = urlStr;
		this.#options = {
			...opts,
			url: urlStr
		};
		this.#onError = opts.onError;
		if (opts.contentType) this.contentType = opts.contentType;
		this.#batchingEnabled = opts.batching !== false;
		if (this.#batchingEnabled) this.#queue = fastq.default.promise(this.#batchWorker.bind(this), 1);
		this.#baseFetchClient = opts.fetch ?? ((...args) => fetch(...args));
		const backOffOpts = { ...opts.backoffOptions ?? BackoffDefaults };
		const fetchWithBackoffClient = createFetchWithBackoff(this.#baseFetchClient, backOffOpts);
		this.#fetchClient = createFetchWithConsumedBody(fetchWithBackoffClient);
	}
	/**
	* Create a new stream (create-only PUT) and return a handle.
	* Fails with DurableStreamError(code="CONFLICT_EXISTS") if it already exists.
	*/
	static async create(opts) {
		const stream$1 = new DurableStream(opts);
		await stream$1.create({
			contentType: opts.contentType,
			ttlSeconds: opts.ttlSeconds,
			expiresAt: opts.expiresAt,
			body: opts.body,
			closed: opts.closed
		});
		return stream$1;
	}
	/**
	* Validate that a stream exists and fetch metadata via HEAD.
	* Returns a handle with contentType populated (if sent by server).
	*
	* **Important**: This only performs a HEAD request for validation - it does
	* NOT open a session or start reading data. To read from the stream, call
	* `stream()` on the returned handle.
	*
	* @example
	* ```typescript
	* // Validate stream exists before reading
	* const handle = await DurableStream.connect({ url })
	* const res = await handle.stream() // Now actually read
	* ```
	*/
	static async connect(opts) {
		const stream$1 = new DurableStream(opts);
		await stream$1.head();
		return stream$1;
	}
	/**
	* HEAD metadata for a stream without creating a handle.
	*/
	static async head(opts) {
		const stream$1 = new DurableStream(opts);
		return stream$1.head();
	}
	/**
	* Delete a stream without creating a handle.
	*/
	static async delete(opts) {
		const stream$1 = new DurableStream(opts);
		return stream$1.delete();
	}
	/**
	* HEAD metadata for this stream.
	*/
	async head(opts) {
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const response = await this.#baseFetchClient(fetchUrl.toString(), {
			method: `HEAD`,
			headers: requestHeaders,
			signal: opts?.signal ?? this.#options.signal
		});
		if (!response.ok) {
			if (response.status === 404) return { exists: false };
			await handleErrorResponse(response, this.url);
		}
		const contentType = response.headers.get(`content-type`) ?? void 0;
		const offset = response.headers.get(STREAM_OFFSET_HEADER) ?? void 0;
		const etag = response.headers.get(`etag`) ?? void 0;
		const cacheControl = response.headers.get(`cache-control`) ?? void 0;
		const streamClosed = response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`;
		if (contentType) this.contentType = contentType;
		return {
			exists: true,
			contentType,
			offset,
			etag,
			cacheControl,
			streamClosed
		};
	}
	/**
	* Create this stream (create-only PUT) using the URL/auth from the handle.
	*/
	async create(opts) {
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const contentType = opts?.contentType ?? this.#options.contentType;
		if (contentType) requestHeaders[`content-type`] = contentType;
		if (opts?.ttlSeconds !== void 0) requestHeaders[STREAM_TTL_HEADER] = String(opts.ttlSeconds);
		if (opts?.expiresAt) requestHeaders[STREAM_EXPIRES_AT_HEADER] = opts.expiresAt;
		if (opts?.closed) requestHeaders[STREAM_CLOSED_HEADER] = `true`;
		const body = encodeBody(opts?.body);
		const response = await this.#fetchClient(fetchUrl.toString(), {
			method: `PUT`,
			headers: requestHeaders,
			body,
			signal: this.#options.signal
		});
		if (!response.ok) await handleErrorResponse(response, this.url, { operation: `create` });
		const responseContentType = response.headers.get(`content-type`);
		if (responseContentType) this.contentType = responseContentType;
		else if (contentType) this.contentType = contentType;
		return this;
	}
	/**
	* Delete this stream.
	*/
	async delete(opts) {
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const response = await this.#fetchClient(fetchUrl.toString(), {
			method: `DELETE`,
			headers: requestHeaders,
			signal: opts?.signal ?? this.#options.signal
		});
		if (!response.ok) await handleErrorResponse(response, this.url);
	}
	/**
	* Close the stream, optionally with a final message.
	*
	* After closing:
	* - No further appends are permitted (server returns 409)
	* - Readers can observe the closed state and treat it as EOF
	* - The stream's data remains fully readable
	*
	* Closing is:
	* - **Durable**: The closed state is persisted
	* - **Monotonic**: Once closed, a stream cannot be reopened
	*
	* **Idempotency:**
	* - `close()` without body: Idempotent — safe to call multiple times
	* - `close({ body })` with body: NOT idempotent — throws `StreamClosedError`
	*   if stream is already closed (use `IdempotentProducer.close()` for
	*   idempotent close-with-body semantics)
	*
	* @returns CloseResult with the final offset
	* @throws StreamClosedError if called with body on an already-closed stream
	*/
	async close(opts) {
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const contentType = opts?.contentType ?? this.#options.contentType ?? this.contentType;
		if (contentType) requestHeaders[`content-type`] = contentType;
		requestHeaders[STREAM_CLOSED_HEADER] = `true`;
		let body;
		if (opts?.body !== void 0) {
			const isJson = normalizeContentType(contentType) === `application/json`;
			if (isJson) {
				const bodyStr = typeof opts.body === `string` ? opts.body : new TextDecoder().decode(opts.body);
				body = `[${bodyStr}]`;
			} else body = typeof opts.body === `string` ? opts.body : opts.body;
		}
		const response = await this.#fetchClient(fetchUrl.toString(), {
			method: `POST`,
			headers: requestHeaders,
			body,
			signal: opts?.signal ?? this.#options.signal
		});
		if (response.status === 409) {
			const isClosed = response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`;
			if (isClosed) {
				const finalOffset$1 = response.headers.get(STREAM_OFFSET_HEADER) ?? void 0;
				throw new StreamClosedError(this.url, finalOffset$1);
			}
		}
		if (!response.ok) await handleErrorResponse(response, this.url);
		const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``;
		return { finalOffset };
	}
	/**
	* Append a single payload to the stream.
	*
	* Batching: when batching is enabled (default), append() calls that overlap
	* in time (e.g. fired without awaiting each one) are coalesced into a
	* single POST while a prior POST is in flight. If every call is awaited
	* before the next is issued, no batching happens — each call becomes its
	* own roundtrip. For tight loops driving an async iterable (e.g. LLM
	* token streams), prefer `appendStream()` / `writable()` which pipe the
	* source over a single POST, or fire `append()` calls without awaiting
	* each one and await the last promise (and `close()`) at the end.
	*
	* - `body` must be string or Uint8Array.
	* - For JSON streams, pass pre-serialized JSON strings.
	* - `body` may also be a Promise that resolves to string or Uint8Array.
	* - Strings are encoded as UTF-8.
	* - `seq` (if provided) is sent as stream-seq (writer coordination).
	*
	* @example
	* ```typescript
	* // JSON stream - pass pre-serialized JSON (single write)
	* await stream.append(JSON.stringify({ message: "hello" }));
	*
	* // Byte stream
	* await stream.append("raw text data");
	* await stream.append(new Uint8Array([1, 2, 3]));
	*
	* // Promise value - awaited before buffering
	* await stream.append(fetchData());
	*
	* // High-frequency writes from an async iterable - fire-and-track-last
	* let last: Promise<void> = Promise.resolve();
	* for await (const chunk of source) {
	*   last = stream.append(JSON.stringify(chunk));
	* }
	* await last;
	* await stream.close();
	* ```
	*/
	async append(body, opts) {
		const resolvedBody = isPromiseLike(body) ? await body : body;
		if (this.#batchingEnabled && this.#queue) return this.#appendWithBatching(resolvedBody, opts);
		return this.#appendDirect(resolvedBody, opts);
	}
	/**
	* Direct append without batching (used when batching is disabled).
	*/
	async #appendDirect(body, opts) {
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const contentType = opts?.contentType ?? this.#options.contentType ?? this.contentType;
		if (contentType) requestHeaders[`content-type`] = contentType;
		if (opts?.seq) requestHeaders[STREAM_SEQ_HEADER] = opts.seq;
		const isJson = normalizeContentType(contentType) === `application/json`;
		let encodedBody;
		if (isJson) {
			const bodyStr = typeof body === `string` ? body : new TextDecoder().decode(body);
			encodedBody = `[${bodyStr}]`;
		} else if (typeof body === `string`) encodedBody = body;
		else encodedBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
		const response = await this.#fetchClient(fetchUrl.toString(), {
			method: `POST`,
			headers: requestHeaders,
			body: encodedBody,
			signal: opts?.signal ?? this.#options.signal
		});
		if (!response.ok) await handleErrorResponse(response, this.url);
	}
	/**
	* Append with batching - buffers messages and sends them in batches.
	*/
	async #appendWithBatching(body, opts) {
		return new Promise((resolve, reject) => {
			this.#buffer.push({
				data: body,
				seq: opts?.seq,
				contentType: opts?.contentType,
				signal: opts?.signal,
				resolve,
				reject
			});
			if (this.#queue.idle()) {
				const batch = this.#buffer.splice(0);
				this.#queue.push(batch).catch((err) => {
					for (const msg of batch) msg.reject(err);
				});
			}
		});
	}
	/**
	* Batch worker - processes batches of messages.
	*/
	async #batchWorker(batch) {
		try {
			await this.#sendBatch(batch);
			for (const msg of batch) msg.resolve();
			if (this.#buffer.length > 0) {
				const nextBatch = this.#buffer.splice(0);
				this.#queue.push(nextBatch).catch((err) => {
					for (const msg of nextBatch) msg.reject(err);
				});
			}
		} catch (error) {
			for (const msg of batch) msg.reject(error);
			for (const msg of this.#buffer) msg.reject(error);
			this.#buffer = [];
			throw error;
		}
	}
	/**
	* Send a batch of messages as a single POST request.
	*/
	async #sendBatch(batch) {
		if (batch.length === 0) return;
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const contentType = batch[0]?.contentType ?? this.#options.contentType ?? this.contentType;
		if (contentType) requestHeaders[`content-type`] = contentType;
		let highestSeq;
		for (let i = batch.length - 1; i >= 0; i--) if (batch[i].seq !== void 0) {
			highestSeq = batch[i].seq;
			break;
		}
		if (highestSeq) requestHeaders[STREAM_SEQ_HEADER] = highestSeq;
		const isJson = normalizeContentType(contentType) === `application/json`;
		let batchedBody;
		if (isJson) {
			const jsonStrings = batch.map((m) => typeof m.data === `string` ? m.data : new TextDecoder().decode(m.data));
			batchedBody = `[${jsonStrings.join(`,`)}]`;
		} else {
			const hasUint8Array = batch.some((m) => m.data instanceof Uint8Array);
			const hasString = batch.some((m) => typeof m.data === `string`);
			if (hasUint8Array && !hasString) {
				const chunks = batch.map((m) => m.data);
				const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
				const combined = new Uint8Array(totalLength);
				let offset = 0;
				for (const chunk of chunks) {
					combined.set(chunk, offset);
					offset += chunk.length;
				}
				batchedBody = combined;
			} else if (hasString && !hasUint8Array) batchedBody = batch.map((m) => m.data).join(``);
			else {
				const encoder = new TextEncoder();
				const chunks = batch.map((m) => typeof m.data === `string` ? encoder.encode(m.data) : m.data);
				const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
				const combined = new Uint8Array(totalLength);
				let offset = 0;
				for (const chunk of chunks) {
					combined.set(chunk, offset);
					offset += chunk.length;
				}
				batchedBody = combined;
			}
		}
		const signals = [];
		if (this.#options.signal) signals.push(this.#options.signal);
		for (const msg of batch) if (msg.signal) signals.push(msg.signal);
		const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : void 0;
		const response = await this.#fetchClient(fetchUrl.toString(), {
			method: `POST`,
			headers: requestHeaders,
			body: batchedBody,
			signal: combinedSignal
		});
		if (!response.ok) await handleErrorResponse(response, this.url);
	}
	/**
	* Append a streaming body to the stream.
	*
	* Supports piping from any ReadableStream or async iterable:
	* - `source` yields Uint8Array or string chunks.
	* - Strings are encoded as UTF-8; no delimiters are added.
	* - Internally uses chunked transfer or HTTP/2 streaming.
	*
	* @example
	* ```typescript
	* // Pipe from a ReadableStream
	* const readable = new ReadableStream({
	*   start(controller) {
	*     controller.enqueue("chunk 1");
	*     controller.enqueue("chunk 2");
	*     controller.close();
	*   }
	* });
	* await stream.appendStream(readable);
	*
	* // Pipe from an async generator
	* async function* generate() {
	*   yield "line 1\n";
	*   yield "line 2\n";
	* }
	* await stream.appendStream(generate());
	*
	* // Pipe from fetch response body
	* const response = await fetch("https://example.com/data");
	* await stream.appendStream(response.body!);
	* ```
	*/
	async appendStream(source, opts) {
		const { requestHeaders, fetchUrl } = await this.#buildRequest();
		const contentType = opts?.contentType ?? this.#options.contentType ?? this.contentType;
		if (contentType) requestHeaders[`content-type`] = contentType;
		if (opts?.seq) requestHeaders[STREAM_SEQ_HEADER] = opts.seq;
		const body = toReadableStream(source);
		const response = await this.#fetchClient(fetchUrl.toString(), {
			method: `POST`,
			headers: requestHeaders,
			body,
			duplex: `half`,
			signal: opts?.signal ?? this.#options.signal
		});
		if (!response.ok) await handleErrorResponse(response, this.url);
	}
	/**
	* Create a writable stream that pipes data to this durable stream.
	*
	* Returns a WritableStream that can be used with `pipeTo()` or
	* `pipeThrough()` from any ReadableStream source.
	*
	* Uses IdempotentProducer internally for:
	* - Automatic batching (controlled by lingerMs, maxBatchBytes)
	* - Exactly-once delivery semantics
	* - Streaming writes (doesn't buffer entire content in memory)
	*
	* @example
	* ```typescript
	* // Pipe from fetch response
	* const response = await fetch("https://example.com/data");
	* await response.body!.pipeTo(stream.writable());
	*
	* // Pipe through a transform
	* const readable = someStream.pipeThrough(new TextEncoderStream());
	* await readable.pipeTo(stream.writable());
	*
	* // With custom producer options
	* await source.pipeTo(stream.writable({
	*   producerId: "my-producer",
	*   lingerMs: 10,
	*   maxBatchBytes: 64 * 1024,
	* }));
	* ```
	*/
	writable(opts) {
		const producerId = opts?.producerId ?? `writable-${crypto.randomUUID().slice(0, 8)}`;
		let writeError = null;
		const producer = new IdempotentProducer(this, producerId, {
			autoClaim: true,
			headers: opts?.headers,
			lingerMs: opts?.lingerMs,
			maxBatchBytes: opts?.maxBatchBytes,
			onError: (error) => {
				if (!writeError) writeError = error;
				opts?.onError?.(error);
			},
			signal: opts?.signal ?? this.#options.signal
		});
		return new WritableStream({
			write(chunk) {
				producer.append(chunk);
			},
			async close() {
				await producer.close();
				if (writeError) throw writeError;
			},
			abort(_reason) {
				producer.detach().catch((err) => {
					opts?.onError?.(err);
				});
			}
		});
	}
	/**
	* Start a fetch-like streaming session against this handle's URL/headers/params.
	* The first request is made inside this method; it resolves when we have
	* a valid first response, or rejects on errors.
	*
	* Call-specific headers and params are merged with handle-level ones,
	* with call-specific values taking precedence.
	*
	* @example
	* ```typescript
	* const handle = await DurableStream.connect({
	*   url,
	*   headers: { Authorization: `Bearer ${token}` }
	* });
	* const res = await handle.stream<{ message: string }>();
	*
	* // Accumulate all JSON items
	* const items = await res.json();
	*
	* // Or stream live with ReadableStream
	* const reader = res.jsonStream().getReader();
	* let result = await reader.read();
	* while (!result.done) {
	*   console.log(result.value);
	*   result = await reader.read();
	* }
	*
	* // Or use subscriber for backpressure-aware consumption
	* res.subscribeJson(async (batch) => {
	*   for (const item of batch.items) {
	*     console.log(item);
	*   }
	* });
	* ```
	*/
	async stream(options) {
		const mergedHeaders = {
			...this.#options.headers,
			...options?.headers
		};
		const mergedParams = {
			...this.#options.params,
			...options?.params
		};
		return stream({
			url: this.url,
			headers: mergedHeaders,
			params: mergedParams,
			signal: options?.signal ?? this.#options.signal,
			fetch: this.#options.fetch,
			backoffOptions: this.#options.backoffOptions,
			offset: options?.offset,
			live: options?.live,
			json: options?.json,
			onError: options?.onError ?? this.#onError,
			warnOnHttp: options?.warnOnHttp ?? this.#options.warnOnHttp
		});
	}
	/**
	* Resolve the stream's configured headers.
	* Used by IdempotentProducer to merge auth headers into its requests.
	* @internal
	*/
	async resolveHeaders() {
		return resolveHeaders(this.#options.headers);
	}
	/**
	* Build request headers and URL.
	*/
	async #buildRequest() {
		const requestHeaders = await resolveHeaders(this.#options.headers);
		const fetchUrl = new URL(this.url);
		const params = await resolveParams(this.#options.params);
		for (const [key, value] of Object.entries(params)) fetchUrl.searchParams.set(key, value);
		return {
			requestHeaders,
			fetchUrl
		};
	}
};
/**
* Encode a body value to the appropriate format.
* Strings are encoded as UTF-8.
* Objects are JSON-serialized.
*/
function encodeBody(body) {
	if (body === void 0) return void 0;
	if (typeof body === `string`) return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof Blob || body instanceof FormData || body instanceof ReadableStream || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
	return new TextEncoder().encode(JSON.stringify(body));
}
/**
* Convert an async iterable to a ReadableStream.
*/
function toReadableStream(source) {
	if (source instanceof ReadableStream) return source.pipeThrough(new TransformStream({ transform(chunk, controller) {
		if (typeof chunk === `string`) controller.enqueue(new TextEncoder().encode(chunk));
		else controller.enqueue(chunk);
	} }));
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else if (typeof value === `string`) controller.enqueue(encoder.encode(value));
				else controller.enqueue(value);
			} catch (e) {
				controller.error(e);
			}
		},
		cancel() {
			iterator.return?.();
		}
	});
}
/**
* Validate stream options.
*/
function validateOptions(options) {
	if (!options.url) throw new MissingStreamUrlError();
	if (options.signal && !(options.signal instanceof AbortSignal)) throw new InvalidSignalError();
	warnIfUsingHttpInBrowser(options.url, options.warnOnHttp);
}

//#endregion
exports.BackoffDefaults = BackoffDefaults
exports.CURSOR_QUERY_PARAM = CURSOR_QUERY_PARAM
exports.DURABLE_STREAM_PROTOCOL_QUERY_PARAMS = DURABLE_STREAM_PROTOCOL_QUERY_PARAMS
exports.DurableStream = DurableStream
exports.DurableStreamError = DurableStreamError
exports.FetchBackoffAbortError = FetchBackoffAbortError
exports.FetchError = FetchError
exports.IdempotentProducer = IdempotentProducer
exports.InvalidSignalError = InvalidSignalError
exports.LIVE_QUERY_PARAM = LIVE_QUERY_PARAM
exports.MissingStreamUrlError = MissingStreamUrlError
exports.OFFSET_QUERY_PARAM = OFFSET_QUERY_PARAM
exports.PRODUCER_EPOCH_HEADER = PRODUCER_EPOCH_HEADER
exports.PRODUCER_EXPECTED_SEQ_HEADER = PRODUCER_EXPECTED_SEQ_HEADER
exports.PRODUCER_ID_HEADER = PRODUCER_ID_HEADER
exports.PRODUCER_RECEIVED_SEQ_HEADER = PRODUCER_RECEIVED_SEQ_HEADER
exports.PRODUCER_SEQ_HEADER = PRODUCER_SEQ_HEADER
exports.SSE_CLOSED_FIELD = SSE_CLOSED_FIELD
exports.SSE_COMPATIBLE_CONTENT_TYPES = SSE_COMPATIBLE_CONTENT_TYPES
exports.SSE_CURSOR_FIELD = SSE_CURSOR_FIELD
exports.SSE_OFFSET_FIELD = SSE_OFFSET_FIELD
exports.STREAM_CLOSED_HEADER = STREAM_CLOSED_HEADER
exports.STREAM_CURSOR_HEADER = STREAM_CURSOR_HEADER
exports.STREAM_EXPIRES_AT_HEADER = STREAM_EXPIRES_AT_HEADER
exports.STREAM_OFFSET_HEADER = STREAM_OFFSET_HEADER
exports.STREAM_SEQ_HEADER = STREAM_SEQ_HEADER
exports.STREAM_TTL_HEADER = STREAM_TTL_HEADER
exports.STREAM_UP_TO_DATE_HEADER = STREAM_UP_TO_DATE_HEADER
exports.SequenceGapError = SequenceGapError
exports.StaleEpochError = StaleEpochError
exports.StreamClosedError = StreamClosedError
exports._resetHttpWarningForTesting = _resetHttpWarningForTesting
exports.asAsyncIterableReadableStream = asAsyncIterableReadableStream
exports.createFetchWithBackoff = createFetchWithBackoff
exports.createFetchWithConsumedBody = createFetchWithConsumedBody
exports.stream = stream
exports.warnIfUsingHttpInBrowser = warnIfUsingHttpInBrowser