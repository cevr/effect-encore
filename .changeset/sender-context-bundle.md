---
"effect-encore": minor
---

Export `SenderContext` type alias bundling the three producer-side cluster requirements (`MessageStorage | ActorAddressResolver | Sharding`). Use it in `R` channels for ops that send messages to actors instead of re-listing the union at every signature.
