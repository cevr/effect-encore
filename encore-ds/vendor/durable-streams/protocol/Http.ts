// Raw HTTP transport boundary: JSON.parse/stringify operate on the wire body
// (unknown response payloads / already-encoded request bodies); typed Schema
// decode happens at the layers above.
// @effect-diagnostics effect/preferSchemaOverJson:off
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import { Clock, Data, Duration, Effect, Ref, Schedule } from "effect";
import type {
  Endpoint,
  HeadersRecord,
  HeaderValue,
  HeadResult,
  Offset,
  ParamValue,
} from "../DurableStream.ts";
import { Gone, NotFound, TransportError } from "../errors.ts";
import * as C from "./constants.ts";

// === Header / query param resolution =============================

type ResolvableString = HeaderValue | Exclude<ParamValue, undefined>;

const resolveString = (value: ResolvableString): Effect.Effect<string, never, never> => {
  if (typeof value === "string") return Effect.succeed(value);
  const r = value();
  if (typeof r === "string") return Effect.succeed(r);
  if (Effect.isEffect(r)) return r;
  return Effect.promise(() => r);
};

const resolveRecord = <A>(
  record: { readonly [name: string]: A } | undefined,
  resolve: (value: A) => Effect.Effect<string | undefined, never, never>,
): Effect.Effect<Record<string, string>, never, never> =>
  record === undefined
    ? Effect.succeed({})
    : Effect.forEach(Object.entries(record), ([name, value]) =>
        Effect.map(resolve(value), (resolved) => [name, resolved] as const),
      ).pipe(
        Effect.map((pairs) =>
          Object.fromEntries(
            pairs.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
          ),
        ),
      );

const resolveHeadersRecord = (
  headers: { readonly [name: string]: HeaderValue } | undefined,
): Effect.Effect<Record<string, string>, never, never> =>
  resolveRecord(headers, (value) => resolveString(value));

const resolveHeaders = (endpoint: Endpoint): Effect.Effect<Record<string, string>, never, never> =>
  resolveHeadersRecord(endpoint.headers);

const resolveParam = (value: ParamValue): Effect.Effect<string | undefined, never, never> => {
  // `undefined` is the legitimate `string | undefined` success value here, not a
  // void — effectSucceedWithVoid false-positives on nullable returns.
  // @effect-diagnostics-next-line effect/effectSucceedWithVoid:off
  if (value === undefined) return Effect.succeed(undefined);
  return resolveString(value);
};

const resolveParamsRecord = (
  params: Endpoint["params"],
): Effect.Effect<Record<string, string>, never, never> => resolveRecord(params, resolveParam);

// === Response → typed error mapping =============================

const STREAM_NEXT_OFFSET = C.STREAM_NEXT_OFFSET;
const STREAM_CLOSED = C.STREAM_CLOSED;

const headerValue = (
  res: HttpClientResponse.HttpClientResponse,
  name: string,
): string | undefined => res.headers[name] ?? res.headers[name.toLowerCase()];

const isClosed = (res: HttpClientResponse.HttpClientResponse): boolean =>
  headerValue(res, STREAM_CLOSED) === "true";

export const missingStreamError = (status: number, url: string): NotFound | Gone | undefined =>
  status === 404 ? new NotFound({ url }) : status === 410 ? new Gone({ url }) : undefined;

// === Retry policy ================================================
//
// Two classes of transient failure retry through the schedule:
//
//   1. Network-level errors (`HttpClientError` "RequestError") — the request
//      never reached the server, or the response was abruptly cut off.
//   2. Retryable server-side statuses — 5xx (server unhealthy) and 429
//      (rate-limited). A successful HTTP exchange with a bad status is NOT
//      raised by `@effect/platform`'s client, so we re-package it as a
//      typed retryable failure (`RetryableHttpStatus`) so the schedule
//      treats it the same way as a network error.
//
// Protocol errors (404 / 409 / 410) and other 4xx are NEVER retried — the
// server is responding correctly and a retry would not change the answer.

/**
 * Marker failure used to drive a response with a retryable status (5xx, 429)
 * through `Effect.retry`. Carries the response so the per-op caller can
 * inspect it on exhaustion.
 */
