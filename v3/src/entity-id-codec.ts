/**
 * Collision-safe codec for tuple-shaped entity ids. v3 mirror.
 */

import { Data, Effect, Schema } from "effect";
import type { ParseResult } from "effect";

const SEPARATOR = ":";

export class EntityIdDecodeError extends Data.TaggedError(
  "effect-encore/entity-id-codec/EntityIdDecodeError",
)<{
  readonly entityId: string;
  readonly reason: string;
}> {}

export interface EntityIdCodec<A extends ReadonlyArray<unknown>> {
  readonly encode: (key: A) => string;
  readonly decode: (
    entityId: string,
  ) => Effect.Effect<A, EntityIdDecodeError | ParseResult.ParseError>;
}

export const entityIdCodec = <A extends ReadonlyArray<unknown>, I extends ReadonlyArray<unknown>>(
  schema: Schema.Schema<A, I>,
): EntityIdCodec<A> => {
  const encodeTuple = Schema.encodeSync(schema);
  const decodeTuple = Schema.decodeUnknown(schema);
  return {
    encode: (key) => {
      const encoded = encodeTuple(key);
      return (encoded as ReadonlyArray<unknown>)
        .map((part) => encodeURIComponent(String(part)))
        .join(SEPARATOR);
    },
    decode: (entityId) => {
      const parts = entityId.split(SEPARATOR);
      const decoded: Array<string> = [];
      for (const part of parts) {
        try {
          decoded.push(decodeURIComponent(part));
        } catch {
          return Effect.fail(
            new EntityIdDecodeError({
              entityId,
              reason: `segment "${part}" is not valid URI-encoded text`,
            }),
          );
        }
      }
      return decodeTuple(decoded);
    },
  };
};
