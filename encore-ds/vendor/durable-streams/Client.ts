/**
 * URL-keyed client facade — an ergonomic, optional-schema surface inspired by
 * `@durable-streams/client-effect` (durable-streams PR #218), implemented as a
 * thin delegation over the typed core (`Reader` / `Writer` / `protocol`). It
 * adds NO transport of its own:
 *
 *   - `DurableStreamClient` is a `Context.Tag` service; provide one layer
 *     (`layerFetch` is batteries-included) and call `client.<op>(url, …)`
 *     with no `HttpClient` left in `R` (the producer keeps `Scope`).
 *   - Raw ops (`append(url, string | Uint8Array)`, `stream(url)`) skip Schema
 *     for quick, untyped use; `withSchema(schema)` returns the fully typed
 *     `Stream<A>` / `Sink<A>` surface over the same core.
 *
 * Deliberately NOT copied from upstream: global-`fetch` hardwire (we stay on a
 * pluggable `@effect/platform` `HttpClient`), the untyped `Error` producer
 * channel (ours stays `ProducerFailure`), and the dead follow loop (our reads
 * actually follow — see `protocol/Read.ts`).
 */
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { Context, Effect, Layer, Schema, Stream, type Scope } from "effect";
import type {
  CloseOptions,
  CreateOptions,
  Endpoint,
  HeadersRecord,
  HeadResult,
  LiveMode,
  Offset,
  Producer,
  ProducerOptions,
  ReadError,
  SnapshotResult,
  WriteError,
} from "./DurableStream.ts";
import type { Conflict, Gone, NotFound, TransportError } from "./errors.ts";
import { batchStream, type RawBatch } from "./protocol/Read.ts";
import * as Reader from "./Reader.ts";
import * as Writer from "./Writer.ts";

export type { RawBatch } from "./protocol/Read.ts";

type Url = string | URL;

// Optional field: attach `{ [k]: v }` only when `v` is defined (so we don't
// pass `undefined` under `exactOptionalPropertyTypes`).
const opt = <K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> =>
  v === undefined ? {} : ({ [k]: v } as Record<K, V>);

const endpointOf = (url: Url, headers?: HeadersRecord): Endpoint => ({
  url,
  ...opt("headers", headers),
});

const bodyOf = (data: string | Uint8Array): string =>
  typeof data === "string" ? data : new TextDecoder().decode(data);

// === Public option / result shapes ================================

export interface RawAppendOptions {
  readonly seq?: string;
  readonly contentType?: string;
  readonly headers?: HeadersRecord;
}

export interface RawStreamOptions {
  readonly live?: LiveMode;
  readonly offset?: Offset;
  readonly headers?: HeadersRecord;
}

/**
 * A lazy read session over un-decoded payloads. No request is made until a
 * consumer runs one of these. There is no `cancel()` — interrupt the consuming
 * fiber (idiomatic Effect). `body()` / `text()` are intentionally absent: the
 * protocol is a JSON-array wire, so a single raw "body" across multiple
 * batches is ill-defined; use {@link RawStreamSession.json} for items.
 */
export interface RawStreamSession {
  /** Accumulate all items (catch-up to up-to-date), un-decoded. */
  readonly json: Effect.Effect<ReadonlyArray<unknown>, ReadError>;
  /** Stream individual items, following live per the session's `live` mode. */
  readonly jsonStream: Stream.Stream<unknown, ReadError>;
  /** Stream per-response batches with `{ offset, upToDate, cursor }` metadata. */
  readonly jsonBatches: Stream.Stream<RawBatch, ReadError>;
}

/** Typed, URL-keyed surface returned by {@link DurableStreamClientService.withSchema}. */
export interface TypedClient<A> {
  readonly append: (
    url: Url,
    event: A,
    opts?: { readonly seq?: string; readonly headers?: HeadersRecord },
  ) => Effect.Effect<{ readonly offset: Offset }, WriteError>;
  readonly read: (
    url: Url,
    opts?: { readonly live?: LiveMode; readonly offset?: Offset; readonly headers?: HeadersRecord },
  ) => Stream.Stream<A, ReadError>;
  readonly collect: (
    url: Url,
    headers?: HeadersRecord,
  ) => Effect.Effect<ReadonlyArray<A>, ReadError>;
  readonly snapshotThenFollow: (
    url: Url,
    headers?: HeadersRecord,
  ) => Effect.Effect<SnapshotResult<A>, ReadError>;
  readonly tail: (
    url: Url,
    headers?: HeadersRecord,
  ) => Effect.Effect<Stream.Stream<A, ReadError>, TransportError | NotFound | Gone>;
  readonly producer: (
    url: Url,
    opts: ProducerOptions,
    headers?: HeadersRecord,
  ) => Effect.Effect<Producer<A>, TransportError, Scope.Scope>;
}

