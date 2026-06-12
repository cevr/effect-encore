import { Context, Span } from "@opentelemetry/api";
import { IncomingMessage, ServerResponse } from "node:http";

//#region src/types.d.ts
/**
* Types for the in-memory durable streams test server.
*/
/**
* A single message in a stream.
*/
/**
* Types for the in-memory durable streams test server.
*/
/**
* A single message in a stream.
*/
interface StreamMessage {
  /**
  * The raw bytes of the message.
  */
  data: Uint8Array;
  /**
  * The offset after this message.
  * Format: "<read-seq>_<byte-offset>"
  */
  offset: string;
  /**
  * Timestamp when the message was appended.
  */
  timestamp: number;
}
/**
* Stream metadata and data.
*/
interface Stream {
  /**
  * The stream URL path (key).
  */
  path: string;
  /**
  * Content type of the stream.
  */
  contentType?: string;
  /**
  * Messages in the stream.
  */
  messages: Array<StreamMessage>;
  /**
  * Current offset (next offset to write to).
  */
  currentOffset: string;
  /**
  * Last sequence number for writer coordination.
  */
  lastSeq?: string;
  /**
  * TTL in seconds.
  */
  ttlSeconds?: number;
  /**
  * Absolute expiry time (ISO 8601).
  */
  expiresAt?: string;
  /**
  * Timestamp when the stream was created.
  */
  createdAt: number;
  /**
  * Timestamp of the last read or write (for TTL renewal).
  * Initialized to createdAt. Updated on GET reads and POST appends.
  * HEAD requests do NOT update this field.
  */
  lastAccessedAt: number;
  /**
  * Producer states for idempotent writes.
  * Maps producer ID to their epoch and sequence state.
  */
  producers?: Map<string, ProducerState>;
  /**
  * Whether the stream is closed (no further appends permitted).
  * Once set to true, this is permanent and durable.
  */
  closed?: boolean;
  /**
  * The producer tuple that closed this stream (for idempotent close).
  * If set, duplicate close requests with this tuple return 204.
  */
  closedBy?: {
    producerId: string;
    epoch: number;
    seq: number;
  };
  /**
  * Source stream path (set when this stream is a fork).
  */
  forkedFrom?: string;
  /**
  * Divergence offset from the source stream.
  * Format: "0000000000000000_0000000000000000"
  */
  forkOffset?: string;
  /**
  * User-supplied sub-offset value refining `forkOffset` (Section 4.2 of
  * PROTOCOL.md). Stored verbatim for idempotent re-creation matching:
  * bytes for non-JSON forks, flattened message count for JSON forks.
  * `undefined` and `0` are equivalent.
  */
  forkSubOffset?: number;
  /**
  * Number of forks referencing this stream.
  * Defaults to 0.
  */
  refCount: number;
  /**
  * Whether this stream is logically deleted but retained for fork readers.
  */
  softDeleted?: boolean;
}
/**
* Event data for stream lifecycle hooks.
*/
interface StreamLifecycleEvent {
  /**
  * Type of event.
  */
  type: `created` | `deleted`;
  /**
  * Stream path.
  */
  path: string;
  /**
  * Content type (only for 'created' events).
  */
  contentType?: string;
  /**
  * Timestamp of the event.
  */
  timestamp: number;
}
/**
* Hook function called when a stream is created or deleted.
*/
type StreamLifecycleHook = (event: StreamLifecycleEvent) => void | Promise<void>;
/**
* Options for creating the test server.
*/
interface TestServerOptions {
  /**
  * Port to listen on. Default: 0 (auto-assign).
  */
  port?: number;
  /**
  * Host to bind to. Default: "127.0.0.1".
  */
  host?: string;
  /**
  * Default long-poll timeout in milliseconds.
  * Default: 30000 (30 seconds).
  */
  longPollTimeout?: number;
  /**
  * Data directory for file-backed storage.
  * If provided, enables file-backed mode using LMDB and append-only logs.
  * If omitted, uses in-memory storage.
  */
  dataDir?: string;
  /**
  * Hook called when a stream is created.
  */
  onStreamCreated?: StreamLifecycleHook;
  /**
  * Hook called when a stream is deleted.
  */
  onStreamDeleted?: StreamLifecycleHook;
  /**
  * Enable gzip/deflate compression for responses.
  * Default: true.
  */
  compression?: boolean;
  /**
  * Interval in seconds for cursor calculation.
  * Used for CDN cache collapsing to prevent infinite cache loops.
  * Default: 20 seconds.
  */
  cursorIntervalSeconds?: number;
  /**
  * Epoch timestamp for cursor interval calculation.
  * Default: October 9, 2024 00:00:00 UTC.
  */
  cursorEpoch?: Date;
  /**
  * Enable webhook subscriptions.
  * Pull-wake subscription routes are always mounted, but type=webhook creates
  * are rejected unless this is true.
  * Default: false.
  */
  webhooks?: boolean;
}
/**
* Producer state for idempotent writes.
* Tracks epoch and sequence number per producer ID for deduplication.
*/
interface ProducerState {
  /**
  * Current epoch for this producer.
  * Client-declared, server-validated monotonically increasing.
  */
  epoch: number;
  /**
  * Last sequence number received in this epoch.
  */
  lastSeq: number;
  /**
  * Timestamp when this producer state was last updated.
  * Used for TTL-based cleanup.
  */
  lastUpdated: number;
}
/**
* Result of producer validation for append operations.
* For 'accepted' status, includes proposedState to commit after successful append.
*/
type ProducerValidationResult = {
  status: `accepted`;
  isNew: boolean;
  /** State to commit after successful append (deferred mutation) */
  proposedState: ProducerState;
  producerId: string;
} | {
  status: `duplicate`;
  lastSeq: number;
} | {
  status: `stale_epoch`;
  currentEpoch: number;
} | {
  status: `invalid_epoch_seq`;
} | {
  status: `sequence_gap`;
  expectedSeq: number;
  receivedSeq: number;
} | {
  status: `stream_closed`;
};
/**
* Pending long-poll request.
*/
interface PendingLongPoll {
  /**
  * Stream path.
  */
  path: string;
  /**
  * Offset to wait for.
  */
  offset: string;
  /**
  * Resolve function.
  */
  resolve: (messages: Array<StreamMessage>) => void;
  /**
  * Timeout ID.
  */
  timeoutId: ReturnType<typeof setTimeout>;
} //#endregion
//#region src/store.d.ts
/**
* In-memory store for durable streams.
*/
/**
* Options for append operations.
*/
interface AppendOptions {
  seq?: string;
  contentType?: string;
  producerId?: string;
  producerEpoch?: number;
  producerSeq?: number;
  close?: boolean;
}
/**
* Result of an append operation.
*/
interface AppendResult {
  message: StreamMessage | null;
  producerResult?: ProducerValidationResult;
  streamClosed?: boolean;
}
declare class StreamStore {
  private streams;
  private pendingLongPolls;
  /**
  * Per-producer locks for serializing validation+append operations.
  * Key: "{streamPath}:{producerId}"
  */
  private producerLocks;
  /**
  * Check if a stream is expired based on TTL or Expires-At.
  */
  private isExpired;
  /**
  * Get a stream, handling expiry.
  * Returns undefined if stream doesn't exist or is expired (and has no refs).
  * Expired streams with refCount > 0 are soft-deleted instead of fully deleted.
  */
  private getIfNotExpired;
  /**
  * Update lastAccessedAt to now. Called on reads and appends (not HEAD).
  */
  touchAccess(path: string): void;
  /**
  * Create a new stream.
  * @throws Error if stream already exists with different config
  * @throws Error if fork source not found, soft-deleted, or offset invalid
  * @returns existing stream if config matches (idempotent)
  */
  create(path: string, options?: {
    contentType?: string;
    ttlSeconds?: number;
    expiresAt?: string;
    initialData?: Uint8Array;
    closed?: boolean;
    forkedFrom?: string;
    forkOffset?: string;
    forkSubOffset?: number;
  }): Stream;
  /**
  * Resolve fork expiry per the decision table.
  * Forks have independent lifetimes — no capping at source expiry.
  */
  private resolveForkExpiry;
  /**
  * Get a stream by path.
  * Returns undefined if stream doesn't exist or is expired.
  * Returns soft-deleted streams (caller should check stream.softDeleted).
  */
  get(path: string): Stream | undefined;
  /**
  * Check if a stream exists, is not expired, and is not soft-deleted.
  */
  has(path: string): boolean;
  /**
  * Delete a stream.
  * If the stream has forks (refCount > 0), it is soft-deleted instead of fully removed.
  * Returns true if the stream was found and deleted (or soft-deleted).
  */
  delete(path: string): boolean;
  /**
  * Fully delete a stream and cascade to soft-deleted parents
  * whose refcount drops to zero.
  */
  private deleteWithCascade;
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
  private validateProducer;
  /**
  * Commit producer state after successful append.
  * This is the only place where producer state is mutated.
  */
  private commitProducerState;
  /**
  * Clean up expired producer states from a stream.
  */
  private cleanupExpiredProducers;
  /**
  * Acquire a lock for serialized producer operations.
  * Returns a release function.
  */
  private acquireProducerLock;
  /**
  * Append data to a stream.
  * @throws Error if stream doesn't exist or is expired
  * @throws Error if seq is lower than lastSeq
  * @throws Error if JSON mode and array is empty
  */
  append(path: string, data: Uint8Array, options?: AppendOptions): StreamMessage | AppendResult;
  /**
  * Append with producer serialization for concurrent request handling.
  * This ensures that validation+append is atomic per producer.
  */
  appendWithProducer(path: string, data: Uint8Array, options: AppendOptions): Promise<AppendResult>;
  /**
  * Close a stream without appending data.
  * @returns The final offset, or null if stream doesn't exist
  */
  closeStream(path: string): Promise<{
    finalOffset: string;
    alreadyClosed: boolean;
  } | null>;
  /**
  * Close a stream with producer headers for idempotent close-only operations.
  * Participates in producer sequencing for deduplication.
  * @returns The final offset and producer result, or null if stream doesn't exist
  */
  closeStreamWithProducer(path: string, options: {
    producerId: string;
    producerEpoch: number;
    producerSeq: number;
  }): Promise<{
    finalOffset: string;
    alreadyClosed: boolean;
    producerResult?: ProducerValidationResult;
  } | null>;
  /**
  * Get the current epoch for a producer on a stream.
  * Returns undefined if the producer doesn't exist or stream not found.
  */
  getProducerEpoch(path: string, producerId: string): number | undefined;
  /**
  * Read messages from a stream starting at the given offset.
  * For forked streams, stitches messages from the source chain and the fork's own messages.
  * @throws Error if stream doesn't exist or is expired
  */
  read(path: string, offset?: string): {
    messages: Array<StreamMessage>;
    upToDate: boolean;
  };
  /**
  * Read from a forked stream, stitching inherited and own messages.
  */
  private readFromFork;
  /**
  * Read a stream's own messages starting after the given offset.
  */
  private readOwnMessages;
  /**
  * Recursively read messages from a fork's source chain.
  * Reads from source (and its sources if also forked), capped at forkOffset.
  * Does NOT check softDeleted — forks must read through soft-deleted sources.
  */
  private readForkedMessages;
  /**
  * Format messages for response.
  * For JSON mode, wraps concatenated data in array brackets.
  * @throws Error if stream doesn't exist or is expired
  */
  formatResponse(path: string, messages: Array<StreamMessage>): Uint8Array;
  /**
  * Wait for new messages (long-poll).
  * @throws Error if stream doesn't exist or is expired
  */
  waitForMessages(path: string, offset: string, timeoutMs: number): Promise<{
    messages: Array<StreamMessage>;
    timedOut: boolean;
    streamClosed?: boolean;
  }>;
  /**
  * Get the current offset for a stream.
  * Returns undefined if stream doesn't exist or is expired.
  */
  getCurrentOffset(path: string): string | undefined;
  /**
  * Clear all streams.
  */
  clear(): void;
  /**
  * Cancel all pending long-polls (used during shutdown).
  */
  cancelAllWaits(): void;
  /**
  * Get all stream paths.
  */
  list(): Array<string>;
  /**
  * Resolve a sub-offset against a source stream and return the prefix bytes
  * to materialize as the fork's first own message. Reads from the source
  * (across its fork chain if any) starting at forkOffset; the first message
  * returned is the one that starts at forkOffset. Throws if the sub-offset
  * cannot be satisfied (no message past forkOffset, or overshoots its
  * content extent).
  */
  private resolveForkSubOffset;
  private appendToStream;
  private findOffsetIndex;
  private notifyLongPolls;
  /**
  * Notify pending long-polls that a stream has been closed.
  * They should wake up immediately and return Stream-Closed: true.
  */
  private notifyLongPollsClosed;
  private cancelLongPollsForStream;
  private removePendingLongPoll;
} //#endregion
//#region src/file-store.d.ts
interface FileBackedStreamStoreOptions {
  dataDir: string;
  maxFileHandles?: number;
}
/**
* File-backed implementation of StreamStore.
* Maintains the same interface as the in-memory StreamStore for drop-in compatibility.
*/
declare class FileBackedStreamStore {
  private db;
  private fileHandlePool;
  private pendingLongPolls;
  private dataDir;
  /**
  * Per-producer locks for serializing validation+append operations.
  * Key: "{streamPath}:{producerId}"
  */
  private producerLocks;
  /**
  * Per-stream append locks. Serializes the read-modify-write of currentOffset
  * across all concurrent appenders on the same stream so the LMDB-tracked
  * offset cannot drift behind the file's actual byte position.
  * Key: streamPath
  */
  private streamAppendLocks;
  constructor(options: FileBackedStreamStoreOptions);
  /**
  * Recover streams from disk on startup.
  * Validates that LMDB metadata matches actual file contents and reconciles any mismatches.
  */
  private recover;
  /**
  * Scan a segment file to compute the true last offset.
  * Handles partial/truncated messages at the end.
  */
  private scanFileForTrueOffset;
  /**
  * Convert LMDB metadata to Stream object.
  */
  private streamMetaToStream;
  /**
  * Validate producer state WITHOUT mutating.
  * Returns proposed state to commit after successful append.
  *
  * IMPORTANT: This function does NOT mutate producer state. The caller must
  * commit the proposedState after successful append (file write + fsync + LMDB).
  * This ensures atomicity: if any step fails, producer state is not advanced.
  */
  private validateProducer;
  /**
  * Acquire a lock for serialized producer operations.
  * Returns a release function.
  */
  private acquireProducerLock;
  /**
  * Acquire a per-stream append lock that serializes the read-modify-write
  * of currentOffset across all concurrent appenders on the same stream.
  * Without this, two concurrent appends can read the same starting
  * currentOffset, both compute their newOffset, both write a frame to the
  * file, but only one of their LMDB updates wins — leaving currentOffset
  * lagging the file's actual byte position. Returns a release function.
  */
  private acquireStreamAppendLock;
  /**
  * Get the current epoch for a producer on a stream.
  * Returns undefined if the producer doesn't exist or stream not found.
  */
  getProducerEpoch(streamPath: string, producerId: string): number | undefined;
  /**
  * Update lastAccessedAt to now. Called on reads and appends (not HEAD).
  */
  touchAccess(streamPath: string): void;
  /**
  * Check if a stream is expired based on TTL or Expires-At.
  */
  private isExpired;
  /**
  * Get stream metadata, deleting it if expired.
  * Returns undefined if stream doesn't exist or is expired (and has no refs).
  * Expired streams with refCount > 0 are soft-deleted instead of fully deleted.
  */
  private getMetaIfNotExpired;
  /**
  * Resolve fork expiry per the decision table.
  * Forks have independent lifetimes — no capping at source expiry.
  */
  private resolveForkExpiry;
  /**
  * Close the store, closing all file handles and database.
  * All data is already fsynced on each append, so no final flush needed.
  */
  close(): Promise<void>;
  create(streamPath: string, options?: {
    contentType?: string;
    ttlSeconds?: number;
    expiresAt?: string;
    initialData?: Uint8Array;
    closed?: boolean;
    forkedFrom?: string;
    forkOffset?: string;
    forkSubOffset?: number;
  }): Promise<Stream>;
  get(streamPath: string): Stream | undefined;
  has(streamPath: string): boolean;
  delete(streamPath: string): boolean;
  /**
  * Fully delete a stream and cascade to soft-deleted parents
  * whose refcount drops to zero.
  */
  private deleteWithCascade;
  /**
  * Public append entry point. Serializes concurrent appends to the same
  * stream so the read-modify-write of currentOffset cannot interleave —
  * see acquireStreamAppendLock for the underlying race.
  */
  append(streamPath: string, data: Uint8Array, options?: AppendOptions & {
    isInitialCreate?: boolean;
  }): Promise<StreamMessage | AppendResult | null>;
  private appendInner;
  /**
  * Append with producer serialization for concurrent request handling.
  * This ensures that validation+append is atomic per producer.
  */
  appendWithProducer(streamPath: string, data: Uint8Array, options: AppendOptions): Promise<AppendResult>;
  /**
  * Close a stream without appending data.
  * @returns The final offset, or null if stream doesn't exist
  */
  closeStream(streamPath: string): {
    finalOffset: string;
    alreadyClosed: boolean;
  } | null;
  /**
  * Close a stream with producer headers for idempotent close-only operations.
  * Participates in producer sequencing for deduplication.
  * @returns The final offset and producer result, or null if stream doesn't exist
  */
  closeStreamWithProducer(streamPath: string, options: {
    producerId: string;
    producerEpoch: number;
    producerSeq: number;
  }): Promise<{
    finalOffset: string;
    alreadyClosed: boolean;
    producerResult?: ProducerValidationResult;
  } | null>;
  /**
  * Read messages from a specific segment file.
  * @param segmentPath - Path to the segment file
  * @param startByte - Start byte offset (skip messages at or before this offset)
  * @param baseByteOffset - Base byte offset to add to physical offsets (for fork stitching)
  * @param capByte - Optional cap: stop reading when logical offset exceeds this value
  * @returns Array of messages with properly computed offsets
  */
  private readMessagesFromSegmentFile;
  /**
  * Recursively read messages from a fork's source chain.
  * Reads from source (and its sources if also forked), capped at capByte.
  * Does NOT check softDeleted -- forks must read through soft-deleted sources.
  */
  private readForkedMessages;
  /**
  * Resolve a fork sub-offset against the source: read the message that
  * starts at forkOffset and return prefix bytes to materialize as the
  * fork's first own message. For JSON, parses comma-joined values.
  */
  private resolveForkSubOffset;
  read(streamPath: string, offset?: string): {
    messages: Array<StreamMessage>;
    upToDate: boolean;
  };
  waitForMessages(streamPath: string, offset: string, timeoutMs: number): Promise<{
    messages: Array<StreamMessage>;
    timedOut: boolean;
    streamClosed?: boolean;
  }>;
  /**
  * Format messages for response.
  * For JSON mode, wraps concatenated data in array brackets.
  * @throws Error if stream doesn't exist or is expired
  */
  formatResponse(streamPath: string, messages: Array<StreamMessage>): Uint8Array;
  getCurrentOffset(streamPath: string): string | undefined;
  clear(): void;
  /**
  * Cancel all pending long-polls (used during shutdown).
  */
  cancelAllWaits(): void;
  list(): Array<string>;
  private notifyLongPolls;
  /**
  * Notify pending long-polls that a stream has been closed.
  * They should wake up immediately and return Stream-Closed: true.
  */
  private notifyLongPollsClosed;
  private cancelLongPollsForStream;
  private removePendingLongPoll;
} //#endregion
//#region src/webhook-types.d.ts
interface Subscription {
  subscription_id: string;
  pattern: string;
  webhook: string;
  webhook_secret: string;
  description?: string;
  internal?: boolean;
}
/**
* L2 webhook consumer — references an L1 consumer by consumer_id.
* Owns only webhook delivery state; epoch, stream offsets, and liveness
* are managed by L1 ConsumerManager.
*/
interface WebhookConsumer {
  consumer_id: string;
  subscription_id: string;
  primary_stream: string;
  wake_id: string | null;
  wake_id_claimed: boolean;
  last_webhook_failure_at: number | null;
  first_webhook_failure_at: number | null;
  retry_count: number;
  retry_timer: ReturnType<typeof setTimeout> | null;
  wake_cycle_span: Span | null;
  wake_cycle_ctx: Context | null;
}
interface CallbackRequest {
  epoch: number;
  wakeId?: string;
  acks?: Array<{
    path: string;
    offset: string;
  }>;
  subscribe?: Array<string>;
  unsubscribe?: Array<string>;
  done?: boolean;
}
interface CallbackSuccess {
  ok: true;
  claimToken: string;
  token?: string;
  streams: Array<{
    path: string;
    offset: string;
  }>;
  writeToken?: string;
}
interface CallbackError {
  ok: false;
  error: {
    code: CallbackErrorCode;
    message: string;
  };
  claimToken?: string;
  token?: string;
}
type CallbackErrorCode = `INVALID_REQUEST` | `TOKEN_EXPIRED` | `TOKEN_INVALID` | `ALREADY_CLAIMED` | `INVALID_OFFSET` | `STALE_EPOCH` | `CONSUMER_GONE`;
type CallbackResponse = CallbackSuccess | CallbackError;

