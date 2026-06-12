import { type HttpClient } from "effect/unstable/http";
import { Effect, Option, Stream } from "effect";
import type { Endpoint, HeadersRecord, LiveMode, Offset, ReadOpts } from "../DurableStream.ts";
import { Offset as MkOffset } from "../DurableStream.ts";
import type { ReadError } from "../errors.ts";
import { arrayDecoder } from "../internal/schema.ts";
import { sseStream } from "../internal/sse.ts";
import * as Http from "./Http.ts";
import * as C from "./constants.ts";

const BEGIN = MkOffset(C.OFFSET_BEGIN);

// ============================================================================
// Catch-up (live: false) — terminates on first up-to-date or stream-closed
// ============================================================================

interface CatchUpState {
  readonly offset: Offset;
  readonly done: boolean;
  /**
   * Sent as `If-None-Match` on the next request. Cleared after the first
   * use — the body of subsequent batches isn't conditionally fetched.
   */
  readonly nextIfNoneMatch: string | undefined;
}

const catchUpLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
  ifNoneMatch?: string,
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  Stream.paginate<CatchUpState, unknown, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, done: false, nextIfNoneMatch: ifNoneMatch },
    (state) => {
      if (state.done) {
        return Effect.succeed([[], Option.none<CatchUpState>()] as const);
      }
      return Effect.gen(function* () {
        const reqOpts: Parameters<typeof Http.getJson>[1] = {
          offset: state.offset,
          live: false,
          ...(state.nextIfNoneMatch !== undefined ? { ifNoneMatch: state.nextIfNoneMatch } : {}),
          ...(callHeaders !== undefined ? { callHeaders } : {}),
        };
        const res = yield* Http.getJson(endpoint, reqOpts);
        // 304: server says nothing new. Terminate immediately.
        if (res.notModified) {
          return [[] as ReadonlyArray<unknown>, Option.none<CatchUpState>()] as const;
        }
        const items: ReadonlyArray<unknown> = res.items.slice();
        const next: Option.Option<CatchUpState> =
          res.upToDate || res.streamClosed
            ? Option.none()
            : Option.some({
                offset: res.nextOffset,
                done: false,
                nextIfNoneMatch: undefined,
              });
        return [items, next] as const;
      });
    },
  );

// ============================================================================
// Long-poll (live: "long-poll") — keeps polling until stream-closed
// ============================================================================

interface LongPollState {
  readonly offset: Offset;
  readonly cursor: string | undefined;
}

// Build the long-poll `getJson` options for the current loop state, attaching
// the cursor and per-call headers only when present. Shared by the item and
// batch long-poll loops.
const longPollGetOpts = (
  state: LongPollState,
  callHeaders: HeadersRecord | undefined,
): Parameters<typeof Http.getJson>[1] => {
  const base =
    state.cursor !== undefined
      ? { offset: state.offset, live: "long-poll" as const, cursor: state.cursor }
      : { offset: state.offset, live: "long-poll" as const };
  return callHeaders !== undefined ? { ...base, callHeaders } : base;
};

type GetJsonResult = Effect.Success<ReturnType<typeof Http.getJson>>;

// Generic long-poll follow loop. Polls until stream-closed-with-no-items,
// projecting each server response into the emitted chunk. The item and batch
// loops differ ONLY in `project`, so the loop skeleton lives here once.
//
// `Stream.unfoldChunkEffect` (Option<[Chunk, S]>) was removed in Effect 4;
// `Stream.paginate` ([ReadonlyArray, Option<S>]) is the array-based
// replacement. The terminating case (stream-closed-with-no-items) maps to
// an empty page + `Option.none()` for the next state, preserving the
// "stop after the response that closed the stream" semantics.
const longPollUnfold = <T>(
  endpoint: Endpoint,
  startOffset: Offset,
  callHeaders: HeadersRecord | undefined,
  project: (res: GetJsonResult) => ReadonlyArray<T>,
): Stream.Stream<T, ReadError, HttpClient.HttpClient> =>
  Stream.paginate<LongPollState, T, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, cursor: undefined },
    (state) =>
      Effect.gen(function* () {
        const res = yield* Http.getJson(endpoint, longPollGetOpts(state, callHeaders));
        if (res.streamClosed && res.items.length === 0) {
          return [[] as ReadonlyArray<T>, Option.none<LongPollState>()] as const;
        }
        const next: LongPollState = { offset: res.nextOffset, cursor: res.cursor ?? state.cursor };
        return [project(res), Option.some(next)] as const;
      }),
  );

const longPollLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  longPollUnfold(endpoint, startOffset, callHeaders, (res) => res.items.slice());

// ============================================================================
// SSE (live: "sse")
// ============================================================================

const sseLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
  callHeaders?: HeadersRecord,
): Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =>
  sseStream(endpoint, startOffset, callHeaders);

// ============================================================================
// Public read entry point
// ============================================================================

const resolveStart = (_live: LiveMode | undefined, offset: Offset | undefined): Offset => {
  // Default is always BEGIN — caller gets "catch up from start, then tail live".
  // To tail from current end only, pass `offset: "now" as Offset`.
  return offset ?? BEGIN;
};