export interface DurableStreamClientService {
  readonly create: (
    url: Url,
    opts?: CreateOptions,
  ) => Effect.Effect<void, TransportError | Conflict>;
  readonly head: (
    url: Url,
    headers?: HeadersRecord,
  ) => Effect.Effect<HeadResult, TransportError | NotFound | Gone>;
  readonly delete: (
    url: Url,
    headers?: HeadersRecord,
  ) => Effect.Effect<void, TransportError | NotFound>;
  readonly close: (
    url: Url,
    opts?: CloseOptions,
  ) => Effect.Effect<{ readonly finalOffset: Offset }, WriteError>;
  /** Raw append — body sent verbatim, no schema. Defaults to JSON content type. */
  readonly append: (
    url: Url,
    data: string | Uint8Array,
    opts?: RawAppendOptions,
  ) => Effect.Effect<{ readonly offset: Offset }, WriteError>;
  /** Open a lazy raw read session. */
  readonly stream: (url: Url, opts?: RawStreamOptions) => RawStreamSession;
  /** Bind a Schema to get the fully typed `Stream<A>` / `Sink<A>` surface. */
  readonly withSchema: <A, I>(schema: Schema.Codec<A, I>) => TypedClient<A>;
}

// === Implementation (delegates to the typed core) =================

const Unknown = Schema.Unknown;

const make = (httpClient: HttpClient.HttpClient): DurableStreamClientService => {
  const provide = <X, E>(eff: Effect.Effect<X, E, HttpClient.HttpClient>): Effect.Effect<X, E> =>
    Effect.provideService(eff, HttpClient.HttpClient, httpClient);
  const provideStream = <X, E>(
    s: Stream.Stream<X, E, HttpClient.HttpClient>,
  ): Stream.Stream<X, E> => Stream.provideService(s, HttpClient.HttpClient, httpClient);
  // Producer keeps `Scope` in `R` — caller scopes its lifetime.
  const provideScoped = <X, E>(
    eff: Effect.Effect<X, E, HttpClient.HttpClient | Scope.Scope>,
  ): Effect.Effect<X, E, Scope.Scope> =>
    Effect.provideService(eff, HttpClient.HttpClient, httpClient);

  const withSchema = <A, I>(schema: Schema.Codec<A, I>): TypedClient<A> => ({
    append: (url, event, opts) =>
      provide(
        Writer.append({
          endpoint: endpointOf(url, opts?.headers),
          schema,
          event,
          ...opt("seq", opts?.seq),
          ...opt("headers", opts?.headers),
        }),
      ),
    read: (url, opts) =>
      provideStream(
        Reader.read({
          endpoint: endpointOf(url, opts?.headers),
          schema,
          ...opt("live", opts?.live),
          ...opt("offset", opts?.offset),
          ...opt("headers", opts?.headers),
        }),
      ),
    collect: (url, headers) =>
      provide(
        Reader.collect({
          endpoint: endpointOf(url, headers),
          schema,
          ...opt("headers", headers),
        }),
      ),
    snapshotThenFollow: (url, headers) =>
      provide(
        Reader.snapshotThenFollow({
          endpoint: endpointOf(url, headers),
          schema,
          ...opt("headers", headers),
        }),
      ).pipe(Effect.map((res) => ({ snapshot: res.snapshot, live: provideStream(res.live) }))),
    tail: (url, headers) =>
      provide(
        Reader.tail({
          endpoint: endpointOf(url, headers),
          schema,
          ...opt("headers", headers),
        }),
      ).pipe(Effect.map(provideStream)),
    producer: (url, opts, headers) =>
      provideScoped(Writer.producer({ endpoint: endpointOf(url, headers), schema, ...opts })),
  });

  return {
    create: (url, opts) => provide(Writer.create(endpointOf(url), opts)),
    head: (url, headers) => provide(Reader.head(endpointOf(url), headers)),
    delete: (url, headers) => provide(Writer.del(endpointOf(url), headers)),
    close: (url, opts) => provide(Writer.close(endpointOf(url), opts)),
    append: (url, data, opts) =>
      provide(
        Writer.appendRaw(endpointOf(url, opts?.headers), {
          body: bodyOf(data),
          ...opt("contentType", opts?.contentType),
          ...opt("seq", opts?.seq),
          ...opt("headers", opts?.headers),
        }),
      ),
    stream: (url, opts) => {
      const endpoint = endpointOf(url, opts?.headers);
      return {
        json: provide(
          Reader.collect({
            endpoint,
            schema: Unknown,
            ...opt("headers", opts?.headers),
          }),
        ),
        jsonStream: provideStream(
          Reader.read({
            endpoint,
            schema: Unknown,
            live: opts?.live ?? true,
            ...opt("offset", opts?.offset),
            ...opt("headers", opts?.headers),
          }),
        ),
        jsonBatches: provideStream(
          batchStream(endpoint, {
            live: opts?.live ?? true,
            ...opt("offset", opts?.offset),
            ...opt("headers", opts?.headers),
          }),
        ),
      };
    },
    withSchema,
  };
};

// === Service tag + layers =========================================

export class DurableStreamClient extends Context.Service<
  DurableStreamClient,
  DurableStreamClientService
>()("effect-durable-streams/DurableStreamClient") {}

/** Service over a caller-provided `HttpClient` layer. */
export const layer: Layer.Layer<DurableStreamClient, never, HttpClient.HttpClient> = Layer.effect(
  DurableStreamClient,
  Effect.map(HttpClient.HttpClient, make),
);

/**
 * Batteries-included: bundles `FetchHttpClient` (global `fetch`; works on
 * Node 18+, Bun, Deno, browsers). Analogous to upstream's
 * `DurableStreamClientLiveNode()`, but the underlying transport stays a
 * standard, swappable `@effect/platform` `HttpClient` — pass `layer` +
 * your own client layer to substitute it.
 */
export const layerFetch: Layer.Layer<DurableStreamClient> = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
);
