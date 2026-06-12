// Raw SSE transport boundary: JSON.parse operates on wire frames (unknown
// payloads); typed Schema decode happens at the layers above.
// @effect-diagnostics effect/preferSchemaOverJson:off
import { type HttpClient } from "effect/unstable/http";
import { Effect, Ref, Stream } from "effect";
import { createParser } from "eventsource-parser";
import type { Endpoint, HeadersRecord, Offset } from "../DurableStream.ts";
import { Offset as MkOffset } from "../DurableStream.ts";
import type { ReadError } from "../errors.ts";
import { DecodeError, TransportError } from "../errors.ts";
import * as C from "../protocol/constants.ts";
import * as Http from "../protocol/Http.ts";

interface ParsedControl {
  readonly streamNextOffset?: string;
  readonly streamCursor?: string;
  readonly streamClosed?: boolean;
  readonly upToDate?: boolean;
}

const textDecoder = new TextDecoder();

const decodeBase64Utf8 = (data: string): string =>
  textDecoder.decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));

const parseControl = (data: string): Effect.Effect<ParsedControl, DecodeError> =>
  Effect.try({
    try: () => JSON.parse(data) as ParsedControl,
    catch: (cause) => new DecodeError({ cause, raw: data }),
  });

const parseDataPayload = (
  data: string,
  base64: boolean,
): Effect.Effect<ReadonlyArray<unknown>, DecodeError> => {
  // For binary streams the server sets `stream-sse-data-encoding: base64`
  // (§5.8). The base64 payload may span multiple `data:` lines that got
  // concatenated; per spec, strip newlines and decode before parsing.
  const prepared = base64 ? decodeBase64Utf8(data.replace(/\r?\n/g, "")) : data;
  const trimmed = prepared.trim();
  if (trimmed === "") return Effect.succeed([]);
  return Effect.try({
    try: (): ReadonlyArray<unknown> => {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as ReadonlyArray<unknown>) : [parsed];
    },
    catch: (cause) => new DecodeError({ cause, raw: data }),
  });
};

/**
 * Open one SSE connection and emit items. The byte stream is the canonical
 * lifecycle source — when the consumer cancels (e.g., `Stream.take(N)` is
 * satisfied), the response body stream is cancelled by HttpClient/the scope,
 * which terminates everything below. No unmanaged Promise.
 *
 * `eventsource-parser` is a synchronous push-style parser: each `feed(text)`
 * call invokes `onEvent` 0+ times. We collect emitted events in a per-chunk
 * buffer that's drained inside `mapConcatChunkEffect`, so the parser never
 * outlives the surrounding scope.
 */
const sseConnection = (
  endpoint: Endpoint,
  offsetRef: Ref.Ref<Offset>,
  closedRef: Ref.Ref<boolean>,
  callHeaders: HeadersRecord | undefined,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const offset = yield* Ref.get(offsetRef);
      const res = yield* Http.getStream(endpoint, {
        offset,
        accept: C.CONTENT_TYPE_SSE,
        ...(callHeaders !== undefined ? { callHeaders } : {}),
      });
      // §5.8: when the server flags `stream-sse-data-encoding: base64`,
      // every data payload is base64-encoded raw bytes. Pass the flag down
      // to the parser so it decodes before JSON-parsing.
      const dataEncodingHeader =
        res.headers[C.STREAM_SSE_DATA_ENCODING] ??
        res.headers[C.STREAM_SSE_DATA_ENCODING.toLowerCase()];
      const isBase64 = dataEncodingHeader === "base64";

      // Per-connection state: parser, decoder, buffer for emitted events,
      // and a slot for any parser-level error. These are captured by the
      // closure passed to `mapConcatChunkEffect` so they live exactly as
      // long as the byte stream below.
      const decoder = new TextDecoder();
      const eventBuffer: Array<{ event: string | undefined; data: string }> = [];
      let parseError: Error | null = null;
      const parser = createParser({
        onEvent: (event) => {
          eventBuffer.push({ event: event.event, data: event.data });
        },
        onError: (err) => {
          parseError = err;
        },
      });

      return res.stream.pipe(
        Stream.mapError((e): ReadError => new TransportError({ cause: e })),
        Stream.flatMap((bytes: Uint8Array) =>
          Stream.fromArrayEffect(
            Effect.gen(function* () {
              eventBuffer.length = 0;
              parser.feed(decoder.decode(bytes, { stream: true }));
              if (parseError !== null) {
                const e = parseError;
                parseError = null;
                return yield* new TransportError({ cause: e });
              }
              const out: Array<unknown> = [];
              let eventIndex = 0;
              while (eventIndex < eventBuffer.length) {
                const event = eventBuffer[eventIndex]!;
                const name = event.event ?? "message";
                if (name === C.SSE_EVENT_DATA || name === "message") {
                  const items = yield* parseDataPayload(event.data, isBase64);
                  out.push(...items);
                } else if (name === C.SSE_EVENT_CONTROL) {
                  const ctrl = yield* parseControl(event.data);
                  if (typeof ctrl.streamNextOffset === "string") {
                    yield* Ref.set(offsetRef, MkOffset(ctrl.streamNextOffset));
                  }
                  if (ctrl.streamClosed === true) {
                    yield* Ref.set(closedRef, true);
                  }
                }
                eventIndex += 1;
              }
              return out;
            }),
          ),
        ),
      );
    }),
  );

/**
 * Stream items via SSE with automatic reconnection. The server closes
 * connections every ~60s (§8.2). On end of stream we re-open from the last
 * tracked offset, UNLESS the just-finished connection observed a
 * `streamClosed: true` control event — in which case we terminate.
 *
 * Termination is anchored on a `closedRef` checked between rounds rather
 * than on the in-flight stream's elements. The previous shape used
 * `Stream.repeat(forever).takeUntilEffect(closedRef)`, which only checked
 * the predicate AFTER an element flowed through — so a control event that
 * set the flag without producing items (the common case when a stream
 * closes cleanly with no trailing data) wedged the outer loop into
 * infinite reconnect.
 */
export const sseStream = (
  endpoint: Endpoint,
  startOffset: Offset,
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const offsetRef = yield* Ref.make<Offset>(startOffset);
      const closedRef = yield* Ref.make<boolean>(false);

      const loop = (): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const closed = yield* Ref.get(closedRef);
            if (closed) return Stream.empty;
            return sseConnection(endpoint, offsetRef, closedRef, callHeaders).pipe(
              Stream.concat(Stream.suspend(loop)),
            );
          }),
        );

      return loop();
    }),
  );
