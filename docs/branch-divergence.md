# Branch Divergence: V3.0 vs `dev`

V3.0 introduces a [convict](https://www.npmjs.com/package/convict)-driven schema
([src/configs/schema.ts:10](../src/configs/schema.ts#L10)) plus a
[winston](https://www.npmjs.com/package/winston)-based logger that routes log
records through an AMQP pool transport
([src/utils/Logger.ts:1-7](../src/utils/Logger.ts#L1-L7)). The `dev` branch
(documented by the in-repo [README.md](../README.md) — which still ships on V3
verbatim, see [known-issues.md §12](known-issues.md#12-readme-describes-dev-branch-api-not-v30))
exposes a flatter object that is passed directly into `createPoolCluster` with
no schema, no env-var overlay, and no convict validation. This page maps every
config concept that moved between the two branches so an agent reading dev-era
docs or examples can translate them to V3.0 quickly.

Sibling docs: [configuration.md](configuration.md), [architecture.md](architecture.md),
[known-issues.md](known-issues.md), [glossary.md](glossary.md).

## Differences

| Concept | `dev` (per README) | V3.0 |
|---|---|---|
| Global pool settings key | `globalPoolSettings` ([README.md:258](../README.md#L258)) | `defaultPoolSettings` ([schema.ts:11](../src/configs/schema.ts#L11)) |
| Log level | `logLevel: LOGLEVEL` enum (`QUIET`/`REGULAR`/`FULL`) ([README.md:392-402](../README.md#L392-L402)) | `logs.level`: one of `'info' \| 'error' \| 'debug' \| 'warn' \| 'silent'` ([schema.ts:200-205](../src/configs/schema.ts#L200-L205), [LoggerInterfaces.ts:3-9](../src/types/LoggerInterfaces.ts#L3-L9)) |
| Log destination | `useConsoleLogger`, `useAmqpLogger` booleans ([README.md:348-376](../README.md#L348-L376)) | `logs.output`: comma-separated string (`'console'`, `'console,amqp'`) ([schema.ts:206-211](../src/configs/schema.ts#L206-L211), [Logger.ts:20-39](../src/utils/Logger.ts#L20-L39)) |
| AMQP config | `amqpLoggerSettings.log_amqp[]` — array of `{connection, channel}` ([README.md:723-762](../README.md#L723-L762)) | `amqp_logs.{topic, connection_master, exchage, queue, bindings, prefetch}` — single flat block ([schema.ts:213-306](../src/configs/schema.ts#L213-L306)) |
| Redis config | flat `redisSettings: {keyPrefix, expire, …}` plus `useRedis` boolean ([README.md:288-294](../README.md#L288-L294), [README.md:636-704](../README.md#L636-L704)) | `redis: {enabled, keyPrefix, expire, …}` — `enabled` lives inside the block ([schema.ts:155-198](../src/configs/schema.ts#L155-L198)) |
| Redis client injection | `redis: <RedisInstance>` ([README.md:269-278](../README.md#L269-L278)) | `redisInstant: <RedisInstance>` — stripped from user settings before the convict load ([schema.ts:125-130](../src/configs/schema.ts#L125-L130), [index.ts:13-14](../index.ts#L13-L14)) |
| Config delivery | Object passed directly to `createPoolCluster` ([README.md:169-185](../README.md#L169-L185)) | Convict schema + env-var overlay + optional JSON files + user settings deepmerged on top ([configs/index.ts:7-25](../src/configs/index.ts#L7-L25), [Settings.ts:17-30](../src/utils/Settings.ts#L17-L30)) |
| AMQP transport | [`@voicenter-team/amqp-logger`](https://www.npmjs.com/package/@voicenter-team/amqp-logger) ([README.md:20](../README.md#L20)) | [`@voicenter-team/failover-amqp-pool`](https://www.npmjs.com/package/@voicenter-team/failover-amqp-pool) via a winston transport ([Logger.ts:2](../src/utils/Logger.ts#L2), [package.json:42](../package.json#L42)) |
| Logger | Custom console logger + custom AMQP logger | winston (`winston.createLogger` + `winston.transports.Console` + AMQP-pool transport) ([Logger.ts:25-54](../src/utils/Logger.ts#L25-L54), [package.json:48](../package.json#L48)) |
| `LOGLEVEL` import path | `src/types/AmqpInterfaces` (per dev — README does not pin it but the old enum sat alongside AMQP types) | `src/types/LoggerInterfaces` ([LoggerInterfaces.ts:3-9](../src/types/LoggerInterfaces.ts#L3-L9), re-exported from [index.ts:32](../index.ts#L32)) |
| Schema file | none — config is whatever the caller passes | declared in [src/configs/schema.ts](../src/configs/schema.ts), validated with `allowed: 'strict'` ([configs/index.ts:23-25](../src/configs/index.ts#L23-L25)) |

## What stayed the same

The Galera-side semantics did not move between branches: validators are still
`{key, operator, value}` triples ([schema.ts:42-50](../src/configs/schema.ts#L42-L50),
[README.md:457-463](../README.md#L457-L463)), load factors are still
`{key, multiplier}` pairs ([schema.ts:51-58](../src/configs/schema.ts#L51-L58),
[README.md:477-482](../README.md#L477-L482)), and pool selection remains
filter-then-sort by pool status then pool score
([architecture.md](architecture.md), [README.md:9-13](../README.md#L9-L13)). The
cluster-hashing model (service → node pin in a backing MySQL table) and the SQL
asset layout under `assets/` are identical between branches — see
[sql-assets.md](sql-assets.md). The public API surface that consumers actually
touch — `createPoolCluster`, `cluster.connect`, `cluster.disconnect`,
`cluster.on`, `cluster.query` — is unchanged in name and signature
([index.ts:11-18](../index.ts#L11-L18), [README.md:168-220](../README.md#L168-L220));
only the shape of the config object passed to the factory differs.

## Migration note (dev examples → V3.0)

When you read a dev-era example and see `user`, `password`, `database`,
`validators`, `loadFactors`, `port`, `connectionLimit`, `queryTimeout`,
`slowQueryTime`, `timerCheckRange`, `timerCheckMultiplier`, or `redisFactor` at
the **top level** of the config object (or under `globalPoolSettings`), those
keys belong under `defaultPoolSettings` on V3.0. Pasting a dev-style config into
`createPoolCluster()` without nesting will fail convict's strict validation
([configs/index.ts:23-25](../src/configs/index.ts#L23-L25)) at boot. Likewise:

- `logLevel: LOGLEVEL.FULL` → `logs: { level: 'debug' }` (note the enum value space is different — V3 uses winston levels, not `QUIET`/`REGULAR`/`FULL`).
- `useConsoleLogger: true, useAmqpLogger: true` → `logs: { output: 'console,amqp' }`.
- `useRedis: true, redisSettings: { … }` → `redis: { enabled: true, … }`.
- `redis: redisClient` (the ioredis instance) → `redisInstant: redisClient`.
- `amqpLoggerSettings.log_amqp[0].connection` → `amqp_logs.connection_master`; the per-array `channel` block flattens into `amqp_logs.{exchage, queue, bindings, prefetch}` plus a top-level `amqp_logs.topic`.

For a key-by-key V3 reference (including env-var names and the
`redisInstant` strip seam), see [configuration.md](configuration.md).