//#endregion
//#region src/webhook-store.d.ts
/**
* In-memory store for webhook subscriptions and L2 webhook consumer instances.
*/
declare class WebhookStore {
  private subscriptions;
  private webhookConsumers;
  private subscriptionConsumers;
  private streamConsumers;
  createSubscription(subscriptionId: string, pattern: string, webhook: string, description?: string): {
    subscription: Subscription;
    created: boolean;
  };
  getSubscription(subscriptionId: string): Subscription | undefined;
  listSubscriptions(pattern?: string): Array<Subscription>;
  getConsumersForSubscription(subscriptionId: string): Array<string>;
  deleteSubscription(subscriptionId: string): boolean;
  /**
  * Find all subscriptions whose pattern matches a given stream path.
  */
  findMatchingSubscriptions(streamPath: string): Array<Subscription>;
  getWebhookConsumer(consumerId: string): WebhookConsumer | undefined;
  /**
  * Build the consumer ID from subscription_id and stream path.
  */
  static readonly CONSUMER_ID_PREFIX = "__wh__:";
  static buildConsumerId(subscriptionId: string, streamPath: string): string;
  /**
  * Create an L2 webhook consumer record. Does not create L1 consumer state.
  */
  createWebhookConsumer(consumerId: string, subscriptionId: string, streamPath: string): WebhookConsumer;
  /**
  * Claim a wake_id. Returns true if claim succeeds or was already claimed
  * for this wake (idempotent). Returns false if the wake_id doesn't match.
  */
  claimWakeId(wc: WebhookConsumer, wakeId: string): boolean;
  /**
  * Remove a webhook consumer and clean up L2 indexes.
  * Does NOT remove L1 consumer — caller must handle that separately.
  */
  removeWebhookConsumer(consumerId: string): void;
  /**
  * Get all consumer IDs subscribed to a given stream path.
  */
  getConsumersForStream(streamPath: string): Array<string>;
  /**
  * Get all webhook consumer instances (for shutdown span cleanup).
  */
  getAllWebhookConsumers(): IterableIterator<WebhookConsumer>;
  /**
  * Remove a stream from the L2 stream index.
  */
  removeStreamFromIndex(streamPath: string): void;
  /**
  * Shut down: clear all timers.
  */
  shutdown(): void;
  addStreamIndex(streamPath: string, consumerId: string): void;
  removeStreamIndex(streamPath: string, consumerId: string): void;
}

