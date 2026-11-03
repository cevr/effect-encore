import { BunCrypto } from "@effect/platform-bun";
import { expect, it, test } from "effect-bun-test";
import { Effect, Order, Schema } from "effect";
import { canonicalJsonSha256, canonicalJsonString } from "../src/index.js";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const legacyCanonicalJsonString = (input: Schema.Json): string => {
  if (Array.isArray(input)) return `[${input.map(legacyCanonicalJsonString).join(",")}]`;
  if (!Schema.is(Schema.JsonObject)(input)) return encodeJson(input);
  return `{${Object.entries(input)
    .sort(([left], [right]) => Order.String(left, right))
    .map(([key, entry]) => `${encodeJson(key)}:${legacyCanonicalJsonString(entry)}`)
    .join(",")}}`;
};

const value: Schema.Json = {
  z: -0,
  a: { "\uffff": 2, "😀": 1, a: 3 },
  list: [{ b: 2, a: 1 }],
};

test("encodes canonical JSON with stable recursive key order", () => {
  expect(canonicalJsonString(value)).toBe(
    '{"a":{"a":3,"😀":1,"￿":2},"list":[{"a":1,"b":2}],"z":0}',
  );
  expect(canonicalJsonString({ 2: 2, 10: 1 })).toBe('{"10":1,"2":2}');
  expect(canonicalJsonString({ a: 1, 0: 0 })).toBe('{"0":0,"a":1}');
  expect(canonicalJsonString({ 2: 2, 11: 11 })).toBe('{"11":11,"2":2}');
  expect(canonicalJsonString({ "01": 1, 1: 1 })).toBe('{"01":1,"1":1}');
});

test("matches the previous encoder for representative JSON values", () => {
  const protoKey = { z: 1 } satisfies Record<string, Schema.Json>;
  Object.defineProperty(protoKey, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { b: 2, a: 1 },
    writable: true,
  });
  /* oxlint-disable effect/noNullish -- JSON null is a required serializer input. */
  const fixtures: ReadonlyArray<Schema.Json> = [
    null,
    true,
    false,
    0,
    -0,
    1.25,
    1e100,
    'line\nquote"slash\\emoji😀\ud800',
    [3, { z: 1, a: 2 }, null],
    { 2: 2, 10: 1, a: { y: true, x: false } },
    protoKey,
  ];
  /* oxlint-enable effect/noNullish */

  for (const fixture of fixtures) {
    expect(canonicalJsonString(fixture)).toBe(legacyCanonicalJsonString(fixture));
  }
});

test("matches the previous encoder across key-order classes", () => {
  const keys = [
    "",
    "0",
    "00",
    "01",
    "1",
    "2",
    "10",
    "11",
    "4294967294",
    "4294967295",
    "__proto__",
    "a",
    "😀",
    "\uffff",
  ];

  for (const left of keys) {
    for (const right of keys) {
      if (left === right) continue;
      const fixture: Record<string, Schema.Json> = {};
      Object.defineProperty(fixture, left, {
        enumerable: true,
        value: { z: 1, a: 2 },
      });
      Object.defineProperty(fixture, right, {
        enumerable: true,
        value: [3, 2, 1],
      });
      const nested = { wrapper: [fixture] };
      expect(canonicalJsonString(nested)).toBe(legacyCanonicalJsonString(nested));
    }
  }
});

test("handles deeply nested JSON without quadratic string copying", () => {
  let nested: Schema.Json = 0;
  for (let depth = 0; depth < 4_000; depth++) nested = { value: nested };

  const encoded = canonicalJsonString(nested);
  expect(encoded.length).toBe(40_001);
  expect(encoded.startsWith('{"value":{"value":')).toBe(true);
  expect(encoded.endsWith("}}".repeat(2_000))).toBe(true);
});

test("rejects non-finite numbers", () => {
  expect(() => canonicalJsonString(Number.NaN)).toThrow();
  expect(() => canonicalJsonString(Number.POSITIVE_INFINITY)).toThrow();
});

test("reads each object value once", () => {
  let reads = 0;
  const valueWithAccessor = { 2: 2, 10: 1 } satisfies Record<string, Schema.Json>;
  Object.defineProperty(valueWithAccessor, "value", {
    enumerable: true,
    get: () => {
      reads++;
      return { z: 1, a: 2 };
    },
  });

  expect(canonicalJsonString(valueWithAccessor)).toBe('{"10":1,"2":2,"value":{"a":2,"z":1}}');
  expect(reads).toBe(1);
});

it.effect("computes the full SHA-256 digest of canonical JSON", () =>
  Effect.gen(function* () {
    const digest = yield* canonicalJsonSha256(value);
    expect(digest).toBe("df0702a4e9caa892ed9c1acde873be2251d4486b3a54be9bc38c1afae2ddd13d");
  }).pipe(Effect.provide(BunCrypto.layer)),
);