class RetryableHttpStatus extends Data.TaggedError("DurableStream/RetryableHttpStatus")<{
  readonly response: HttpClientResponse.HttpClientResponse;
}> {}

const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

const isTransient = (e: HttpClientError | RetryableHttpStatus): boolean => {
  if (e._tag === "DurableStream/RetryableHttpStatus") return true;
  // Network-level failure: the request never reached the server (or the
  // response was cut off). In Effect 4 these surface as an
  // `HttpClientError` whose `reason` is a `TransportError`.
  return e._tag === "HttpClientError" && e.reason._tag === "TransportError";
};

/**
 * Parse a `Retry-After` header per RFC 7231 §7.1.3. Returns milliseconds, or
 * `undefined` if the header is absent / malformed.
 *
 * Two formats are accepted:
 *   - Delta-seconds: a non-negative integer-or-decimal seconds value.
 *   - HTTP-date: parsed via `Date.parse`; the delta from "now" is returned.
 *
 * HTTP-date is CAPPED at 1 hour to defend against misbehaving / hostile
 * servers that could otherwise wedge the client indefinitely.
 */
const parseRetryAfter = (raw: string | undefined, nowMs: number): number | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  // Delta-seconds.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  // HTTP-date.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  const deltaMs = parsed - nowMs;
  if (deltaMs <= 0) return 0;
  return Math.min(deltaMs, 60 * 60 * 1000); // 1-hour cap
};

const retryErrorTag = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { readonly _tag?: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  return typeof error;
};

const emitSpanEvent = (name: string, attributes: Record<string, unknown>): Effect.Effect<void> =>
  Effect.currentSpan.pipe(
    Effect.zip(Clock.currentTimeMillis),
    Effect.tap(([span, nowMs]) =>
      Effect.sync(() => {
        span.event(name, BigInt(nowMs) * 1_000_000n, attributes);
      }),
    ),
    Effect.asVoid,
    Effect.ignore,
  );

// Exponential backoff (100ms, 200ms, 400ms, ...) capped at 3s per attempt,
// limited to 4 total retries.
//
// - `Schedule.either(spaced(...))` (a.k.a. `union`) continues while either
//   side continues, taking the MIN delay. exponential is unbounded, spaced
//   is constant — `min(exp_n, 3s)` gives the per-step cap.
// - `Schedule.intersect(recurs(n))` continues while BOTH sides continue,
//   taking the MAX delay. recurs(n) has delay 0, so the delay stays the
//   capped exponential, but the schedule stops after n recurrences.
//
// The previous shape used `Schedule.compose(recurs)` which selects the
// SHORTER delay — composing with recurs (delay 0) collapses the entire
// backoff to zero-delay retries, then `either(spaced)` re-extends the
// schedule forever every 3s. That's not what "exponential capped at 3s,
// 4 retries" means.
const defaultRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.either(Schedule.spaced("3 seconds")),
  // `intersect` was renamed `both` in Effect 4 — same semantics: continue
  // while BOTH schedules want to recur, taking the MAX delay. recurs(4) has
  // delay 0, so the delay stays the capped exponential but the schedule
  // stops after 4 recurrences.
  Schedule.both(Schedule.recurs(4)),
);

const scheduleFor = (endpoint: Endpoint): Schedule.Schedule<unknown, unknown, never> =>
  endpoint.retrySchedule ?? defaultRetrySchedule;

// === Request construction =======================================

/**
 * Compose the final header map for a request:
 *
 *   endpoint headers  (resolved per request — function values re-evaluated)
 *     ⊕ call headers  (per-call overrides; resolved per request)
 *     ⊕ protocol-internal extras (e.g., `producer-seq`, `if-none-match`)
 *
 * Later layers win on collisions, so the caller can override an
 * endpoint header for a specific call AND the protocol can override a
 * caller header it absolutely needs to set for correctness.
 */
const buildHeaders = (
  endpoint: Endpoint,
  callHeaders: HeadersRecord | undefined,
  extra: Record<string, string> | undefined,
): Effect.Effect<Record<string, string>> =>
  Effect.gen(function* () {
    const base = yield* resolveHeaders(endpoint);
    const call = yield* resolveHeadersRecord(callHeaders);
    return { ...base, ...call, ...(extra ?? {}) };
  });