//#endregion
//#region src/consumer-types.d.ts
/**
* Types for Layer 1: Named Consumers.
* L1 is mechanism-independent — no references to webhooks, push, or any L2 concept.
*/
type ConsumerState = `REGISTERED` | `READING`;
type WakePreference = {
  type: `none`;
} | {
  type: `webhook`;
  url: string;
} | {
  type: `pull-wake`;
  wake_stream: string;
};
interface Consumer {
  consumer_id: string;
  state: ConsumerState;
  epoch: number;
  token: string | null;
  streams: Map<string, string>;
  namespace: string | null;
  lease_ttl_ms: number;
  last_ack_at: number;
  lease_timer: ReturnType<typeof setTimeout> | null;
  created_at: number;
  wake_preference: WakePreference;
  holder_id: string | null;
}
interface AckRequest {
  offsets: Array<{
    path: string;
    offset: string;
  }>;
}
interface AcquireResponse {
  consumer_id: string;
  epoch: number;
  token: string;
  streams: Array<{
    path: string;
    offset: string;
  }>;
  worker?: string;
}
interface ReleaseResponse {
  ok: true;
  state: `REGISTERED`;
}
interface ConsumerInfo {
  consumer_id: string;
  state: ConsumerState;
  epoch: number;
  streams: Array<{
    path: string;
    offset: string;
  }>;
  namespace: string | null;
  lease_ttl_ms: number;
  wake_preference: WakePreference;
}
type ConsumerErrorCode = `CONSUMER_NOT_FOUND` | `CONSUMER_ALREADY_EXISTS` | `EPOCH_HELD` | `STALE_EPOCH` | `TOKEN_EXPIRED` | `TOKEN_INVALID` | `OFFSET_REGRESSION` | `INVALID_OFFSET` | `UNKNOWN_STREAM` | `INTERNAL_ERROR`;
interface ConsumerError {
  code: ConsumerErrorCode;
  message: string;
  current_epoch?: number;
  path?: string;
  retry_after?: number;
  holder?: string;
}

