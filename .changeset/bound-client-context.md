---
"effect-encore": patch
---

Bind actor client refs to the layer-build context so `ActorRef.execute` and
`ActorRef.send` do not depend on the caller recreating cluster runtime services.