const applyParams = (
  req: HttpClientRequest.HttpClientRequest,
  params: Record<string, string> | undefined,
): HttpClientRequest.HttpClientRequest => {
  if (!params) return req;
  let out = req;
  const entries = Object.entries(params);
  let index = 0;
  while (index < entries.length) {
    const [k, v] = entries[index]!;
    out = HttpClientRequest.setUrlParam(k, v)(out);
    index += 1;
  }
  return out;
};

// === onError retry hook ==========================================
//
// Wrap any HTTP operation with the endpoint's `onError` handler (if set).
// The handler is invoked after transport-level retries exhaust and the
// operation fails. If it returns `RetryOpts`, headers are merged into the
// endpoint and the operation is retried — bounded by `onErrorMaxRetries`
// to prevent runaway loops. If it returns `undefined`, the original error
// propagates.

const withOnErrorHandler = <A, E, R>(
  endpoint: Endpoint,
  attempt: (ep: Endpoint) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const handler = endpoint.onError;
  if (!handler) return attempt(endpoint);
  const cap = endpoint.onErrorMaxRetries ?? 4;
  const loop = (ep: Endpoint, attemptsLeft: number): Effect.Effect<A, E, R> =>
    attempt(ep).pipe(
      Effect.catch((err) => {
        if (attemptsLeft <= 0) return Effect.fail(err);
        return Effect.flatMap(handler(err), (retry) => {
          if (!retry) return Effect.fail(err);
          const merged: Endpoint = {
            ...ep,
            headers: { ...(ep.headers ?? {}), ...(retry.headers ?? {}) },
          };
          return loop(merged, attemptsLeft - 1);
        });
      }),
    );
  return loop(endpoint, cap);
};

// === Operations ==================================================

const urlOf = (endpoint: Endpoint): string =>
  typeof endpoint.url === "string" ? endpoint.url : endpoint.url.toString();

const requestUrlOf = (endpoint: Endpoint): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    const url = new URL(urlOf(endpoint));
    const params = yield* resolveParamsRecord(endpoint.params);
    const entries = Object.entries(params);
    let index = 0;
    while (index < entries.length) {
      const [key, value] = entries[index]!;
      url.searchParams.set(key, value);
      index += 1;
    }
    return url.toString();
  });

/**
 * Shared request-execution boilerplate: build headers, build the request via
 * the caller's shaper, execute with the endpoint's retry schedule, map
 * transport errors. Returns the raw response — caller inspects status.
 */
const executeWithRetry = (
  endpoint: Endpoint,
  shape: (url: string, headers: Record<string, string>) => HttpClientRequest.HttpClientRequest,
  callHeaders: HeadersRecord | undefined,
  extraHeaders?: Record<string, string>,
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* requestUrlOf(endpoint);
    const headers = yield* buildHeaders(endpoint, callHeaders, extraHeaders);
    const client = yield* HttpClient.HttpClient;
    const attempts = yield* Ref.make(0);

    // Single attempt: execute the request and, if the server responded with
    // a retryable status (5xx / 429), pre-sleep any `Retry-After` window
    // and then fail with `RetryableHttpStatus` so `Effect.retry` re-enters
    // the schedule. On non-retryable status we just return the response —
    // the per-op caller inspects the status to map to typed protocol errors.
    const attempt = Effect.gen(function* () {
      const attemptNumber = yield* Ref.updateAndGet(attempts, (n) => n + 1);
      const res = yield* client.execute(shape(url, headers)).pipe(
        Effect.tapError((error) =>
          emitSpanEvent("retry.attempt", {
            "firegrid.retry.attempt": attemptNumber,
            "firegrid.retry.error": retryErrorTag(error),
          }),
        ),
      );
      if (!isRetryableStatus(res.status)) {
        yield* emitSpanEvent("retry.attempt", {
          "firegrid.retry.attempt": attemptNumber,
          "firegrid.retry.http_status": res.status,
          "firegrid.retry.retryable": false,
        });
        return res;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const retryAfterMs = parseRetryAfter(headerValue(res, "retry-after"), nowMs);
      yield* emitSpanEvent("retry.attempt", {
        "firegrid.retry.attempt": attemptNumber,
        "firegrid.retry.http_status": res.status,
        "firegrid.retry.retryable": true,
        ...(retryAfterMs === undefined ? {} : { "firegrid.retry.retry_after_ms": retryAfterMs }),
      });
      // The schedule's own delay still runs on top of `Retry-After`. In
      // the common case the schedule's per-step delay (≤ 3s) is small
      // compared to a server-provided wait, so the extra cost is bounded.
      const wait =
        retryAfterMs !== undefined ? Effect.sleep(Duration.millis(retryAfterMs)) : Effect.void;
      return yield* wait.pipe(
        Effect.flatMap(() => Effect.fail(new RetryableHttpStatus({ response: res }))),
      );
    });

    return yield* attempt.pipe(
      Effect.retry({ schedule: scheduleFor(endpoint), while: isTransient }),
      // Retry exhausted on a retryable status: pass the last response
      // through to the per-op caller so it can decide how to map the
      // status (e.g., the catch-up read may surface it as TransportError).
      Effect.catchTag("DurableStream/RetryableHttpStatus", (e) => Effect.succeed(e.response)),
      Effect.mapError((e) => new TransportError({ cause: e })),
      Effect.withSpan("firegrid.durable_streams.http.request", {
        kind: "client",
      }),
    );
  });