export const readStream = <A, I>(
  opts: ReadOpts<A, I>,
): Stream.Stream<A, ReadError, HttpClient.HttpClient> => {
  const live = opts.live ?? true;
  const startOffset = resolveStart(live, opts.offset);
  const callHeaders = opts.headers;
  // `live: true` is auto-select. SSE is the preferred live mode for JSON
  // streams (matches reference behavior). Callers behind proxies / CDNs
  // that don't honor SSE flush can pass explicit `live: "long-poll"`.
  // Binary streams should also pick long-poll explicitly.
  const raw: Stream.Stream<unknown, ReadError, HttpClient.HttpClient> =
    live === false
      ? catchUpLoop(opts.endpoint, startOffset, opts.ifNoneMatch, callHeaders)
      : live === "long-poll"
        ? longPollLoop(opts.endpoint, startOffset, callHeaders)
        : sseLoop(opts.endpoint, startOffset, callHeaders);
  const decode = arrayDecoder(opts.schema);
  // `mapArrayEffect` replaces v3's `mapChunksEffect`: it hands each non-empty
  // emitted array to the effectful transform and replaces it. `arrayDecoder`
  // is length-preserving (1 decoded item per raw item) and fails on the first
  // bad item, so a non-empty input yields a non-empty output — the
  // `NonEmptyReadonlyArray` cast is sound.
  return raw.pipe(
    Stream.mapArrayEffect((chunk) =>
      decode(chunk).pipe(Effect.map((arr) => arr as unknown as readonly [A, ...Array<A>])),
    ),
  );
};

// ============================================================================
// Collect-all with terminal offset (used by Reader.snapshotThenFollow for a
// no-gap, no-duplicate handoff from snapshot to live).
//
// Unlike `catchUpLoop`, this returns both the items and the EXACT offset the
// server returned at the last in-progress response — guaranteed > every item
// in the snapshot, and the natural resume point for a live read.
// ============================================================================

export const catchUpAll = (
  endpoint: Endpoint,
  startOffset: Offset = BEGIN,
  callHeaders?: HeadersRecord,
): Effect.Effect<
  { readonly items: ReadonlyArray<unknown>; readonly finalOffset: Offset },
  ReadError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const items: Array<unknown> = [];
    let offset = startOffset;
    while (true) {
      const res = yield* Http.getJson(endpoint, {
        offset,
        live: false,
        ...(callHeaders !== undefined ? { callHeaders } : {}),
      });
      items.push(...res.items);
      offset = res.nextOffset;
      if (res.upToDate || res.streamClosed) break;
    }
    return { items, finalOffset: offset };
  });

// ============================================================================
// Batch reads (metadata-preserving) — backs the client facade's jsonBatches().
// Emits one record PER server response, carrying the protocol metadata the
// item-flattening loops above discard.
// ============================================================================

export interface RawBatch {
  readonly items: ReadonlyArray<unknown>;
  readonly offset: Offset;
  readonly upToDate: boolean;
  readonly cursor: string | undefined;
}

const catchUpBatchLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
  callHeaders?: HeadersRecord,
): Stream.Stream<RawBatch, ReadError, HttpClient.HttpClient> =>
  Stream.paginate<CatchUpState, RawBatch, ReadError, HttpClient.HttpClient>(
    { offset: startOffset, done: false, nextIfNoneMatch: undefined },
    (state) => {
      if (state.done) {
        return Effect.succeed([
          [] as ReadonlyArray<RawBatch>,
          Option.none<CatchUpState>(),
        ] as const);
      }
      return Effect.gen(function* () {
        const res = yield* Http.getJson(endpoint, {
          offset: state.offset,
          live: false,
          ...(callHeaders !== undefined ? { callHeaders } : {}),
        });
        const batch: RawBatch = {
          items: res.items,
          offset: res.nextOffset,
          upToDate: res.upToDate,
          cursor: res.cursor,
        };
        const next: Option.Option<CatchUpState> =
          res.upToDate || res.streamClosed
            ? Option.none()
            : Option.some({ offset: res.nextOffset, done: false, nextIfNoneMatch: undefined });
        return [[batch], next] as const;
      });
    },
  );

const longPollBatchLoop = (
  endpoint: Endpoint,
  startOffset: Offset,
  callHeaders?: HeadersRecord,
): Stream.Stream<RawBatch, ReadError, HttpClient.HttpClient> =>
  longPollUnfold(endpoint, startOffset, callHeaders, (res) => [
    {
      items: res.items,
      offset: res.nextOffset,
      upToDate: res.upToDate,
      cursor: res.cursor,
    },
  ]);

/**
 * Stream of raw (un-decoded) batches with protocol metadata. `live: false`
 * walks catch-up to up-to-date; any other mode follows via long-poll (the
 * batch API maps cleanly onto discrete long-poll responses — for SSE
 * item-level follow use {@link readStream}).
 */
export const batchStream = (
  endpoint: Endpoint,
  opts: { readonly live?: LiveMode; readonly offset?: Offset; readonly headers?: HeadersRecord },
): Stream.Stream<RawBatch, ReadError, HttpClient.HttpClient> => {
  const startOffset = opts.offset ?? BEGIN;
  return opts.live === false
    ? catchUpBatchLoop(endpoint, startOffset, opts.headers)
    : longPollBatchLoop(endpoint, startOffset, opts.headers);
};

// Helpers re-exported for Reader.
export { BEGIN };