//#endregion
//#region src/consumer-store.d.ts
declare class ConsumerStore {
  private consumers;
  private streamConsumers;
  /**
  * Register a new consumer. Idempotent if config matches.
  */
  registerConsumer(consumerId: string, streams: Array<string>, getTailOffset: (path: string) => string, opts?: {
    namespace?: string;
    lease_ttl_ms?: number;
  }): {
    consumer: Consumer;
    created: boolean;
  } | {
    error: `CONFIG_MISMATCH`;
  };
  getConsumer(consumerId: string): Consumer | undefined;
  removeConsumer(consumerId: string): boolean;
  /**
  * Acquire epoch for a consumer. Increments epoch and transitions to READING.
  * If already READING, this is a self-supersede (crash recovery) — epoch
  * increments and old token is invalidated.
  * Returns null if consumer doesn't exist.
  * NOTE: Single-process reference server has no contention check (EPOCH_HELD). Self-supersede always
  * succeeds. Multi-server contention is a future concern.
  */
  acquireEpoch(consumerId: string): {
    epoch: number;
    prevState: ConsumerState;
  } | null;
  /**
  * Release epoch. Transitions consumer from READING to REGISTERED.
  */
  releaseEpoch(consumerId: string): boolean;
  /**
  * Update acked offsets. Returns error info if offset regresses or is invalid.
  */
  updateOffsets(consumer: Consumer, offsets: Array<{
    path: string;
    offset: string;
  }>, getTailOffset: (path: string) => string): {
    path: string;
    code: `OFFSET_REGRESSION` | `INVALID_OFFSET` | `UNKNOWN_STREAM`;
  } | null;
  /**
  * Add streams to a consumer's subscription.
  */
  addStreams(consumer: Consumer, paths: Array<string>, getTailOffset: (path: string) => string): void;
  /**
  * Remove streams from a consumer. Returns true if consumer has no streams left.
  */
  removeStreams(consumer: Consumer, paths: Array<string>): boolean;
  /**
  * Get consumer IDs subscribed to a stream.
  */
  getConsumersForStream(streamPath: string): Array<string>;
  /**
  * Find consumers matching a stream path via namespace globs.
  */
  findConsumersMatchingStream(streamPath: string): Array<Consumer>;
  /**
  * Get streams data for API responses.
  */
  getStreamsData(consumer: Consumer): Array<{
    path: string;
    offset: string;
  }>;
  /**
  * Check if consumer has pending work.
  */
  hasPendingWork(consumer: Consumer, getTailOffset: (path: string) => string): boolean;
  /**
  * Remove a stream from all consumers. Returns IDs of consumers with no streams left.
  */
  removeStreamFromAllConsumers(streamPath: string): Array<string>;
  /**
  * Get all consumers (for shutdown).
  */
  getAllConsumers(): IterableIterator<Consumer>;
  /**
  * Shut down: clear all timers and state.
  */
  shutdown(): void;
  private addStreamIndex;
  private removeStreamIndex;
}

