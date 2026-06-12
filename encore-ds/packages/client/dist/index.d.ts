//#region src/asyncIterableReadableStream.d.ts
/**
* Async iterable polyfill for ReadableStream.
*
* Safari/iOS may not implement ReadableStream.prototype[Symbol.asyncIterator],
* preventing `for await...of` consumption. This module provides a soft polyfill
* that defines [Symbol.asyncIterator] on individual stream instances when missing,
* without patching the global prototype.
*
* The returned stream is still the original ReadableStream instance (not wrapped),
* so `instanceof ReadableStream` continues to work correctly.
*
* **Note on derived streams**: Streams created via `.pipeThrough()` or similar
* transformations will NOT be automatically patched. Use the exported
* `asAsyncIterableReadableStream()` helper to patch derived streams:
*
* ```typescript
* import { asAsyncIterableReadableStream } from "@durable-streams/client"
*
* const derived = res.bodyStream().pipeThrough(myTransform)
* const iterable = asAsyncIterableReadableStream(derived)
* for await (const chunk of iterable) { ... }
* ```
*/
/**
* A ReadableStream that is guaranteed to be async-iterable.
*
* This intersection type ensures TypeScript knows the stream can be consumed
* via `for await...of` syntax.
*/
type ReadableStreamAsyncIterable<T> = ReadableStream<T> & AsyncIterable<T>;
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
declare function asAsyncIterableReadableStream<T>(stream: ReadableStream<T>): ReadableStreamAsyncIterable<T>;

//#endregion
//#region src/fetch.d.ts
/**
* Options for configuring exponential backoff retry behavior.
*/
interface BackoffOptions {
  /**
  * Initial delay before retrying in milliseconds.
  */
  initialDelay: number;
  /**
  * Maximum retry delay in milliseconds.
  * After reaching this, delay stays constant.
  */
  maxDelay: number;
  /**
  * Multiplier for exponential backoff.
  */
  multiplier: number;
  /**
  * Callback invoked on each failed attempt.
  */
  onFailedAttempt?: () => void;
  /**
  * Enable debug logging.
  */
  debug?: boolean;
  /**
  * Maximum number of retry attempts before giving up.
  * Set to Infinity for indefinite retries (useful for offline scenarios).
  */
  maxRetries?: number;
}
/**
* Default backoff options.
*/
declare const BackoffDefaults: BackoffOptions;
/**
* Parse Retry-After header value and return delay in milliseconds.
* Supports both delta-seconds format and HTTP-date format.
* Returns 0 if header is not present or invalid.
*/

/**
* Creates a fetch client that retries failed requests with exponential backoff.
*
* @param fetchClient - The base fetch client to wrap
* @param backoffOptions - Options for retry behavior
* @returns A fetch function with automatic retry
*/
declare function createFetchWithBackoff(fetchClient: typeof fetch, backoffOptions?: BackoffOptions): typeof fetch;
/**
* Creates a fetch client that ensures the response body is fully consumed.
* This prevents issues with connection pooling when bodies aren't read.
*
* Uses arrayBuffer() instead of text() to preserve binary data integrity.
*
* @param fetchClient - The base fetch client to wrap
* @returns A fetch function that consumes response bodies
*/
declare function createFetchWithConsumedBody(fetchClient: typeof fetch): typeof fetch;

