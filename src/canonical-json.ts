import { Crypto, Effect, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const textEncoder = new TextEncoder();
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

type JsonPrimitive = Exclude<Schema.Json, Schema.JsonArray | Schema.JsonObject>;

const encodeJsonPrimitive = (value: JsonPrimitive): string => {
  if (Predicate.isNull(value)) return "null";
  if (Predicate.isBoolean(value)) {
    if (value) return "true";
    return "false";
  }
  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) return encodeJson(value);
    return String(value);
  }
  // oxlint-disable-next-line effect/noGlobals -- JSON string escaping is the canonical wire format. Schema validation already established the string member.
  const encoded = JSON.stringify(value);
  if (!Predicate.isString(encoded)) return encodeJson(value);
  return encoded;
};

const jsonObjectEntry = (value: Schema.JsonObject, key: string): Schema.Json => {
  const entry = value[key];
  if (Predicate.isUndefined(entry)) return decodeJson(entry);
  return entry;
};

const canonicalJsonStringExact = (value: Schema.Json): string => {
  if (isJsonArray(value)) {
    let output = "[";
    let first = true;
    for (const entry of value) {
      if (first) first = false;
      else output += ",";
      output += canonicalJsonStringExact(entry);
    }
    return `${output}]`;
  }
  if (!isJsonObject(value)) return encodeJsonPrimitive(value);

  let output = "{";
  const keys = Object.keys(value).sort();
  let first = true;
  for (const key of keys) {
    if (first) first = false;
    else output += ",";
    output += `${encodeJsonPrimitive(key)}:${canonicalJsonStringExact(jsonObjectEntry(value, key))}`;
  }
  return `${output}}`;
};

const isArrayIndexKey = (key: string): boolean => {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
};

const hasNativeKeyOrderConflict = (value: Schema.JsonObject): boolean => {
  const keys = Object.keys(value).sort();
  let previousIndex = -1;
  let foundNonIndex = false;
  for (const key of keys) {
    if (!isArrayIndexKey(key)) {
      foundNonIndex = true;
      continue;
    }
    if (foundNonIndex) return true;
    const index = Number(key);
    if (index < previousIndex) return true;
    previousIndex = index;
  }
  return false;
};

interface JsonOrderingState {
  exactEncodingRequired: boolean;
}

const orderJsonObject = (value: Schema.Json, state: JsonOrderingState): Schema.Json => {
  if (isJsonArray(value)) return value.map((entry) => orderJsonObject(entry, state));
  if (!isJsonObject(value)) {
    if (Predicate.isNumber(value) && !Number.isFinite(value)) encodeJson(value);
    return value;
  }

  const ordered: Record<string, Schema.Json> = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    const orderedEntry = orderJsonObject(jsonObjectEntry(value, key), state);
    if (key === "__proto__") {
      Object.defineProperty(ordered, key, {
        configurable: true,
        enumerable: true,
        value: orderedEntry,
        writable: true,
      });
    } else {
      ordered[key] = orderedEntry;
    }
  }
  if (!state.exactEncodingRequired) {
    const runtimeKeys = Object.keys(ordered);
    for (const [index, canonicalKey] of keys.entries()) {
      if (runtimeKeys[index] !== canonicalKey) {
        state.exactEncodingRequired = true;
        break;
      }
    }
  }
  return ordered;
};

/** Encodes JSON with recursive UTF-16 object-key ordering. */
export const canonicalJsonString = (value: Schema.Json): string => {
  if (isJsonObject(value) && hasNativeKeyOrderConflict(value)) {
    return canonicalJsonStringExact(value);
  }
  const state: JsonOrderingState = { exactEncodingRequired: false };
  const ordered = orderJsonObject(value, state);
  if (state.exactEncodingRequired) return canonicalJsonStringExact(ordered);
  // oxlint-disable-next-line effect/noGlobals -- This serializer first establishes canonical object order. Native encoding avoids quadratic recursive string copies.
  const encoded = JSON.stringify(ordered);
  if (!Predicate.isString(encoded)) return encodeJson(value);
  return encoded;
};

/** Computes the full lowercase SHA-256 digest of canonical JSON. */
export const canonicalJsonSha256 = Effect.fn("effect-encore/canonicalJsonSha256")(function* (
  value: Schema.Json,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", textEncoder.encode(canonicalJsonString(value)));
  return Hex.encode(digest);
});