//#endregion
//#region src/consumer-manager.d.ts
declare class ConsumerManager {
  readonly store: ConsumerStore;
  private getTailOffset;
  private isShuttingDown;
  /**
  * Callbacks invoked when a consumer's lease expires.
  * L2 layers register here to react (e.g., webhook re-wake).
  */
  private leaseExpiredCallbacks;
  onLeaseExpired(cb: (consumer: Consumer) => void): void;
  /**
  * Callbacks invoked when a consumer is deleted.
  * L2 layers register here to clean up associated state
  * (e.g., remove WebhookConsumer records, cancel retry timers).
  */
  private consumerDeletedCallbacks;
  onConsumerDeleted(cb: (consumerId: string) => void): void;
  /**
  * Callbacks invoked when a consumer's epoch is acquired.
  * L2 layers register here to track claims (e.g., pull-wake writes "claimed" events).
  *
  * Critical callbacks run first — if any throw, the acquire is rolled back
  * and returned as an error. Non-critical callbacks are swallowed with a log.
  */
  private epochAcquiredCallbacks;
  private criticalEpochAcquiredCallbacks;
  onEpochAcquired(cb: (consumerId: string, epoch: number, worker?: string) => void): void;
  onEpochAcquiredCritical(cb: (consumerId: string, epoch: number, worker?: string) => void): void;
  /**
  * Callbacks invoked when a consumer's epoch is released.
  * L2 layers register here to react (e.g., pull-wake re-wake if pending work).
  */
  private epochReleasedCallbacks;
  onEpochReleased(cb: (consumerId: string) => void): void;
  constructor(opts: {
    getTailOffset: (path: string) => string;
  });
  registerConsumer(consumerId: string, streams: Array<string>, opts?: {
    namespace?: string;
    lease_ttl_ms?: number;
  }): {
    consumer: Consumer;
    created: boolean;
  } | {
    error: `CONFIG_MISMATCH`;
  };
  deleteConsumer(consumerId: string): boolean;
  getConsumer(consumerId: string): ConsumerInfo | null;
  /**
  * Set the wake preference for a consumer.
  * Used by L2 layers to configure how the consumer is notified of new work.
  */
  setWakePreference(consumerId: string, preference: WakePreference): Consumer | null;
  /**
  * Acquire epoch for a consumer. Returns token + stream offsets.
  * If already READING, this is a self-supersede (crash recovery).
  * Optional `worker` parameter enables contention tracking for pull-wake.
  */
  acquire(consumerId: string, worker?: string): AcquireResponse | {
    error: ConsumerError;
  };
  /**
  * Process an ack request. Validates token, epoch, and offsets.
  * Empty offsets = heartbeat: resets lease timer, no durable cursor write.
  * Both empty and cursor-advancing acks reset last_ack_time (RFC § Liveness).
  */
  ack(consumerId: string, token: string, request: AckRequest): {
    ok: true;
    token: string;
  } | {
    error: ConsumerError;
  };
  release(consumerId: string, token: string): ReleaseResponse | {
    error: ConsumerError;
  };
  private resetLeaseTimer;
  /**
  * Expire a consumer's epoch. Public API for L2 to force-expire
  * (e.g., webhook delivery failures beyond threshold).
  */
  expireConsumer(consumerId: string): boolean;
  /**
  * Called when a stream is deleted. Removes stream from all consumers.
  */
  onStreamDeleted(streamPath: string): void;
  hasPendingWork(consumerId: string): boolean;
  shutdown(): void;
}

