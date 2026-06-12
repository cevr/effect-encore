import { Cause, Effect, Exit, Schema } from "effect";
import { DecodeError } from "../errors.ts";

/**
 * Build a chunk-decoder for a value schema. The returned function decodes an
 * array of raw values into a typed array; on the first decode failure it
 * surfaces a `DecodeError` rather than skipping items — strict by design.
 */
export const arrayDecoder = <A, I>(schema: Schema.Codec<A, I>) => {
  const decode = Schema.decodeUnknownExit(schema);
  return (raw: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<A>, DecodeError> => {
    const out: Array<A> = [];
    let index = 0;
    while (index < raw.length) {
      const item = raw[index];
      const r = decode(item);
      if (Exit.isFailure(r)) {
        return Effect.fail(new DecodeError({ cause: Cause.squash(r.cause), raw: item }));
      }
      out.push(r.value);
      index += 1;
    }
    return Effect.succeed(out);
  };
};

/**
 * One-shot decode of a single value through the schema's encoder. Used at the
 * write boundary; encode-side failures are programmer errors (die).
 */
export const encodeUnsafe = <A, I>(schema: Schema.Codec<A, I>) => Schema.encodeSync(schema);