const executeGet = (
  endpoint: Endpoint,
  params: Record<string, string>,
  callHeaders: HeadersRecord | undefined,
  extraHeaders?: Record<string, string>,
): Effect.Effect<HttpClientResponse.HttpClientResponse, TransportError, HttpClient.HttpClient> =>
  executeWithRetry(
    endpoint,
    (u, h) => applyParams(HttpClientRequest.get(u).pipe(HttpClientRequest.setHeaders(h)), params),
    callHeaders,
    extraHeaders,
  );

const headInner = (
  endpoint: Endpoint,
  callHeaders: HeadersRecord | undefined,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint);
    const res = yield* executeWithRetry(
      endpoint,
      (u, h) => HttpClientRequest.head(u).pipe(HttpClientRequest.setHeaders(h)),
      callHeaders,
    );
    const missing = missingStreamError(res.status, url);
    if (missing !== undefined) return yield* missing;
    if (res.status < 200 || res.status >= 300) {
      return yield* new TransportError({ cause: new Error(`HEAD ${url}: status ${res.status}`) });
    }
    const offset = (headerValue(res, STREAM_NEXT_OFFSET) ?? "") as Offset;
    const result: HeadResult = {
      offset,
      contentType: headerValue(res, "content-type"),
      streamClosed: isClosed(res),
      ttlSeconds: parseInt(headerValue(res, C.STREAM_TTL) ?? "", 10) || undefined,
      expiresAt: headerValue(res, C.STREAM_EXPIRES_AT),
      etag: headerValue(res, "etag"),
      cacheControl: headerValue(res, "cache-control"),
      cursor: headerValue(res, C.STREAM_CURSOR),
    };
    return result;
  });

export const head = (
  endpoint: Endpoint,
  callHeaders?: HeadersRecord,
): Effect.Effect<HeadResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, (ep) => headInner(ep, callHeaders));

interface GetJsonResult {
  readonly items: ReadonlyArray<unknown>;
  readonly nextOffset: Offset;
  readonly cursor: string | undefined;
  readonly upToDate: boolean;
  readonly streamClosed: boolean;
  readonly status: number;
  readonly etag: string | undefined;
  readonly notModified: boolean;
}

export const getJson = (
  endpoint: Endpoint,
  opts: {
    readonly offset: Offset;
    readonly live?: false | "long-poll";
    readonly cursor?: string;
    /**
     * If supplied, send `If-None-Match: <etag>`. Server may return 304 Not
     * Modified — caller treats that as "no new data since last read" and
     * keeps using the prior offset + body. See §8.1.
     */
    readonly ifNoneMatch?: string;
    /** Per-call headers (see {@link HeadersRecord}). */
    readonly callHeaders?: HeadersRecord;
  },
): Effect.Effect<GetJsonResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, (ep) => getJsonInner(ep, opts));