//#endregion
//#region src/webhook-manager.d.ts
/**
* Orchestrates webhook delivery, consumer lifecycle, and callbacks.
* L2 layer: delegates epoch/stream/offset management to L1 ConsumerManager.
*/
declare class WebhookManager {
  readonly store: WebhookStore;
  readonly consumerManager: ConsumerManager;
  private callbackBaseUrl;
  private getTailOffset;
  private isShuttingDown;
  private directWebhookConfigs;
  /**
  * Optional callback to enrich webhook payloads with additional context.
  * Used by DARIX to inject entity metadata into webhook notifications.
  */
  enrichPayload?: (payload: Record<string, unknown>, consumer: WebhookConsumer) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
  * Optional callback to retrieve the entity write_token for a given primary stream.
  * Used to include write_token in claim responses so entities can authenticate writes.
  */
  getEntityWriteToken: ((primaryStream: string) => Promise<string | undefined>) | null;
  constructor(opts: {
    callbackBaseUrl: string;
    getTailOffset: (path: string) => string;
    consumerManager: ConsumerManager;
  });
  /**
  * Called when events are appended to a stream.
  * Lazily creates consumers for matching subscriptions on first append,
  * then checks if any consumers need to be woken.
  */
  onStreamAppend(streamPath: string): void;
  /**
  * Called when a new stream is created.
  * No-op: consumers are created lazily on first append via onStreamAppend().
  */
  onStreamCreated(_streamPath: string): void;
  /**
  * Called when a new stream is created and should be bound to a specific
  * subscription only. Used by DARIX spawn to ensure the entity's streams
  * are only associated with the subscription that was selected during spawn,
  * preventing stale subscriptions from creating spurious consumers.
  */
  onStreamCreatedForSubscription(streamPath: string, subscriptionId: string): void;
  /**
  * Called when a stream is deleted.
  * Removes the stream from L2 indexes and adjusts primary_stream references.
  */
  onStreamDeleted(streamPath: string): void;
  private wakeConsumer;
  private deliverWebhook;
  private scheduleRetry;
  /**
  * Exponential backoff with jitter, capping at MAX_RETRY_DELAY_MS,
  * then settling to STEADY_RETRY_DELAY_MS.
  */
  private calculateRetryDelay;
  /**
  * Process a callback request. Returns the response to send.
  */
  handleCallback(consumerId: string, token: string, request: CallbackRequest): Promise<CallbackResponse>;
  /**
  * Transition L2 webhook consumer to idle: clear wake state and end span.
  */
  private transitionToIdle;
  /**
  * Delete a subscription and cascade to both L2 and L1 state.
  * Must be used instead of store.deleteSubscription() directly.
  */
  deleteSubscription(subscriptionId: string): boolean;
  /**
  * Get or create both L1 consumer and L2 webhook consumer.
  */
  private getOrCreateWebhookConsumer;
  setDirectWebhookPreference(consumerId: string, webhookUrl: string): boolean;
  clearDirectWebhookPreference(consumerId: string): void;
  private buildCallbackUrl;
  private getDirectSubscriptionId;
  private getDeliveryTarget;
  /**
  * Shut down the manager: cancel all timers.
  */
  shutdown(): void;
}

//#endregion
//#region src/server.d.ts
/**
* HTTP server for testing durable streams.
* Supports both in-memory and file-backed storage modes.
*/
/**
* Configuration for injected faults (for testing retry/resilience).
* Supports various fault types beyond simple HTTP errors.
*/
interface InjectedFault {
  /** HTTP status code to return (if set, returns error response) */
  status?: number;
  /** Number of times to trigger this fault (decremented on each use) */
  count: number;
  /** Optional Retry-After header value (seconds) */
  retryAfter?: number;
  /** Delay in milliseconds before responding */
  delayMs?: number;
  /** Drop the connection after sending headers (simulates network failure) */
  dropConnection?: boolean;
  /** Truncate response body to this many bytes */
  truncateBodyBytes?: number;
  /** Probability of triggering fault (0-1, default 1.0 = always) */
  probability?: number;
  /** Only match specific HTTP method (GET, POST, PUT, DELETE) */
  method?: string;
  /** Corrupt the response body by flipping random bits */
  corruptBody?: boolean;
  /** Add jitter to delay (random 0-jitterMs added to delayMs) */
  jitterMs?: number;
  /** Inject an SSE event with custom type and data (for testing SSE parsing) */
  injectSseEvent?: {
    /** Event type (e.g., "unknown", "control", "data") */
    eventType: string;
    /** Event data (will be sent as-is) */
    data: string;
  };
}
declare class DurableStreamTestServer {
  readonly store: StreamStore | FileBackedStreamStore;
  private server;
  private options;
  private _url;
  private activeSSEResponses;
  private isShuttingDown;
  /** Injected faults for testing retry/resilience */
  private injectedFaults;
  private consumerManager;
  private consumerRoutes;
  private pullWakeManager;
  private subscriptionManager;
  private subscriptionRoutes;
  private webhookManager;
  private webhookRoutes;
  constructor(options?: TestServerOptions);
  /**
  * Start the server.
  */
  start(): Promise<string>;
  /**
  * Stop the server.
  */
  stop(): Promise<void>;
  /**
  * Get the server URL.
  */
  get url(): string;
  /**
  * Clear all streams.
  */
  clear(): void;
  /**
  * Inject an error to be returned on the next N requests to a path.
  * Used for testing retry/resilience behavior.
  * @deprecated Use injectFault for full fault injection capabilities
  */
  injectError(path: string, status: number, count?: number, retryAfter?: number): void;
  /**
  * Inject a fault to be triggered on the next N requests to a path.
  * Supports various fault types: delays, connection drops, body corruption, etc.
  */
  injectFault(path: string, fault: Omit<InjectedFault, `count`> & {
    count?: number;
  }): void;
  /**
  * Clear all injected faults.
  */
  clearInjectedFaults(): void;
  setEnrichPayload(fn: WebhookManager[`enrichPayload`] | undefined): void;
  /**
  * Check if there's an injected fault for this path/method and consume it.
  * Returns the fault config if one should be triggered, null otherwise.
  */
  private consumeInjectedFault;
  /**
  * Apply delay from fault config (including jitter).
  */
  private applyFaultDelay;
  /**
  * Apply body modifications from stored fault (truncation, corruption).
  * Returns modified body, or original if no modifications needed.
  */
  private applyFaultBodyModification;
  private handleRequest;
  /**
  * Handle PUT - create stream
  */
  private handleCreate;
  /**
  * Handle HEAD - get metadata
  */
  private handleHead;
  /**
  * Handle GET - read data
  */
  private handleRead;
  /**
  * Handle SSE (Server-Sent Events) mode
  */
  private handleSSE;
  /**
  * Handle POST - append data
  */
  private handleAppend;
  private notifyStreamAppend;
  /**
  * Handle DELETE - delete stream
  */
  private handleDelete;
  /**
  * Handle test control endpoints for error injection.
  * POST /_test/inject-error - inject an error
  * DELETE /_test/inject-error - clear all injected errors
  */
  private handleTestInjectError;
  private readBody;
}

