---
"effect-encore": patch
---

Export `ActorClientService` and `ActorClientFactory` types from both v3 and v4 entry points. These were internal-only, causing TS4023 errors when consumers exported `Actor.toLayer` results.
