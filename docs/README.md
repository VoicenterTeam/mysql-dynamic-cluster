# mysql-dynamic-cluster — documentation (V3.0)

This directory documents the V3.0 line of `@voicenter-team/mysql-dynamic-cluster`.
Agents pick up context from [`../CLAUDE.md`](../CLAUDE.md) (added in Task 17);
this index is for humans browsing `docs/` directly.

## Start here

If you're new to the project, read in this order:
1. [glossary.md](glossary.md) — terms used everywhere (Galera, wsrep, validator, …)
2. [architecture.md](architecture.md) — system overview and lifecycle
3. [configuration.md](configuration.md) — how settings flow from env → convict → runtime
4. [subsystems/cluster.md](subsystems/cluster.md) — the orchestrator and query flow

## Foundation

- [architecture.md](architecture.md) — boot and runtime diagrams, singletons, and the connect/disconnect lifecycle.
- [configuration.md](configuration.md) — convict schema, env-var overlay, `Settings.mixSettings` merge order, and defaults.
- [events.md](events.md) — catalog of cluster and pool events, their payloads, and the array-wrapping listener quirk.
- [sql-assets.md](sql-assets.md) — hashing-database tables, routines, capacity caps, and SQL path resolution.
- [testing.md](testing.md) — Jest layout, why the current suite is stale on V3.0, and what still runs.
- [known-issues.md](known-issues.md) — catalogued footguns and bugs with file:line refs and suggested fixes (not applied).
- [branch-divergence.md](branch-divergence.md) — side-by-side of `dev` vs V3 API shapes and what stayed the same.
- [glossary.md](glossary.md) — short definitions of Galera, validator, load factor, hashing, AMQP, and pm2 metric terms.

## Subsystems

- [subsystems/cluster.md](subsystems/cluster.md) — `GaleraCluster` orchestration, pool selection, and query flow.
- [subsystems/pool.md](subsystems/pool.md) — `Pool` lifecycle, query callback chain, multi-statement txns, events.
- [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md) — `PoolStatus`, `Validator`, `LoadFactor`.
- [subsystems/cluster-hashing.md](subsystems/cluster-hashing.md) — service-to-node pinning, hashing DB, pool ordering.
- [subsystems/redis-cache.md](subsystems/redis-cache.md) — key derivation, payload TTL, stale-fallback, `clearOnStart`.
- [subsystems/metrics.md](subsystems/metrics.md) — pm2.io metric types, naming, two-write service scoping, adding.
- [subsystems/logger.md](subsystems/logger.md) — winston setup, console + AMQP outputs, `LOGLEVEL` / `LOGTYPES` enums.