//#endregion
//#region src/types.d.ts
/**
* Chains an AbortController to an optional source signal.
* If the source signal is aborted, the provided controller will also abort.
*/
/**
* Offset string - opaque to the client.
* Format: "<read-seq>_<byte-offset>"
*
* **Special value**: `-1` means "start of stream" - use this to read from the beginning.
*
* Always use the returned `offset` field from reads/follows as the next `offset` you pass in.
*/
type Offset = string;
/**
* Type for values that can be provided immediately or resolved asynchronously.
*/
type MaybePromise<T> = T | Promise<T>;
/**
* Headers record where values can be static strings or async functions.
* Following the @electric-sql/client pattern for dynamic headers.
*
* **Important**: Functions are called **for each request**, not once per session.
* In live mode with long-polling, the same function may be called many times
* to fetch fresh values (e.g., refreshed auth tokens) for each poll.
*
* @example
* ```typescript
* headers: {
*   Authorization: `Bearer ${token}`,           // Static - same for all requests
*   'X-Tenant-Id': () => getCurrentTenant(),    // Called per-request
*   'X-Auth': async () => await refreshToken()  // Called per-request (can refresh)
* }
* ```
*/
type HeadersRecord = {
  [key: string]: string | (() => MaybePromise<string>);
};
/**
* Params record where values can be static or async functions.
* Following the @electric-sql/client pattern for dynamic params.
*
* **Important**: Functions are called **for each request**, not once per session.
* In live mode, the same function may be called multiple times to fetch
* fresh parameter values for each poll.
*/
type ParamsRecord = {
  [key: string]: string | (() => MaybePromise<string>) | undefined;
};
/**
* Live mode for reading from a stream.
* - false: Catch-up only, stop at first `upToDate`
* - true: Auto-select best mode (SSE for JSON streams, long-poll for binary)
* - "long-poll": Explicit long-poll mode for live updates
* - "sse": Explicit server-sent events for live updates
*/
type LiveMode = boolean | `long-poll` | `sse`;
/**
* Options for the stream() function (read-only API).
*/
interface StreamOptions {
  /**
  * The full URL to the durable stream.
  * E.g., "https://streams.example.com/my-account/chat/room-1"
  */
  url: string | URL;
  /**
  * HTTP headers to include in requests.
  * Values can be strings or functions (sync or async) that return strings.
  *
  * **Important**: Functions are evaluated **per-request** (not per-session).
  * In live mode, functions are called for each poll, allowing fresh values
  * like refreshed auth tokens.
  *
  * @example
  * ```typescript
  * headers: {
  *   Authorization: `Bearer ${token}`,           // Static
  *   'X-Tenant-Id': () => getCurrentTenant(),    // Evaluated per-request
  *   'X-Auth': async () => await refreshToken()  // Evaluated per-request
  * }
  * ```
  */
  headers?: HeadersRecord;
  /**
  * Query parameters to include in requests.
  * Values can be strings or functions (sync or async) that return strings.
  *
  * **Important**: Functions are evaluated **per-request** (not per-session).
  */
  params?: ParamsRecord;
  /**
  * AbortSignal for cancellation.
  */
  signal?: AbortSignal;
  /**
  * Custom fetch implementation (for auth layers, proxies, etc.).
  * Defaults to globalThis.fetch.
  */
  fetch?: typeof globalThis.fetch;
  /**
  * Backoff options for retry behavior.
  * Defaults to exponential backoff with jitter.
  */
  backoffOptions?: BackoffOptions;
  /**
  * Starting offset (query param ?offset=...).
  * If omitted, defaults to "-1" (start of stream).
  * You can also explicitly pass "-1" to read from the beginning.
  */
  offset?: Offset;
  /**
  * Live mode behavior:
  * - false: Catch-up only, stop at first `upToDate`
  * - true (default): Auto-select best mode (SSE for JSON, long-poll for binary)
  * - "long-poll": Explicit long-poll mode for live updates
  * - "sse": Explicit server-sent events for live updates
  */
  live?: LiveMode;
  /**
  * Hint: treat content as JSON even if Content-Type doesn't say so.
  */
  json?: boolean;
  /**
  * Error handler for recoverable errors (following Electric client pattern).
  */
  onError?: StreamErrorHandler;
  /**
  * SSE resilience options.
  * When SSE connections fail repeatedly, the client can automatically
  * fall back to long-polling mode.
  */
  sseResilience?: SSEResilienceOptions;
  /**
  * Whether to warn when using HTTP (not HTTPS) URLs in browser environments.
  * HTTP limits browsers to 6 concurrent connections (HTTP/1.1), which can
  * cause slow streams and app freezes with multiple active streams.
  *
  * @default true
  */
  warnOnHttp?: boolean;
}
/**
* Options for SSE connection resilience.
*/
interface SSEResilienceOptions {
  /**
  * Minimum expected SSE connection duration in milliseconds.
  * Connections shorter than this are considered "short" and may indicate
  * proxy buffering or server misconfiguration.
  * @default 1000
  */
  minConnectionDuration?: number;
  /**
  * Maximum number of consecutive short connections before falling back to long-poll.
  * @default 3
  */
  maxShortConnections?: number;
  /**
  * Base delay for exponential backoff between short connection retries (ms).
  * @default 100
  */
  backoffBaseDelay?: number;
  /**
  * Maximum delay cap for exponential backoff (ms).
  * @default 5000
  */
  backoffMaxDelay?: number;
  /**
  * Whether to log warnings when falling back to long-poll.
  * @default true
  */
  logWarnings?: boolean;
}
/**
* Metadata for a JSON batch or chunk.
*/
interface JsonBatchMeta {
  /**
  * Last Stream-Next-Offset for this batch.
  */
  offset: Offset;
  /**
  * True if this batch ends at the current end of the stream.
  */
  upToDate: boolean;
  /**
  * Last Stream-Cursor / streamCursor, if present.
  */
  cursor?: string;
  /**
  * Whether the stream is closed and this batch contains the final data.
  * When true, no more data will ever be appended to the stream.
  */
  streamClosed: boolean;
}
/**
* A batch of parsed JSON items with metadata.
*/
interface JsonBatch<T = unknown> extends JsonBatchMeta {
  /**
  * The parsed JSON items in this batch.
  */
  items: ReadonlyArray<T>;
}
/**
* A chunk of raw bytes with metadata.
*/
interface ByteChunk extends JsonBatchMeta {
  /**
  * The raw byte data.
  */
  data: Uint8Array;
}
/**
* A chunk of text with metadata.
*/
interface TextChunk extends JsonBatchMeta {
  /**
  * The text content.
  */
  text: string;
}
/**
* Base options for StreamHandle operations.
*/
interface StreamHandleOptions {
  /**
  * The full URL to the durable stream.
  * E.g., "https://streams.example.com/my-account/chat/room-1"
  */
  url: string | URL;
  /**
  * HTTP headers to include in requests.
  * Values can be strings or functions (sync or async) that return strings.
  *
  * Functions are evaluated **per-request** (not per-session).
  */
  headers?: HeadersRecord;
  /**
  * Query parameters to include in requests.
  * Values can be strings or functions (sync or async) that return strings.
  *
  * Functions are evaluated **per-request** (not per-session).
  */
  params?: ParamsRecord;
  /**
  * Custom fetch implementation.
  * Defaults to globalThis.fetch.
  */
  fetch?: typeof globalThis.fetch;
  /**
  * Default AbortSignal for operations.
  */
  signal?: AbortSignal;
  /**
  * The content type for the stream.
  */
  contentType?: string;
  /**
  * Error handler for recoverable errors.
  */
  onError?: StreamErrorHandler;
  /**
  * Enable automatic batching for append() calls.
  * When true, multiple append() calls made while a POST is in-flight
  * will be batched together into a single request.
  *
  * @default true
  */
  batching?: boolean;
  /**
  * Whether to warn when using HTTP (not HTTPS) URLs in browser environments.
  * HTTP limits browsers to 6 concurrent connections (HTTP/1.1), which can
  * cause slow streams and app freezes with multiple active streams.
  *
  * @default true
  */
  warnOnHttp?: boolean;
}
/**
* Options for creating a new stream.
*/
interface CreateOptions extends StreamHandleOptions {
  /**
  * Time-to-live in seconds (relative TTL).
  */
  ttlSeconds?: number;
  /**
  * Absolute expiry time (RFC3339 format).
  */
  expiresAt?: string;
  /**
  * Initial body to append on creation.
  */
  body?: BodyInit | Uint8Array | string;
  /**
  * Enable automatic batching for append() calls.
  * When true, multiple append() calls made while a POST is in-flight
  * will be batched together into a single request.
  *
  * @default true
  */
  batching?: boolean;
  /**
  * If true, create the stream in the closed state.
  * Any body provided becomes the complete and final content.
  *
  * Useful for:
  * - Cached responses
  * - Placeholder errors
  * - Pre-computed results
  * - Single-message streams that are immediately complete
  */
  closed?: boolean;
}
/**
* Options for appending data to a stream.
*/
interface AppendOptions {
  /**
  * Writer coordination sequence (stream-seq header).
  * Monotonic, lexicographic sequence for coordinating multiple writers.
  * If lower than last appended seq, server returns 409 Conflict.
  * Not related to read offsets.
  */
  seq?: string;
  /**
  * Content type for this append.
  * Must match the stream's content type.
  */
  contentType?: string;
  /**
  * AbortSignal for this operation.
  */
  signal?: AbortSignal;
  /**
  * Producer ID for idempotent writes.
  * Client-supplied stable identifier (e.g., "order-service-1").
  * Must be provided together with producerEpoch and producerSeq.
  */
  producerId?: string;
  /**
  * Producer epoch for idempotent writes.
  * Client-declared, server-validated monotonically increasing.
  * Increment on producer restart.
  */
  producerEpoch?: number;
  /**
  * Producer sequence for idempotent writes.
  * Monotonically increasing per epoch, per-batch.
  */
  producerSeq?: number;
}
/**
* Result of a close operation.
*/
interface CloseResult {
  /**
  * The final offset of the stream.
  * This is the offset after the last byte (including any final message).
  * Returned via the `Stream-Next-Offset` header.
  */
  finalOffset: Offset;
}
/**
* Options for closing a stream.
*/
interface CloseOptions {
  /**
  * Optional final message to append atomically with close.
  * For JSON streams, pass a pre-serialized JSON string.
  * Strings are UTF-8 encoded.
  */
  body?: Uint8Array | string;
  /**
  * Content type for the final message.
  * Defaults to the stream's content type. Must match if provided.
  */
  contentType?: string;
  /**
  * AbortSignal for this operation.
  */
  signal?: AbortSignal;
}
/**
* Legacy live mode type (internal use only).
* @internal
*/
type LegacyLiveMode = `long-poll` | `sse`;
/**
* Options for reading from a stream (internal iterator options).
* @internal
*/
interface ReadOptions {
  /**
  * Starting offset, passed as ?offset=...
  * If omitted, defaults to "-1" (start of stream).
  */
  offset?: Offset;
  /**
  * Live mode behavior:
  * - undefined/true (default): Catch-up then auto-select SSE or long-poll for live updates
  * - false: Only catch-up, stop after up-to-date (no live updates)
  * - "long-poll": Use long-polling for live updates
  * - "sse": Use SSE for live updates (throws if unsupported)
  */
  live?: boolean | LegacyLiveMode;
  /**
  * Override cursor for the request.
  * By default, the client echoes the last stream-cursor value.
  */
  cursor?: string;
  /**
  * AbortSignal for this operation.
  */
  signal?: AbortSignal;
}
/**
* Result from a HEAD request when the stream exists.
*/
interface HeadResultExists {
  /**
  * Whether the stream exists.
  */
  exists: true;
  /**
  * The stream's content type.
  */
  contentType?: string;
  /**
  * The tail offset (next offset after current end of stream).
  * Provided by server as stream-offset header on HEAD.
  */
  offset?: Offset;
  /**
  * ETag for the stream (format: {internal_stream_id}:{end_offset}).
  */
  etag?: string;
  /**
  * Cache-Control header value.
  */
  cacheControl?: string;
  /**
  * Whether the stream is closed.
  * When true, no further appends are permitted.
  */
  streamClosed: boolean;
}
/**
* Result from a HEAD request when the stream does not exist.
*/
interface HeadResultNotFound {
  exists: false;
}
/**
* Result from a HEAD request on a stream.
*/
type HeadResult = HeadResultExists | HeadResultNotFound;
/**
* Metadata extracted from a stream response.
* Contains headers and control information from the stream server.
*/

