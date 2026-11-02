---
"effect-encore": minor
---

Requires Effect 4.1. The `effect` peer range is now `>=4.1.0 <5`: Effect 4.1.0 removed `effect/Crypto`, which 0.33 imported, so 0.33 fails to load on Effect 4.1 and 0.34 cannot load on Effect 4.0.

- `canonicalJsonSha256`, `fromSqlClient` and `fromSqlClientWithShardingConfig` now require `Digest.Digest` from `effect/crypto` instead of `Crypto.Crypto`. Provide it with `BunCrypto.layer` or `NodeCrypto.layer` from your platform package, or `Digest.layerWebCrypto`. The digests are unchanged, so stored identities stay valid.
- Entity handlers receive an `operation` that keeps the payload's prototype, so a `Schema.Class` payload's methods work inside the handler, as `Operation.make` values already did. Before, the handler got a plain copy, and calling a payload method threw.