//#endregion
//#region src/path-encoding.d.ts
/**
* Encode a stream path to a filesystem-safe directory name using base64url encoding.
* Long paths (>200 chars) are hashed to keep directory names manageable.
*
* @example
* encodeStreamPath("/stream/users:created") → "L3N0cmVhbS91c2VyczpjcmVhdGVk"
*/
declare function encodeStreamPath(path: string): string;
/**
* Decode a filesystem-safe directory name back to the original stream path.
*
* @example
* decodeStreamPath("L3N0cmVhbS91c2VyczpjcmVhdGVk") → "/stream/users:created"
*/
declare function decodeStreamPath(encoded: string): string;

//#endregion
//#region src/registry-hook.d.ts
/**
* Creates lifecycle hooks that write to a __registry__ stream.
* Any client can read this stream to discover all streams and their lifecycle events.
*/
declare function createRegistryHooks(store: StreamStore | FileBackedStreamStore, serverUrl: string): {
  onStreamCreated: StreamLifecycleHook;
  onStreamDeleted: StreamLifecycleHook;
};

//#endregion
//#region src/cursor.d.ts
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
declare const DEFAULT_CURSOR_EPOCH: Date;
/**
* Default interval duration in seconds.
*/
declare const DEFAULT_CURSOR_INTERVAL_SECONDS = 20;
/**
* Configuration options for cursor calculation.
*/
interface CursorOptions {
  /**
  * Interval duration in seconds.
  * Default: 20 seconds.
  */
  intervalSeconds?: number;
  /**
  * Epoch timestamp for interval calculation.
  * Default: October 9, 2024 00:00:00 UTC.
  */
  epoch?: Date;
}
/**
* Calculate the current cursor value based on time intervals.
*
* @param options - Configuration for cursor calculation
* @returns The current cursor value as a string
*/
declare function calculateCursor(options?: CursorOptions): string;
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
declare function generateResponseCursor(clientCursor: string | undefined, options?: CursorOptions): string;
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
declare function handleCursorCollision(currentCursor: string, previousCursor: string | undefined, options?: CursorOptions): string;

//#endregion
//#region src/crypto.d.ts
interface WebhookPublicJwk {
  kty: `OKP`;
  crv: `Ed25519`;
  x: string;
  kid: string;
  use: `sig`;
  alg: `EdDSA`;
}
interface WebhookJwks {
  keys: Array<WebhookPublicJwk>;
}
/**
* Generate a webhook secret for a subscription.
*/

declare function getWebhookJwks(): WebhookJwks;

//#endregion
//#region src/subscription-types.d.ts
/**
* Sign a webhook payload for the Webhook-Signature header.
*
* Without a secret, signs with the upstream Ed25519/JWKS scheme.
* With a secret, signs with the PR #343 HMAC scheme used by the
* layered webhook conformance tests.
*/
type SubscriptionType = `webhook` | `pull-wake`;
type SubscriptionStatus = `active` | `failed`;
type SubscriptionLinkType = `glob` | `explicit`;
interface SubscriptionStreamLink {
  path: string;
  link_types: Set<SubscriptionLinkType>;
  acked_offset: string;
}
interface SubscriptionWebhookConfig {
  url: string;
}
interface SubscriptionRecord {
  id: string;
  type: SubscriptionType;
  pattern?: string;
  webhook?: SubscriptionWebhookConfig;
  wake_stream?: string;
  lease_ttl_ms: number;
  description?: string;
  created_at: string;
  status: SubscriptionStatus;
  config_hash: string;
  streams: Map<string, SubscriptionStreamLink>;
  generation: number;
  wake_id: string | null;
  wake_snapshot: Map<string, string>;
  token: string | null;
  holder: string | null;
  lease_timer: ReturnType<typeof setTimeout> | null;
  retry_count: number;
  retry_timer: ReturnType<typeof setTimeout> | null;
  next_attempt_at: number | null;
}
interface SubscriptionStreamInfo {
  path: string;
  link_type: SubscriptionLinkType;
  acked_offset: string;
  tail_offset: string;
  has_pending: boolean;
}
interface SubscriptionCreateInput {
  type: SubscriptionType;
  pattern?: string;
  streams: Array<string>;
  webhook?: {
    url: string;
  };
  wake_stream?: string;
  lease_ttl_ms: number;
  description?: string;
}
interface SubscriptionCallbackRequest {
  wake_id?: string;
  generation?: number;
  acks?: Array<{
    stream?: string;
    path?: string;
    offset: string;
  }>;
  done?: boolean;
}
type SubscriptionErrorCode = `INVALID_REQUEST` | `SUBSCRIPTION_NOT_FOUND` | `SUBSCRIPTION_ALREADY_EXISTS` | `WEBHOOK_URL_REJECTED` | `TOKEN_INVALID` | `TOKEN_EXPIRED` | `FENCED` | `ALREADY_CLAIMED` | `NO_PENDING_WORK` | `INVALID_OFFSET`;
interface SubscriptionError {
  code: SubscriptionErrorCode;
  message: string;
  current_holder?: string;
  generation?: number;
}