/**
* Error codes for DurableStreamError.
*/
type DurableStreamErrorCode = `NOT_FOUND` | `CONFLICT_SEQ` | `CONFLICT_EXISTS` | `BAD_REQUEST` | `BUSY` | `SSE_NOT_SUPPORTED` | `UNAUTHORIZED` | `FORBIDDEN` | `RATE_LIMITED` | `ALREADY_CONSUMED` | `ALREADY_CLOSED` | `PARSE_ERROR` | `STREAM_CLOSED` | `UNKNOWN`;
/**
* Options returned from onError handler to retry with modified params/headers.
* Following the Electric client pattern.
*/
type RetryOpts = {
  params?: ParamsRecord;
  headers?: HeadersRecord;
};
/**
* Error handler callback type.
*
* Called when a recoverable error occurs during streaming.
*
* **Return value behavior** (following Electric client pattern):
* - Return `{}` (empty object) → Retry immediately with same params/headers
* - Return `{ params }` → Retry with merged params (existing params preserved)
* - Return `{ headers }` → Retry with merged headers (existing headers preserved)
* - Return `void` or `undefined` → Stop stream and propagate the error
* - Return `null` → INVALID (will cause error - use `{}` instead)
*
* **Important**: To retry, you MUST return an object (can be empty `{}`).
* Returning nothing (`void`), explicitly returning `undefined`, or omitting
* a return statement all stop the stream. Do NOT return `null`.
*
* Note: Automatic retries with exponential backoff are already applied
* for 5xx server errors, network errors, and 429 rate limits before
* this handler is called.
*
* @example
* ```typescript
* // Retry on any error (returns empty object)
* onError: (error) => ({})
*
* // Refresh auth token on 401, propagate other errors
* onError: async (error) => {
*   if (error instanceof FetchError && error.status === 401) {
*     const newToken = await refreshAuthToken()
*     return { headers: { Authorization: `Bearer ${newToken}` } }
*   }
*   // Implicitly returns undefined - error will propagate
* }
*
* // Conditionally retry with explicit propagation
* onError: (error) => {
*   if (shouldRetry(error)) {
*     return {} // Retry
*   }
*   return undefined // Explicitly propagate error
* }
* ```
*/
type StreamErrorHandler = (error: Error) => void | RetryOpts | Promise<void | RetryOpts>;
/**
* A streaming session returned by stream() or DurableStream.stream().
*
* Represents a live session with fixed `url`, `offset`, and `live` parameters.
* Supports multiple consumption styles: Promise helpers, ReadableStreams,
* and Subscribers.
*
* @typeParam TJson - The type of JSON items in the stream.
*/
interface StreamResponse<TJson = unknown> {
  /**
  * The stream URL.
  */
  readonly url: string;
  /**
  * The stream's content type (from first response).
  */
  readonly contentType?: string;
  /**
  * The live mode for this session.
  */
  readonly live: LiveMode;
  /**
  * The starting offset for this session.
  */
  readonly startOffset: Offset;
  /**
  * HTTP response headers from the most recent server response.
  * Updated on each long-poll/SSE response.
  */
  readonly headers: Headers;
  /**
  * HTTP status code from the most recent server response.
  * Updated on each long-poll/SSE response.
  */
  readonly status: number;
  /**
  * HTTP status text from the most recent server response.
  * Updated on each long-poll/SSE response.
  */
  readonly statusText: string;
  /**
  * Whether the most recent response was successful (status 200-299).
  * Always true for active streams (errors are thrown).
  */
  readonly ok: boolean;
  /**
  * Whether the stream is waiting for initial data.
  *
  * Note: Always false in current implementation because stream() awaits
  * the first response before returning. A future async iterator API
  * could expose this as true during initial connection.
  */
  readonly isLoading: boolean;
  /**
  * The next offset to read from (Stream-Next-Offset header).
  *
  * **Important**: This value advances **after data is delivered to the consumer**,
  * not just after fetching from the server. The offset represents the position
  * in the stream that follows the data most recently provided to your consumption
  * method (body(), json(), bodyStream(), subscriber callback, etc.).
  *
  * Use this for resuming reads after a disconnect or saving checkpoints.
  */
  readonly offset: Offset;
  /**
  * Stream cursor for CDN collapsing (stream-cursor header).
  *
  * Updated after each chunk is delivered to the consumer.
  */
  readonly cursor?: string;
  /**
  * Whether we've reached the current end of the stream (stream-up-to-date header).
  *
  * Updated after each chunk is delivered to the consumer.
  */
  readonly upToDate: boolean;
  /**
  * Whether the stream is closed (EOF).
  *
  * When true, no more data will ever be appended to the stream.
  * This is updated after each chunk is delivered to the consumer.
  *
  * In live mode, when streamClosed becomes true:
  * - Long-poll requests return immediately (no waiting)
  * - SSE connections are closed by the server
  * - Clients stop reconnecting automatically
  */
  readonly streamClosed: boolean;
  /**
  * Accumulate raw bytes until first `upToDate` batch, then resolve.
  * When used with `live: true`, signals the session to stop after upToDate.
  */
  body: () => Promise<Uint8Array>;
  /**
  * Accumulate JSON *items* across batches into a single array, resolve at `upToDate`.
  * Only valid in JSON-mode; throws otherwise.
  * When used with `live: true`, signals the session to stop after upToDate.
  */
  json: <T = TJson>() => Promise<Array<T>>;
  /**
  * Accumulate text chunks into a single string, resolve at `upToDate`.
  * When used with `live: true`, signals the session to stop after upToDate.
  */
  text: () => Promise<string>;
  /**
  * Raw bytes as a ReadableStream<Uint8Array>.
  *
  * The returned stream is guaranteed to be async-iterable, so you can use
  * `for await...of` syntax even on Safari/iOS which may lack native support.
  */
  bodyStream: () => ReadableStreamAsyncIterable<Uint8Array>;
  /**
  * Individual JSON items (flattened) as a ReadableStream<TJson>.
  * Built on jsonBatches().
  *
  * The returned stream is guaranteed to be async-iterable, so you can use
  * `for await...of` syntax even on Safari/iOS which may lack native support.
  */
  jsonStream: () => ReadableStreamAsyncIterable<TJson>;
  /**
  * Text chunks as ReadableStream<string>.
  *
  * The returned stream is guaranteed to be async-iterable, so you can use
  * `for await...of` syntax even on Safari/iOS which may lack native support.
  */
  textStream: () => ReadableStreamAsyncIterable<string>;
  /**
  * Subscribe to JSON batches as they arrive.
  * Returns unsubscribe function.
  *
  * The subscriber can be sync or async. If async, backpressure is applied
  * (the next batch waits for the previous callback to complete).
  */
  subscribeJson: <T = TJson>(subscriber: (batch: JsonBatch<T>) => void | Promise<void>) => () => void;
  /**
  * Subscribe to raw byte chunks as they arrive.
  * Returns unsubscribe function.
  *
  * The subscriber can be sync or async. If async, backpressure is applied
  * (the next chunk waits for the previous callback to complete).
  */
  subscribeBytes: (subscriber: (chunk: ByteChunk) => void | Promise<void>) => () => void;
  /**
  * Subscribe to text chunks as they arrive.
  * Returns unsubscribe function.
  *
  * The subscriber can be sync or async. If async, backpressure is applied
  * (the next chunk waits for the previous callback to complete).
  */
  subscribeText: (subscriber: (chunk: TextChunk) => void | Promise<void>) => () => void;
  /**
  * Cancel the underlying session (abort HTTP, close SSE, stop long-polls).
  */
  cancel: (reason?: unknown) => void;
  /**
  * Resolves when the session has fully closed:
  * - `live:false` and up-to-date reached,
  * - manual cancellation,
  * - terminal error.
  */
  readonly closed: Promise<void>;
}
/**
* Options for creating an IdempotentProducer.
*/
interface IdempotentProducerOptions {
  /**
  * Starting epoch (default: 0).
  * Increment this on producer restart.
  */
  epoch?: number;
  /**
  * On 403 Forbidden (stale epoch), automatically retry with epoch+1.
  * Useful for serverless/ephemeral producers.
  * @default false
  */
  autoClaim?: boolean;
  /**
  * Maximum bytes before sending a batch.
  * @default 1048576 (1MB)
  */
  maxBatchBytes?: number;
  /**
  * Maximum time to wait for more messages before sending batch (ms).
  * @default 5
  */
  lingerMs?: number;
  /**
  * Maximum number of concurrent batches in flight.
  * Higher values improve throughput at the cost of more memory.
  * @default 5
  */
  maxInFlight?: number;
  /**
  * Custom fetch implementation.
  */
  fetch?: typeof globalThis.fetch;
  /**
  * HTTP headers to include on producer batch and close requests.
  *
  * These are merged with headers configured on the DurableStream handle. Producer
  * headers take precedence over stream headers, except for protocol-controlled
  * headers such as content-type, Producer-*, and Stream-Closed.
  */
  headers?: HeadersRecord;
  /**
  * AbortSignal for the producer lifecycle.
  */
  signal?: AbortSignal;
  /**
  * Callback for batch errors in fire-and-forget mode.
  * Since append() returns immediately, errors are reported via this callback.
  * @param error - The error that occurred
  */
  onError?: (error: Error) => void;
}
/**
* Result of an append operation from IdempotentProducer.
*/
interface IdempotentAppendResult {
  /**
  * The offset after this message was appended.
  */
  offset: Offset;
  /**
  * Whether this was a duplicate (idempotent success).
  */
  duplicate: boolean;
} //#endregion
//#region src/stream-api.d.ts
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
declare function stream<TJson = unknown>(options: StreamOptions): Promise<StreamResponse<TJson>>;

