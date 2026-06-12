// Re-export the operational surface under a single namespace import.
// Usage: `import { DurableStream } from "effect-durable-streams"`.
export {
  Offset,
  type Bound,
  type CloseOptions,
  type CreateOptions,
  type Endpoint,
  type HeadResult,
  type HeadersRecord,
  type HeaderValue,
  type LiveMode,
  type ErrorHandler,
  type ParamsRecord,
  type Producer,
  type ProducerAppendOpts,
  type ProducerAppendResult,
  type ProducerFailure,
  type ProducerOptions,
  type RetryOpts,
  type ReadError,
  type ReadOpts,
  type SnapshotResult,
  type WriteError,
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
export { define } from "./Bound.ts";
export { append, appendWithProducer, close, create, del as delete, producer } from "./Writer.ts";
export { collect, head, read, snapshotThenFollow, tail } from "./Reader.ts";
