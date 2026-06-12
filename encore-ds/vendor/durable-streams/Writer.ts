import { type HttpClient } from "effect/unstable/http";
import { Effect, type Scope } from "effect";
import type {
  AppendOpts,
  CloseOptions,
  CreateOptions,
  Endpoint,
  HeadersRecord,
  Offset,
  Producer as ProducerType,
  ProducerAppendOpts,
  ProducerAppendResult,
  ProducerMakeOpts,
} from "./DurableStream.ts";
import {
  Conflict,
  NotFound,
  SequenceGap,
  StaleEpoch,
  StreamClosed,
  TransportError,
} from "./errors.ts";
import type { ProducerError, WriteError } from "./errors.ts";
import { encodeUnsafe } from "./internal/schema.ts";
import * as Http from "./protocol/Http.ts";
import * as ProducerImpl from "./protocol/Producer.ts";

const encodeSingleJson = <A, I>(schema: AppendOpts<A, I>["schema"], event: A): string =>
  JSON.stringify([encodeUnsafe(schema)(event)]);

const failIfClosed = (res: {
  readonly streamClosed: boolean;
  readonly nextOffset: Offset;
}): Effect.Effect<void, StreamClosed> =>
  res.streamClosed ? Effect.fail(new StreamClosed({ finalOffset: res.nextOffset })) : Effect.void;

const failMissingOrTransport = (
  endpoint: Endpoint,
  status: number,
): Effect.Effect<never, WriteError> => {
  const missing = Http.missingStreamError(status, String(endpoint.url));
  return missing !== undefined
    ? Effect.fail(missing)
    : Effect.fail(new TransportError({ cause: new Error(`POST returned status ${status}`) }));
};

interface AppendRawOptions {
  /** Pre-encoded request body sent verbatim. */
  readonly body: string;
  /** Overrides the default `application/json` content type. */
  readonly contentType?: string;
  readonly seq?: string;
  readonly headers?: HeadersRecord;
}

// Optional `PostOptions` header fields, attached only when present. Shared by
// `appendRaw` and `close` so both build the request the same way.
const postHeaderFields = (o: {
  readonly contentType?: string;
  readonly seq?: string;
  readonly headers?: HeadersRecord;
}): Partial<Http.PostOptions> => ({
  ...(o.contentType !== undefined ? { contentType: o.contentType } : {}),
  ...(o.seq !== undefined ? { seq: o.seq } : {}),
  ...(o.headers !== undefined ? { callHeaders: o.headers } : {}),
});

/**
 * Raw one-shot append: POSTs `body` verbatim (no schema encode) and maps the
 * response to the typed `WriteError` channel. Shared by the schema-encoded
 * {@link append} and the URL-keyed client facade, so both go through the
 * SAME protocol + error classification — no parallel transport.
 */
export const appendRaw = (
  endpoint: Endpoint,
  opts: AppendRawOptions,
): Effect.Effect<{ readonly offset: Offset }, WriteError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const postOpts: Http.PostOptions = { body: opts.body, ...postHeaderFields(opts) };
    const res = yield* Http.post(endpoint, postOpts);
    if (res.status === 200 || res.status === 204) {
      yield* failIfClosed(res);
      return { offset: res.nextOffset };
    }
    if (res.status === 409) {
      yield* failIfClosed(res);
      return yield* new Conflict({ reason: "409 Conflict on append" });
    }
    return yield* failMissingOrTransport(endpoint, res.status);
  });

/** One-shot append. Encodes via schema, POSTs as a single-element JSON array. */
export const append = <A, I>(
  opts: AppendOpts<A, I>,
): Effect.Effect<{ readonly offset: Offset }, WriteError, HttpClient.HttpClient> =>
  appendRaw(opts.endpoint, {
    body: encodeSingleJson(opts.schema, opts.event),
    ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
  });

export const appendWithProducer = <A, I>(
  opts: ProducerAppendOpts<A, I>,
): Effect.Effect<ProducerAppendResult, WriteError | ProducerError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* Http.post(opts.endpoint, {
      body: encodeSingleJson(opts.schema, opts.event),
      producerId: opts.producerId,
      producerEpoch: opts.producerEpoch,
      producerSeq: opts.producerSeq,
      ...(opts.headers !== undefined ? { callHeaders: opts.headers } : {}),
    });
    if (res.status === 200 || res.status === 204) {
      yield* failIfClosed(res);
      return res.status === 200
        ? { _tag: "Appended", offset: res.nextOffset }
        : { _tag: "Duplicate", offset: res.nextOffset };
    }
    if (res.status === 403) {
      return yield* new StaleEpoch({ currentEpoch: res.producerEpoch ?? opts.producerEpoch });
    }
    if (res.status === 409) {
      yield* failIfClosed(res);
      return yield* new SequenceGap({
        expectedSeq: res.producerExpectedSeq ?? -1,
        receivedSeq: res.producerReceivedSeq ?? opts.producerSeq,
      });
    }
    if (res.status === 400) {
      return yield* new Conflict({
        reason: `400 Bad Request from producer epoch=${opts.producerEpoch} seq=${opts.producerSeq}`,
      });
    }
    return yield* failMissingOrTransport(opts.endpoint, res.status);
  });

export const producer = <A, I>(
  opts: ProducerMakeOpts<A, I>,
): Effect.Effect<ProducerType<A>, TransportError, HttpClient.HttpClient | Scope.Scope> =>
  ProducerImpl.make(opts);

// ============================================================================
// Stream lifecycle: create / close / delete
// ============================================================================

export const create = (
  endpoint: Endpoint,
  opts: CreateOptions = {},
): Effect.Effect<void, TransportError | Conflict, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const putOpts: Http.PutOptions = {
      ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.closed !== undefined ? { closed: opts.closed } : {}),
      ...(opts.body !== undefined
        ? { body: typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body) }
        : {}),
      ...(opts.headers !== undefined ? { callHeaders: opts.headers } : {}),
    };
    const res = yield* Http.put(endpoint, putOpts);
    if (res.status === 200 || res.status === 201) return;
    if (res.status === 409) {
      return yield* new Conflict({ reason: "Stream exists with different config" });
    }
    return yield* new TransportError({ cause: new Error(`PUT returned status ${res.status}`) });
  });

export const close = (
  endpoint: Endpoint,
  opts: CloseOptions = {},
): Effect.Effect<{ readonly finalOffset: Offset }, WriteError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const postOpts: Http.PostOptions = {
      body:
        opts.body !== undefined
          ? typeof opts.body === "string"
            ? opts.body
            : new TextDecoder().decode(opts.body)
          : "",
      streamClosed: true,
      ...postHeaderFields({
        ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      }),
    };
    const res = yield* Http.post(endpoint, postOpts);
    if (res.status === 200 || res.status === 204) {
      return { finalOffset: res.nextOffset };
    }
    if (res.status === 404) {
      return yield* new NotFound({ url: String(endpoint.url) });
    }
    return yield* new TransportError({ cause: new Error(`Close returned status ${res.status}`) });
  });

export const del = (
  endpoint: Endpoint,
  callHeaders?: HeadersRecord,
): Effect.Effect<void, TransportError | NotFound, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* Http.del(endpoint, callHeaders);
    if (res.status === 200 || res.status === 204) return;
    if (res.status === 404) return yield* new NotFound({ url: String(endpoint.url) });
    return yield* new TransportError({ cause: new Error(`DELETE returned status ${res.status}`) });
  });