//#endregion
//#region src/stream.d.ts
/**
* Options for DurableStream constructor.
*/
interface DurableStreamOptions extends StreamHandleOptions {
  /**
  * Additional query parameters to include in requests.
  */
  params?: {
    [key: string]: string | (() => MaybePromise<string>) | undefined;
  };
  /**
  * Backoff options for retry behavior.
  */
  backoffOptions?: BackoffOptions;
  /**
  * Enable automatic batching for append() calls.
  * When true, multiple append() calls made while a POST is in-flight
  * will be batched together into a single request.
  *
  * @default true
  */
  batching?: boolean;
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
declare class DurableStream {
  #private;
  /**
  * The URL of the durable stream.
  */
  readonly url: string;
  /**
  * The content type of the stream (populated after connect/head/read).
  */
  contentType?: string;
  /**
  * Create a cold handle to a stream.
  * No network IO is performed by the constructor.
  */
  constructor(opts: DurableStreamOptions);
  /**
  * Create a new stream (create-only PUT) and return a handle.
  * Fails with DurableStreamError(code="CONFLICT_EXISTS") if it already exists.
  */
  static create(opts: CreateOptions): Promise<DurableStream>;
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
  static connect(opts: DurableStreamOptions): Promise<DurableStream>;
  /**
  * HEAD metadata for a stream without creating a handle.
  */
  static head(opts: DurableStreamOptions): Promise<HeadResult>;
  /**
  * Delete a stream without creating a handle.
  */
  static delete(opts: DurableStreamOptions): Promise<void>;
  /**
  * HEAD metadata for this stream.
  */
  head(opts?: {
    signal?: AbortSignal;
  }): Promise<HeadResult>;
  /**
  * Create this stream (create-only PUT) using the URL/auth from the handle.
  */
  create(opts?: Omit<CreateOptions, keyof StreamOptions>): Promise<this>;
  /**
  * Delete this stream.
  */
  delete(opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
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
  close(opts?: CloseOptions): Promise<CloseResult>;
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
  append(body: Uint8Array | string | Promise<Uint8Array | string>, opts?: AppendOptions): Promise<void>;
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
  appendStream(source: ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>, opts?: AppendOptions): Promise<void>;
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
  writable(opts?: Pick<IdempotentProducerOptions, `headers` | `lingerMs` | `maxBatchBytes` | `onError`> & {
    producerId?: string;
    signal?: AbortSignal;
  }): WritableStream<Uint8Array | string>;
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
  stream<TJson = unknown>(options?: Omit<StreamOptions, `url`>): Promise<StreamResponse<TJson>>;
  /**
  * Resolve the stream's configured headers.
  * Used by IdempotentProducer to merge auth headers into its requests.
  * @internal
  */
  resolveHeaders(): Promise<Record<string, string>>;
}

//#endregion
//#region src/utils.d.ts
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
declare function warnIfUsingHttpInBrowser(url: string | URL, warnOnHttp?: boolean): void;
/**
* Reset the HTTP warning state. Only exported for testing purposes.
* @internal
*/
declare function _resetHttpWarningForTesting(): void;

//#endregion
//#region src/idempotent-producer.d.ts
/**
* Error thrown when a producer's epoch is stale (zombie fencing).
*/
declare class StaleEpochError extends Error {
  /**
  * The current epoch on the server.
  */
  readonly currentEpoch: number;
  constructor(currentEpoch: number);
}
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
declare class SequenceGapError extends Error {
  readonly expectedSeq: number;
  readonly receivedSeq: number;
  constructor(expectedSeq: number, receivedSeq: number);
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
declare class IdempotentProducer {
  #private;
  /**
  * Create an idempotent producer for a stream.
  *
  * @param stream - The DurableStream to write to
  * @param producerId - Stable identifier for this producer (e.g., "order-service-1")
  * @param opts - Producer options
  */
  constructor(stream: DurableStream, producerId: string, opts?: IdempotentProducerOptions);
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
  append(body: Uint8Array | string): void;
  /**
  * Send any pending batch immediately and wait for all in-flight batches.
  *
  * Call this before shutdown to ensure all messages are delivered.
  */
  flush(): Promise<void>;
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
  detach(): Promise<void>;
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
  close(finalMessage?: Uint8Array | string): Promise<CloseResult>;
  /**
  * Increment epoch and reset sequence.
  *
  * Call this when restarting the producer to establish a new session.
  * Flushes any pending messages first.
  */
  restart(): Promise<void>;
  /**
  * Current epoch for this producer.
  */
  get epoch(): number;
  /**
  * Next sequence number to be assigned.
  */
  get nextSeq(): number;
  /**
  * Number of messages in the current pending batch.
  */
  get pendingCount(): number;
  /**
  * Number of batches currently in flight.
  */
  get inFlightCount(): number;
  /**
  * The greatest non-empty stream offset returned by a successful producer
  * append or close request.
  */
  get lastSuccessfulOffset(): Offset | undefined;
}

//#endregion
//#region src/error.d.ts
/**
* Error thrown for transport/network errors.
* Following the @electric-sql/client FetchError pattern.
*/
declare class FetchError extends Error {
  url: string;
  status: number;
  text?: string;
  json?: object;
  headers: Record<string, string>;
  constructor(status: number, text: string | undefined, json: object | undefined, headers: Record<string, string>, url: string, message?: string);
  static fromResponse(response: Response, url: string): Promise<FetchError>;
}
/**
* Error thrown when a fetch operation is aborted during backoff.
*/
declare class FetchBackoffAbortError extends Error {
  constructor();
}
/**
* Protocol-level error for Durable Streams operations.
* Provides structured error handling with error codes.
*/
declare class DurableStreamError extends Error {
  /**
  * HTTP status code, if applicable.
  */
  status?: number;
  /**
  * Structured error code for programmatic handling.
  */
  code: DurableStreamErrorCode;
  /**
  * Additional error details (e.g., raw response body).
  */
  details?: unknown;
  constructor(message: string, code: DurableStreamErrorCode, status?: number, details?: unknown);
  /**
  * Create a DurableStreamError from an HTTP response.
  */
  static fromResponse(response: Response, url: string): Promise<DurableStreamError>;
  /**
  * Create a DurableStreamError from a FetchError.
  */
  static fromFetchError(error: FetchError): DurableStreamError;
}
/**
* Error thrown when stream URL is missing.
*/
declare class MissingStreamUrlError extends Error {
  constructor();
}
/**
* Error thrown when attempting to append to a closed stream.
*/
declare class StreamClosedError extends DurableStreamError {
  readonly code: "STREAM_CLOSED";
  readonly status = 409;
  readonly streamClosed: true;
  /**
  * The final offset of the stream, if available from the response.
  */
  readonly finalOffset?: string;
  constructor(url?: string, finalOffset?: string);
}
/**
* Error thrown when signal option is invalid.
*/
declare class InvalidSignalError extends Error {
  constructor();
}

//#endregion
//#region src/constants.d.ts
/**
* Durable Streams Protocol Constants
*
* Header and query parameter names following the Electric Durable Stream Protocol.
*/
/**
* Response header containing the next offset to read from.
* Offsets are opaque tokens - clients MUST NOT interpret the format.
*/
declare const STREAM_OFFSET_HEADER = "Stream-Next-Offset";
/**
* Response header for cursor (used for CDN collapsing).
* Echo this value in subsequent long-poll requests.
*/
declare const STREAM_CURSOR_HEADER = "Stream-Cursor";
/**
* Presence header indicating response ends at current end of stream.
* When present (any value), indicates up-to-date.
*/
declare const STREAM_UP_TO_DATE_HEADER = "Stream-Up-To-Date";
/**
* Response/request header indicating stream is closed (EOF).
* When present with value "true", the stream is permanently closed.
*/
declare const STREAM_CLOSED_HEADER = "Stream-Closed";
/**
* Request header for writer coordination sequence.
* Monotonic, lexicographic. If lower than last appended seq -> 409 Conflict.
*/
declare const STREAM_SEQ_HEADER = "Stream-Seq";
/**
* Request header for stream TTL in seconds (on create).
*/
declare const STREAM_TTL_HEADER = "Stream-TTL";
/**
* Request header for absolute stream expiry time (RFC3339, on create).
*/
declare const STREAM_EXPIRES_AT_HEADER = "Stream-Expires-At";
/**
* Request header for producer ID (client-supplied stable identifier).
*/
declare const PRODUCER_ID_HEADER = "Producer-Id";
/**
* Request/response header for producer epoch.
* Client-declared, server-validated monotonically increasing.
*/
declare const PRODUCER_EPOCH_HEADER = "Producer-Epoch";
/**
* Request header for producer sequence number.
* Monotonically increasing per epoch, per-batch (not per-message).
*/
declare const PRODUCER_SEQ_HEADER = "Producer-Seq";
/**
* Response header indicating expected sequence number on 409 Conflict.
*/
declare const PRODUCER_EXPECTED_SEQ_HEADER = "Producer-Expected-Seq";
/**
* Response header indicating received sequence number on 409 Conflict.
*/
declare const PRODUCER_RECEIVED_SEQ_HEADER = "Producer-Received-Seq";
/**
* Query parameter for starting offset.
*/
declare const OFFSET_QUERY_PARAM = "offset";
/**
* Query parameter for live mode.
* Values: "long-poll", "sse"
*/
declare const LIVE_QUERY_PARAM = "live";
/**
* Query parameter for echoing cursor (CDN collapsing).
*/
declare const CURSOR_QUERY_PARAM = "cursor";
/**
* Response header indicating SSE data encoding (e.g., base64 for binary streams).
*/

/**
* SSE control event field for the next offset.
* Note: Different from HTTP header name (camelCase vs Header-Case).
*/
declare const SSE_OFFSET_FIELD = "streamNextOffset";
/**
* SSE control event field for cursor.
* Note: Different from HTTP header name (camelCase vs Header-Case).
*/
declare const SSE_CURSOR_FIELD = "streamCursor";
/**
* SSE control event field for stream closed state.
* Note: Different from HTTP header name (camelCase vs Header-Case).
*/
declare const SSE_CLOSED_FIELD = "streamClosed";
/**
* Content types that are natively compatible with SSE (UTF-8 text).
* Binary content types are also supported via automatic base64 encoding.
*/
declare const SSE_COMPATIBLE_CONTENT_TYPES: ReadonlyArray<string>;
/**
* Protocol query parameters that should not be set by users.
*/
declare const DURABLE_STREAM_PROTOCOL_QUERY_PARAMS: Array<string>;

//#endregion
export { AppendOptions, BackoffDefaults, BackoffOptions, ByteChunk, CURSOR_QUERY_PARAM, CloseOptions, CloseResult, CreateOptions, DURABLE_STREAM_PROTOCOL_QUERY_PARAMS, DurableStream, DurableStreamError, DurableStreamErrorCode, DurableStreamOptions, FetchBackoffAbortError, FetchError, HeadResult, HeadersRecord, IdempotentAppendResult, IdempotentProducer, IdempotentProducerOptions, InvalidSignalError, JsonBatch, JsonBatchMeta, LIVE_QUERY_PARAM, LegacyLiveMode, LiveMode, MaybePromise, MissingStreamUrlError, OFFSET_QUERY_PARAM, Offset, PRODUCER_EPOCH_HEADER, PRODUCER_EXPECTED_SEQ_HEADER, PRODUCER_ID_HEADER, PRODUCER_RECEIVED_SEQ_HEADER, PRODUCER_SEQ_HEADER, ParamsRecord, ReadOptions, ReadableStreamAsyncIterable, RetryOpts, SSEResilienceOptions, SSE_CLOSED_FIELD, SSE_COMPATIBLE_CONTENT_TYPES, SSE_CURSOR_FIELD, SSE_OFFSET_FIELD, STREAM_CLOSED_HEADER, STREAM_CURSOR_HEADER, STREAM_EXPIRES_AT_HEADER, STREAM_OFFSET_HEADER, STREAM_SEQ_HEADER, STREAM_TTL_HEADER, STREAM_UP_TO_DATE_HEADER, SequenceGapError, StaleEpochError, StreamClosedError, StreamErrorHandler, StreamHandleOptions, StreamOptions, StreamResponse, TextChunk, _resetHttpWarningForTesting, asAsyncIterableReadableStream, createFetchWithBackoff, createFetchWithConsumedBody, stream, warnIfUsingHttpInBrowser };