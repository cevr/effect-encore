import { type HttpClient } from "effect/unstable/http";
import { Effect, Stream } from "effect";
import type {
  CollectOpts,
  Endpoint,
  HeadersRecord,
  HeadResult,
  ReadOpts,
  SnapshotResult,
} from "./DurableStream.ts";
import type { Gone, NotFound, ReadError, TransportError } from "./errors.ts";
import { arrayDecoder } from "./internal/schema.ts";
import * as Http from "./protocol/Http.ts";
import { BEGIN, catchUpAll, readStream } from "./protocol/Read.ts";

export const read = <A, I>(
  opts: ReadOpts<A, I>,
): Stream.Stream<A, ReadError, HttpClient.HttpClient> => readStream(opts);

export const collect = <A, I>(
  opts: CollectOpts<A, I>,
): Effect.Effect<ReadonlyArray<A>, ReadError, HttpClient.HttpClient> =>
  read({
    endpoint: opts.endpoint,
    schema: opts.schema,
    live: false,
    offset: BEGIN,
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
  }).pipe(Stream.runCollect);

export const head = (
  endpoint: Endpoint,
  callHeaders?: HeadersRecord,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Http.head(endpoint, callHeaders);

/**
 * Snapshot then follow — no-gap, no-duplicate.
 *
 * Walks the catch-up read loop to completion, capturing the precise terminal
 * offset the server returned at the last in-progress response. Items past
 * that offset are guaranteed not to be in the snapshot. The returned `live`
 * stream resumes from exactly that offset, so any concurrent appends that
 * arrive during the catch-up window are observed either fully in `snapshot`
 * or fully in `live`, never in both.
 */
export const snapshotThenFollow = <A, I>(
  opts: CollectOpts<A, I>,
): Effect.Effect<SnapshotResult<A>, ReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { items, finalOffset } = yield* catchUpAll(opts.endpoint, BEGIN, opts.headers);
    const decoded = yield* arrayDecoder(opts.schema)(items);
    const live = read({
      endpoint: opts.endpoint,
      schema: opts.schema,
      live: true,
      offset: finalOffset,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    });
    return { snapshot: decoded, live };
  });

/**
 * Tail from the current end of the stream — "subscribe to new events".
 *
 * The first emit observed by the caller is the next append after `tail` was
 * resolved. Historical items are NOT replayed. This is the ergonomic
 * counterpart to `read({ live: true })`, which intentionally defaults to
 * "catch up from the beginning, then follow" (matching the protocol).
 *
 * Implementation: a single `HEAD` request resolves the current end offset,
 * then a live read resumes from exactly that offset.
 */
export const tail = <A, I>(
  opts: CollectOpts<A, I>,
): Effect.Effect<
  Stream.Stream<A, ReadError, HttpClient.HttpClient>,
  TransportError | NotFound | Gone,
  HttpClient.HttpClient
> =>
  Effect.map(Http.head(opts.endpoint, opts.headers), (h) =>
    read({
      endpoint: opts.endpoint,
      schema: opts.schema,
      live: true,
      offset: h.offset,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    }),
  );
