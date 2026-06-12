import type { Schema } from "effect";
import type { Bound, Endpoint } from "./DurableStream.ts";
import * as Reader from "./Reader.ts";
import * as Writer from "./Writer.ts";

interface DefineOptions<A, I> {
  readonly endpoint: Endpoint;
  readonly schema: Schema.Codec<A, I>;
}

export const define = <A, I>(opts: DefineOptions<A, I>): Bound<A, I> => {
  const { endpoint, schema } = opts;
  return {
    endpoint,
    schema,
    read: (readOpts) =>
      Reader.read({
        endpoint,
        schema,
        ...(readOpts?.live !== undefined ? { live: readOpts.live } : {}),
        ...(readOpts?.offset !== undefined ? { offset: readOpts.offset } : {}),
        ...(readOpts?.headers !== undefined ? { headers: readOpts.headers } : {}),
      }),
    collect: Reader.collect({ endpoint, schema }),
    snapshotThenFollow: Reader.snapshotThenFollow({ endpoint, schema }),
    tail: Reader.tail({ endpoint, schema }),
    append: (event, appendOpts) =>
      Writer.append({
        endpoint,
        schema,
        event,
        ...(appendOpts?.seq !== undefined ? { seq: appendOpts.seq } : {}),
        ...(appendOpts?.headers !== undefined ? { headers: appendOpts.headers } : {}),
      }),
    producer: (producerOpts) => Writer.producer({ endpoint, schema, ...producerOpts }),
    // `head` and `delete` stay as direct Effects (no per-call override
    // surface on `Bound`) to keep the established `yield* s.head` /
    // `yield* s.delete` ergonomics. Callers needing per-request headers
    // on those operations drop to the function form (`DurableStream.head
    // (endpoint, headers)` / `DurableStream.delete(endpoint, headers)`).
    head: Reader.head(endpoint),
    create: (createOpts) => Writer.create(endpoint, createOpts),
    close: (closeOpts) => Writer.close(endpoint, closeOpts),
    delete: Writer.del(endpoint),
  } satisfies Bound<A, I>;
};