const getJsonInner = (
  endpoint: Endpoint,
  opts: {
    readonly offset: Offset;
    readonly live?: false | "long-poll";
    readonly cursor?: string;
    readonly ifNoneMatch?: string;
    readonly callHeaders?: HeadersRecord;
  },
): Effect.Effect<GetJsonResult, TransportError | NotFound | Gone, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = urlOf(endpoint);
    const extra: Record<string, string> = {};
    if (opts.ifNoneMatch !== undefined) extra["if-none-match"] = opts.ifNoneMatch;
    const params: Record<string, string> = { [C.QUERY_OFFSET]: opts.offset };
    if (opts.live === "long-poll") params[C.QUERY_LIVE] = C.LIVE_LONG_POLL;
    if (opts.cursor !== undefined) params[C.QUERY_CURSOR] = opts.cursor;

    const res = yield* executeGet(endpoint, params, opts.callHeaders, extra);
    const missing = missingStreamError(res.status, url);
    if (missing !== undefined) return yield* missing;
    if (res.status === 304) {
      // Server says "nothing changed since the etag you sent". Surface as
      // an empty result with notModified=true — caller decides whether to
      // poll again later or treat as up-to-date.
      return {
        items: [],
        nextOffset: opts.offset,
        cursor: headerValue(res, C.STREAM_CURSOR),
        upToDate: true,
        streamClosed: isClosed(res),
        status: 304,
        etag: opts.ifNoneMatch,
        notModified: true,
      };
    }
    if (res.status !== 200 && res.status !== 204) {
      return yield* new TransportError({ cause: new Error(`GET ${url}: status ${res.status}`) });
    }

    const nextOffset = (headerValue(res, STREAM_NEXT_OFFSET) ?? opts.offset) as Offset;
    const cursor = headerValue(res, C.STREAM_CURSOR);
    const upToDate = headerValue(res, C.STREAM_UP_TO_DATE) !== undefined;
    const streamClosed = isClosed(res);
    const etag = headerValue(res, "etag");

    if (res.status === 204) {
      return {
        items: [],
        nextOffset,
        cursor,
        upToDate,
        streamClosed,
        status: 204,
        etag,
        notModified: false,
      };
    }
    // 200 — parse JSON array (per protocol §7.1 reads return arrays).
    const body = yield* res.text.pipe(Effect.mapError((e) => new TransportError({ cause: e })));
    // Parse the JSON body via Effect.try so a malformed response surfaces
    // as a typed TransportError on the error channel — never a defect.
    const items: ReadonlyArray<unknown> =
      body.trim() === ""
        ? []
        : yield* Effect.try({
            try: (): ReadonlyArray<unknown> => {
              const parsed: unknown = JSON.parse(body);
              return Array.isArray(parsed) ? (parsed as ReadonlyArray<unknown>) : [parsed];
            },
            catch: (cause) => new TransportError({ cause }),
          });
    return {
      items,
      nextOffset,
      cursor,
      upToDate,
      streamClosed,
      status: 200,
      etag,
      notModified: false,
    };
  });

/**
 * Open a raw byte-stream GET (used for SSE). Returns the response wrapped so
 * the caller can stream the body.
 */
export const getStream = (
  endpoint: Endpoint,
  opts: {
    readonly offset: Offset;
    readonly accept?: string;
    readonly callHeaders?: HeadersRecord;
  },
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  TransportError | NotFound | Gone,
  HttpClient.HttpClient
> =>
  withOnErrorHandler(endpoint, (ep) =>
    Effect.gen(function* () {
      const url = urlOf(ep);
      const extra = opts.accept ? { accept: opts.accept } : undefined;
      const res = yield* executeGet(
        ep,
        {
          [C.QUERY_OFFSET]: opts.offset,
          [C.QUERY_LIVE]: C.LIVE_SSE,
        },
        opts.callHeaders,
        extra,
      );
      const missing = missingStreamError(res.status, url);
      if (missing !== undefined) return yield* missing;
      if (res.status !== 200) {
        return yield* new TransportError({
          cause: new Error(`GET stream ${url}: status ${res.status}`),
        });
      }
      return res;
    }),
  );

export interface PostOptions {
  readonly body: string;
  readonly contentType?: string;
  readonly seq?: string;
  readonly producerId?: string;
  readonly producerEpoch?: number;
  readonly producerSeq?: number;
  readonly streamClosed?: boolean;
  readonly callHeaders?: HeadersRecord;
}

interface PostResponse {
  readonly status: number;
  readonly nextOffset: Offset;
  readonly streamClosed: boolean;
  readonly producerExpectedSeq: number | undefined;
  readonly producerReceivedSeq: number | undefined;
  readonly producerEpoch: number | undefined;
}

export const post = (
  endpoint: Endpoint,
  opts: PostOptions,
): Effect.Effect<PostResponse, TransportError, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, (ep) => postInner(ep, opts));

