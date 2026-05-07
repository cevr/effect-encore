---
"effect-encore": minor
---

Add SQL-backed Encore message storage helpers. `fromSqlClient()` and
`fromSqlClientWithShardingConfig()` now provide both upstream Effect Cluster
`MessageStorage` and Encore's `EncoreMessageStorage`, including surgical
`deleteEnvelope` support for entity rerun.
