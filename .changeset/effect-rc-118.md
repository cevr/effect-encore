---
"effect-encore": minor
---

Support Effect 4.0.0-rc.118, which removed the `effect/unstable/*` entry points and the root `Encoding` module. The package now imports `effect/cluster`, `effect/rpc`, `effect/workflow`, `effect/sql` and `effect/http`, and hex-encodes digests with `Hex` from `effect/encoding`. Opaque payload schemas define their `make` override as an own property, since rc.118 schemas inherit `make` as a getter.

The `effect` peer range is now `>=4.0.0-rc.118 <5`: earlier releases do not have the new entry points.
