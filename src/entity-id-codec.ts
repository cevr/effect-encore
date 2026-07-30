/**
 * Collision-safe codec for tuple-shaped entity ids.
 *
 * `Entity.toLayer` keys entities by a `string` `entityId`. When the natural
 * key is a tuple (e.g. `(workspaceId, sessionId, branchId)`), a naive
 * `${a}:${b}:${c}` join collides whenever a component contains `:`:
 *
 *     encode("a:", "x")  === "a::x"
 *     encode("a", ":x")  === "a::x"   // collision
 *
 * `encodeURIComponent` encodes both `:` and `/`, leaving encoded components
 * free of separators. `entityIdCodec(schema)` validates the tuple shape via
 * the supplied schema, then encodes/decodes through that buffer.
 *
 * @example
 * const Key = Schema.Tuple(Schema.String, Schema.String, Schema.String);
 * const codec = Actor.entityIdCodec(Key);
 * codec.encode(["ws-1", "sess-2", "branch:3"]); // "ws-1:sess-2:branch%3A3"
 * yield* codec.decode("ws-1:sess-2:branch%3A3"); // ["ws-1", "sess-2", "branch:3"]
 */

import { Effect, Schema } from "effect";

const SEPARATOR = ":";

export class EntityIdDecodeError extends Schema.ErrorClass<EntityIdDecodeError>(
  "effect-encore/entity-id-codec/EntityIdDecodeError",
)({
  entityId: Schema.String,
  reason: Schema.String,
}) {}

export interface EntityIdCodec<A extends ReadonlyArray<unknown>> {
  readonly encode: (key: A) => string;
  readonly decode: (entityId: string) => Effect.Effect<A, EntityIdDecodeError | Schema.SchemaError>;
}

export const entityIdCodec = <A extends ReadonlyArray<unknown>, I extends ReadonlyArray<unknown>>(
  schema: Schema.Codec<A, I>,
): EntityIdCodec<A> => {
  const encodeTuple = Schema.encodeSync(schema);
  const decodeTuple = Schema.decodeUnknownEffect(schema);
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
            EntityIdDecodeError.make({
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
