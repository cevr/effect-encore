import { Effect, Schema } from "effect";

const SEPARATOR = ":";

export class EntityIdDecodeError extends Schema.Error<EntityIdDecodeError>(
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
      return encoded.map((part) => encodeURIComponent(String(part))).join(SEPARATOR);
    },
    decode: (entityId) =>
      Effect.flatMap(
        Effect.forEach(entityId.split(SEPARATOR), (part) =>
          Effect.try({
            try: () => decodeURIComponent(part),
            catch: () =>
              EntityIdDecodeError.make({
                entityId,
                reason: `segment "${part}" is not valid URI-encoded text`,
              }),
          }),
        ),
        decodeTuple,
      ),
  };
};
