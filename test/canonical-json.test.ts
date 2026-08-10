import { BunCrypto } from "@effect/platform-bun";
import { expect, it, test } from "effect-bun-test";
import { Effect, type Schema } from "effect";
import { canonicalJsonSha256, canonicalJsonString } from "../src/index.js";

const value: Schema.Json = {
  z: -0,
  // UTF-16 order puts the emoji surrogate before U+FFFF.
  a: { "\uffff": 2, "😀": 1, a: 3 },
  list: [{ b: 2, a: 1 }],
};

test("encodes canonical JSON with stable recursive key order", () => {
  expect(canonicalJsonString(value)).toBe(
    '{"a":{"a":3,"😀":1,"￿":2},"list":[{"a":1,"b":2}],"z":0}',
  );
  expect(canonicalJsonString({ 2: 2, 10: 1 })).toBe('{"10":1,"2":2}');
});

it.effect("computes the full SHA-256 digest of canonical JSON", () =>
  Effect.gen(function* () {
    const digest = yield* canonicalJsonSha256(value);
    expect(digest).toBe("df0702a4e9caa892ed9c1acde873be2251d4486b3a54be9bc38c1afae2ddd13d");
  }).pipe(Effect.provide(BunCrypto.layer)),
);
