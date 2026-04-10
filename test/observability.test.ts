import { describe, expect, test } from "effect-bun-test";
import { Observability } from "../src/index.js";

describe("observability", () => {
  test("defaultSpanAttributes returns actor metadata", () => {
    const attrs = Observability.defaultSpanAttributes("MyActor");
    expect(attrs["actor.name"]).toBe("MyActor");
    expect(attrs["actor.library"]).toBe("effect-encore");
  });

  test("re-exports CurrentAddress for custom middleware users", () => {
    expect(Observability.CurrentAddress).toBeDefined();
  });
});