//#endregion
//#region src/subscription-manager.d.ts
interface StreamLike {
  currentOffset: string;
  softDeleted?: boolean;
}
interface SubscriptionStreamStore {
  has: (path: string) => boolean;
  get: (path: string) => StreamLike | undefined;
  list: () => Array<string>;
  append: (path: string, data: Uint8Array) => unknown;
}
declare function validateWebhookUrl(rawUrl: string): {
  ok: true;
} | {
  ok: false;
  message: string;
};
declare class SubscriptionManager {
  private readonly subscriptions;
  private readonly streamStore;
  private readonly callbackBaseUrl;
  private readonly webhooksEnabled;
  private isShuttingDown;
  constructor(opts: {
    callbackBaseUrl: string;
    streamStore: SubscriptionStreamStore;
    webhooksEnabled?: boolean;
  });
  createOrConfirm(id: string, input: SubscriptionCreateInput): {
    subscription: SubscriptionRecord;
    created: boolean;
  } | {
    error: SubscriptionError;
  };
  get(id: string): SubscriptionRecord | undefined;
  delete(id: string): boolean;
  addExplicitStreams(id: string, streams: Array<string>): boolean;
  removeExplicitStream(id: string, streamPath: string): boolean;
  onStreamAppend(absolutePath: string): Promise<void>;
  onStreamDeleted(absolutePath: string): void;
  handleWebhookCallback(id: string, token: string, request: SubscriptionCallbackRequest): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  claim(id: string, worker: string): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  ack(id: string, token: string, request: SubscriptionCallbackRequest): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  release(id: string, token: string, request: SubscriptionCallbackRequest): Promise<{
    status: number;
    body?: Record<string, unknown>;
  }>;
  serialize(subscription: SubscriptionRecord): Record<string, unknown>;
  getWebhookJwks(): ReturnType<typeof getWebhookJwks>;
  shutdown(): void;
  private maybeWake;
  private createWake;
  private deliverWebhook;
  private scheduleWebhookRetry;
  private writePullWakeEvent;
  private autoAckWakeSnapshot;
  private applyAcks;
  private validateWakeToken;
  private triggerNextWakeIfPending;
  private hasPendingWork;
  private firstPendingStream;
  private streamInfos;
  private linkStream;
  private listStreams;
  private getTailOffset;
  private subscriptionActionUrl;
  private webhookJwksUrl;
  private webhookSigningMetadata;
  private extendLease;
  private clearLease;
  private tokenSubject;
  private errorResponse;
}

//#endregion
//#region src/subscription-routes.d.ts
declare class SubscriptionRoutes {
  private readonly manager;
  constructor(manager: SubscriptionManager);
  handleRequest(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  private handleBase;
  private handleJwks;
  private handleStreams;
  private handleStream;
  private handleCallback;
  private handleClaim;
  private handleAck;
  private handleRelease;
  private parseCreateInput;
  private parseRoute;
  private readBearerToken;
  private readJson;
  private writeManagerResult;
  private writeJson;
  private writeError;
  private methodNotAllowed;
}

//#endregion
//#region src/pull-wake-manager.d.ts
interface WakeStreamStore {
  has: (path: string) => boolean;
  append: (path: string, data: Uint8Array) => unknown;
}
interface WakeEvent {
  type: `wake`;
  stream: string;
  consumer: string;
  ts: number;
}
interface ClaimedEvent {
  type: `claimed`;
  stream: string;
  worker: string;
  epoch: number;
  ts: number;
}
type PullWakeEvent = WakeEvent | ClaimedEvent;
declare class PullWakeManager {
  private consumerManager;
  private streamStore;
  private pendingWakes;
  private isShuttingDown;
  constructor(opts: {
    consumerManager: ConsumerManager;
    streamStore: WakeStreamStore;
  });
  /**
  * Called from server.ts when events are appended to a stream.
  * Checks if any pull-wake consumers subscribed to this stream need waking.
  */
  onStreamAppend(streamPath: string): void;
  /**
  * Handle lease expiry: if consumer has pending work, re-wake.
  */
  private handleLeaseExpired;
  /**
  * Handle epoch acquired: write a "claimed" event to the wake stream.
  */
  private handleEpochAcquired;
  /**
  * Handle epoch released: if consumer has pending work, re-wake.
  */
  private handleEpochReleased;
  /**
  * Write a wake event to the consumer's wake stream.
  */
  private writeWakeEvent;
  /**
  * Append an event to a wake stream.
  * Wake streams are ordinary L0 streams and must be created explicitly.
  */
  private appendToWakeStream;
  /**
  * Get the primary (first) stream path for a consumer.
  */
  private getPrimaryStream;
  shutdown(): void;
  clearPendingWake(consumerId: string): void;
}

//#endregion
//#region src/consumer-routes.d.ts
declare class ConsumerRoutes {
  private manager;
  private webhookManager;
  private pullWakeManager;
  constructor(manager: ConsumerManager, opts?: {
    webhookManager?: WebhookManager | null;
    pullWakeManager?: PullWakeManager | null;
  });
  /**
  * Try to handle a request as a consumer route.
  * Returns true if handled, false to pass through.
  */
  handleRequest(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  private handleRegister;
  private handleGet;
  private handleDelete;
  private handleAcquire;
  private handleAck;
  private handleRelease;
  private handleSetWakePreference;
  private readBody;
}

//#endregion
//#region src/webhook-routes.d.ts
/**
* Handles webhook-related HTTP routes.
*/
declare class WebhookRoutes {
  private manager;
  constructor(manager: WebhookManager);
  /**
  * Try to handle a request as a webhook route.
  * Returns true if the request was handled, false if it should be passed through.
  */
  handleRequest(method: string, url: URL, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  private handleCreateSubscription;
  private handleGetSubscription;
  private handleDeleteSubscription;
  private handleListSubscriptions;
  private handleCallback;
  private readBody;
}

//#endregion
//#region src/glob.d.ts
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
declare function globMatch(pattern: string, path: string): boolean;

//#endregion
export { AckRequest, AcquireResponse, CallbackError, CallbackErrorCode, CallbackRequest, CallbackResponse, CallbackSuccess, ClaimedEvent, Consumer, ConsumerError, ConsumerInfo, ConsumerManager, ConsumerRoutes, CursorOptions, DEFAULT_CURSOR_EPOCH, DEFAULT_CURSOR_INTERVAL_SECONDS, DurableStreamTestServer, FileBackedStreamStore, PendingLongPoll, PullWakeEvent, PullWakeManager, ReleaseResponse, Stream, StreamLifecycleEvent, StreamLifecycleHook, StreamMessage, StreamStore, Subscription, SubscriptionCallbackRequest, SubscriptionCreateInput, SubscriptionError, SubscriptionErrorCode, SubscriptionManager, SubscriptionRecord, SubscriptionRoutes, SubscriptionStatus, SubscriptionStreamInfo, SubscriptionStreamLink, SubscriptionType, TestServerOptions, WakeEvent, WakePreference, WebhookConsumer, WebhookManager, WebhookRoutes, WebhookStore, calculateCursor, createRegistryHooks, decodeStreamPath, encodeStreamPath, generateResponseCursor, globMatch, handleCursorCollision, validateWebhookUrl };