const postInner = (
  endpoint: Endpoint,
  opts: PostOptions,
): Effect.Effect<PostResponse, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    void urlOf; // kept for clarity in stack traces
    const extra: Record<string, string> = {};
    if (opts.seq !== undefined) extra[C.STREAM_SEQ] = opts.seq;
    if (opts.producerId !== undefined) extra[C.PRODUCER_ID] = opts.producerId;
    if (opts.producerEpoch !== undefined) extra[C.PRODUCER_EPOCH] = String(opts.producerEpoch);
    if (opts.producerSeq !== undefined) extra[C.PRODUCER_SEQ] = String(opts.producerSeq);
    if (opts.streamClosed) extra[C.STREAM_CLOSED] = "true";
    // Retry transport errors only. Protocol errors (4xx) are returned to the caller.
    const res = yield* executeWithRetry(
      endpoint,
      (u, h) =>
        HttpClientRequest.post(u).pipe(
          HttpClientRequest.setHeaders(h),
          HttpClientRequest.bodyText(opts.body, opts.contentType ?? C.CONTENT_TYPE_JSON),
        ),
      opts.callHeaders,
      extra,
    );
    const nextOffset = (headerValue(res, STREAM_NEXT_OFFSET) ?? "") as Offset;
    const streamClosed = isClosed(res);
    const expected = parseInt(headerValue(res, C.PRODUCER_EXPECTED_SEQ) ?? "", 10);
    const received = parseInt(headerValue(res, C.PRODUCER_RECEIVED_SEQ) ?? "", 10);
    const epoch = parseInt(headerValue(res, C.PRODUCER_EPOCH) ?? "", 10);
    return {
      status: res.status,
      nextOffset,
      streamClosed,
      producerExpectedSeq: Number.isFinite(expected) ? expected : undefined,
      producerReceivedSeq: Number.isFinite(received) ? received : undefined,
      producerEpoch: Number.isFinite(epoch) ? epoch : undefined,
    };
  });

export interface PutOptions {
  readonly contentType?: string;
  readonly ttlSeconds?: number;
  readonly expiresAt?: string;
  readonly closed?: boolean;
  readonly body?: string;
  readonly callHeaders?: HeadersRecord;
}

export const put = (
  endpoint: Endpoint,
  opts: PutOptions,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, (ep) => putInner(ep, opts));

const putInner = (
  endpoint: Endpoint,
  opts: PutOptions,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const extra: Record<string, string> = {};
    if (opts.ttlSeconds !== undefined) extra[C.STREAM_TTL] = String(opts.ttlSeconds);
    if (opts.expiresAt !== undefined) extra[C.STREAM_EXPIRES_AT] = opts.expiresAt;
    if (opts.closed) extra[C.STREAM_CLOSED] = "true";
    const ct = opts.contentType ?? C.CONTENT_TYPE_JSON;
    const res = yield* executeWithRetry(
      endpoint,
      (u, h) => {
        const base = HttpClientRequest.put(u).pipe(HttpClientRequest.setHeaders(h));
        return opts.body !== undefined
          ? HttpClientRequest.bodyText(opts.body, ct)(base)
          : HttpClientRequest.setHeader("content-type", ct)(base);
      },
      opts.callHeaders,
      extra,
    );
    return { status: res.status };
  });

export const del = (
  endpoint: Endpoint,
  callHeaders?: HeadersRecord,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  withOnErrorHandler(endpoint, (ep) => delInner(ep, callHeaders));

const delInner = (
  endpoint: Endpoint,
  callHeaders: HeadersRecord | undefined,
): Effect.Effect<{ readonly status: number }, TransportError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* executeWithRetry(
      endpoint,
      (u, h) => HttpClientRequest.delete(u).pipe(HttpClientRequest.setHeaders(h)),
      callHeaders,
    );
    return { status: res.status };
  });
