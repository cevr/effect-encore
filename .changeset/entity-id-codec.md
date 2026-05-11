---
"effect-encore": minor
---

`Actor.entityIdCodec(schema)`. Collision-safe codec for tuple-shaped entity ids. `Entity.toLayer` keys entities by a `string` `entityId`; when the natural key is a tuple like `(workspaceId, sessionId, branchId)`, a naive `${a}:${b}:${c}` join collides whenever a component contains `:`. The new codec encodes each component through `encodeURIComponent` before joining on `:`, so segments are unambiguous on decode, then validates the decoded tuple through the supplied schema.

```ts
const Key = Schema.Tuple(Schema.String, Schema.String, Schema.String);
const codec = Actor.entityIdCodec(Key);
codec.encode(["ws-1", "sess-2", "branch:3"]); // "ws-1:sess-2:branch%3A3"
yield * codec.decode("ws-1:sess-2:branch%3A3"); // ["ws-1", "sess-2", "branch:3"]
```

Decode failures surface as `EntityIdDecodeError` (segment is not valid URI-encoded text) or the schema's parse error (tuple shape disagrees).
