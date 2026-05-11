import { describe, expect, it } from "effect-bun-test/v3";
import { Effect, Schema } from "effect";
import { Actor } from "../src/index.js";

const TupleKey = Schema.Tuple(Schema.String, Schema.String, Schema.String);

describe("Actor.entityIdCodec (v3)", () => {
  it.effect("round-trips arbitrary tuple components including the separator", () =>
    Effect.gen(function* () {
      const codec = Actor.entityIdCodec(TupleKey);
      const key = ["ws-1", "sess-2", "branch:3"] as const;
      const encoded = codec.encode(key);
      const decoded = yield* codec.decode(encoded);
      expect(decoded).toEqual(key);
    }),
  );

  it.effect("collision-safe: ids that differ only by separator placement do not alias", () =>
    Effect.gen(function* () {
      const codec = Actor.entityIdCodec(TupleKey);
      const a = codec.encode(["a:", "b", "c"]);
      const b = codec.encode(["a", ":b", "c"]);
      expect(a).not.toBe(b);
      const decodedA = yield* codec.decode(a);
      const decodedB = yield* codec.decode(b);
      expect(decodedA).toEqual(["a:", "b", "c"]);
      expect(decodedB).toEqual(["a", ":b", "c"]);
    }),
  );

  it.effect("decode fails with EntityIdDecodeError when a segment is malformed", () =>
    Effect.gen(function* () {
      const codec = Actor.entityIdCodec(TupleKey);
      const exit = yield* codec.decode("ws-1:%E0%A4:branch").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = String(exit.cause);
        expect(error).toContain("EntityIdDecodeError");
      }
    }),
  );

  it.effect("decode surfaces schema parse errors when shape disagrees", () =>
    Effect.gen(function* () {
      const TwoTuple = Schema.Tuple(Schema.String, Schema.String);
      const codec = Actor.entityIdCodec(TwoTuple);
      const exit = yield* codec.decode("a:b:c").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});
