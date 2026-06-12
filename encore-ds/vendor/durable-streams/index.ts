/**
 * effect-durable-streams
 *
 * Effect-native client for the Durable Streams Protocol. Reads are Stream,
 * writes are Sink, schema sits at the wire boundary.
 *
 * Provide `FetchHttpClient.layer` (or any `HttpClient` layer) at the top of
 * your program — every operation requires `HttpClient.HttpClient` in `R`.
 */

export * as DurableStream from "./namespace.ts";
export {
  DurableStreamClient,
  layer as DurableStreamClientLayer,
  layerFetch as DurableStreamClientLayerFetch,
} from "./Client.ts";
export type {
  DurableStreamClientService,
  RawAppendOptions,
  RawBatch,
  RawStreamOptions,
  RawStreamSession,
  TypedClient,
} from "./Client.ts";
export type {
  Bound,
  CloseOptions,
  CreateOptions,
  Endpoint,
  ErrorHandler,
  HeadResult,
  HeadersRecord,
  HeaderValue,
  LiveMode,
  Offset,
  ParamsRecord,
  Producer,
  ProducerAppendOpts,
  ProducerAppendResult,
  ProducerFailure,
  ProducerOptions,
  ReadError,
  ReadOpts,
  RetryOpts,
  SnapshotResult,
  WriteError,
} from "./DurableStream.ts";
export {
  Conflict,
  DecodeError,
  Gone,
  NotFound,
  SequenceGap,
  StaleEpoch,
  StreamClosed,
  TransportError,
} from "./errors.ts";
