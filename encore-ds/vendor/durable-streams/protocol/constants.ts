// Header names are case-insensitive on the wire but we normalize to lowercase
// when reading because @effect/platform/HttpClient surfaces headers lowercased.

export const STREAM_NEXT_OFFSET = "stream-next-offset";
export const STREAM_CURSOR = "stream-cursor";
export const STREAM_UP_TO_DATE = "stream-up-to-date";
export const STREAM_CLOSED = "stream-closed";
export const STREAM_SEQ = "stream-seq";
export const STREAM_TTL = "stream-ttl";
export const STREAM_EXPIRES_AT = "stream-expires-at";
export const STREAM_SSE_DATA_ENCODING = "stream-sse-data-encoding";

export const PRODUCER_ID = "producer-id";
export const PRODUCER_EPOCH = "producer-epoch";
export const PRODUCER_SEQ = "producer-seq";
export const PRODUCER_EXPECTED_SEQ = "producer-expected-seq";
export const PRODUCER_RECEIVED_SEQ = "producer-received-seq";

export const QUERY_OFFSET = "offset";
export const QUERY_LIVE = "live";
export const QUERY_CURSOR = "cursor";

export const LIVE_LONG_POLL = "long-poll";
export const LIVE_SSE = "sse";

export const OFFSET_BEGIN = "-1";

export const SSE_EVENT_DATA = "data";
export const SSE_EVENT_CONTROL = "control";

export const CONTENT_TYPE_JSON = "application/json";
export const CONTENT_TYPE_SSE = "text/event-stream";
