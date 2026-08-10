import { Crypto, Effect, Encoding, Order, Schema } from "effect";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const textEncoder = new TextEncoder();
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

/** Encodes JSON with recursive UTF-16 object-key ordering. */
export const canonicalJsonString = (value: Schema.Json): string => {
  if (isJsonArray(value)) return `[${value.map(canonicalJsonString).join(",")}]`;
  if (value === null || typeof value !== "object") return encodeJson(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => Order.String(left, right))
    .map(([key, entry]) => `${encodeJson(key)}:${canonicalJsonString(entry)}`)
    .join(",")}}`;
};

/** Computes the full lowercase SHA-256 digest of canonical JSON. */
export const canonicalJsonSha256 = Effect.fn("effect-encore/canonicalJsonSha256")(function* (
  value: Schema.Json,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", textEncoder.encode(canonicalJsonString(value)));
  return Encoding.encodeHex(digest);
});
