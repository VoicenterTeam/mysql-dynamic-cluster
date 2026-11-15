# Branch Divergence: V3.0 vs `dev`

V3.0 introduces a settings schema
([src/configs/schema.ts](../src/configs/schema.ts)) that validates the object
passed to `createPoolCluster`, plus a small logger class
([src/utils/Logger.ts](../src/utils/Logger.ts)). The `dev` branch
(documented by the in-repo [README.md](../README.md) — which still ships on V3
verbatim, see [known-issues.md §12](known-issues.md#12-readme-describes-dev-branch-api-not-v30))
exposes a flatter object that is passed directly into `createPoolCluster` with
no schema and no validation. This page maps every
config concept that moved between the two branches so an agent reading dev-era
docs or examples can translate them to V3.0 quickly.

Note on 4.0.0: this release changed three things on the V3 line. Config is a
zod schema and the library reads no environment variable
([configuration.md](configuration.md)). Logging goes to the console or to a
`logger` object the app passes in ([subsystems/logger.md](subsystems/logger.md)).
Metrics go through the OpenTelemetry API
([subsystems/metrics.md](subsystems/metrics.md)). The V3.0 column below
describes 4.0.0.

Sibling docs: [configuration.md](configuration.md), [architecture.md](architecture.md),
[known-issues.md](known-issues.md), [glossary.md](glossary.md).

## Differences

| Concept | `dev` (per README) | V3.0 |
|---|---|---|
| Global pool settings key | `globalPoolSettings` ([README.md:258](../README.md)) | `defaultPoolSettings` ([schema.ts:11](../src/configs/schema.ts#L11)) |
| Log level | `logLevel: LOGLEVEL` enum (`QUIET`/`REGULAR`/`FULL`) ([README.md:392-402](../README.md)) | `logs.level`: one of `'info' \| 'error' \| 'debug' \| 'warn' \| 'silent'` ([schema.ts](../src/configs/schema.ts), [LoggerInterfaces.ts:3-9](../src/types/LoggerInterfaces.ts#L3-L9)) |
| Log destination | `useConsoleLogger`, `useAmqpLogger` booleans ([README.md:348-376](../README.md)) | No setting. Logs go to the console, or to the `logger` object the app passes in the settings ([Logger.ts](../src/utils/Logger.ts), [subsystems/logger.md](subsystems/logger.md)) |
| AMQP config | `amqpLoggerSettings.log_amqp[]` — array of `{connection, channel}` ([README.md:723-762](../README.md)) | None. The library has no AMQP settings; the schema rejects `amqp_logs` |
| Redis config | flat `redisSettings: {keyPrefix, expire, …}` plus `useRedis` boolean ([README.md:288-294](../README.md), [README.md:636-704](../README.md)) | `redis: {enabled, keyPrefix, expire, …}` — `enabled` lives inside the block; `redisSettings` is rejected ([schema.ts](../src/configs/schema.ts)) |
| Redis client injection | `redis: <RedisInstance>` ([README.md:269-278](../README.md)) | `redisInstant: <RedisInstance>` — stripped from user settings before validation ([index.ts:13](../index.ts#L13)) |
| Config delivery | Object passed directly to `createPoolCluster` ([README.md:169-185](../README.md)) | Object passed to `createPoolCluster`, validated by a strict zod schema that fills in the defaults; each host is then deep-merged with `defaultPoolSettings`. No environment variables, no `.env`, no config files ([schema.ts](../src/configs/schema.ts), [Settings.ts](../src/utils/Settings.ts)) |
| AMQP transport | [`@voicenter-team/amqp-logger`](https://www.npmjs.com/package/@voicenter-team/amqp-logger) ([README.md:20](../README.md)) | None. To log to AMQP, pass a `logger` that publishes there ([subsystems/logger.md](subsystems/logger.md)) |
| Logger | Custom console logger + custom AMQP logger | Small `Logger` class: console by default, or the app-supplied `logger` object with `debug`/`info`/`warn`/`error` ([Logger.ts](../src/utils/Logger.ts)) |
| `LOGLEVEL` import path | `src/types/AmqpInterfaces` (per dev — README does not pin it but the old enum sat alongside AMQP types) | `src/types/LoggerInterfaces` ([LoggerInterfaces.ts:3-9](../src/types/LoggerInterfaces.ts#L3-L9), re-exported from [index.ts:32](../index.ts#L32)) |
| Schema file | none — config is whatever the caller passes | declared in [src/configs/schema.ts](../src/configs/schema.ts), a zod schema in which every object is strict, so an unknown key is an error |

## What stayed the same

The Galera-side semantics did not move between branches: validators are still
`{key, operator, value}` triples ([schema.ts:42-50](../src/configs/schema.ts#L42-L50),
[README.md:457-463](../README.md)), load factors are still
`{key, multiplier}` pairs ([schema.ts:51-58](../src/configs/schema.ts#L51-L58),
[README.md:477-482](../README.md)), and pool selection remains
filter-then-sort by pool status then pool score
([architecture.md](architecture.md), [README.md:9-13](../README.md)). The
cluster-hashing model (service → node pin in a backing MySQL table) and the SQL
asset layout under `assets/` are identical between branches — see
[sql-assets.md](sql-assets.md). The public API surface that consumers actually
touch — `createPoolCluster`, `cluster.connect`, `cluster.disconnect`,
`cluster.on`, `cluster.query` — is unchanged in name and signature
([index.ts:11-18](../index.ts#L11-L18), [README.md:168-220](../README.md));
only the shape of the config object passed to the factory differs.

## Migration note (dev examples → V3.0)

When you read a dev-era example and see `user`, `password`, `database`,
`validators`, `loadFactors`, `port`, `connectionLimit`, `queryTimeout`,
`slowQueryTime`, `timerCheckRange`, `timerCheckMultiplier`, or `redisFactor` at
the **top level** of the config object (or under `globalPoolSettings`), those
keys belong under `defaultPoolSettings` on V3.0. Pasting a dev-style config into
`createPoolCluster()` without nesting will fail strict validation
([schema.ts](../src/configs/schema.ts)) at boot. Likewise:

- `logLevel: LOGLEVEL.FULL` → `logs: { level: 'debug' }` (note the enum value space is different — V3 uses `info`/`error`/`debug`/`warn`/`silent`, not `QUIET`/`REGULAR`/`FULL`).
- `useConsoleLogger: true` → nothing to set, the console is the default. `useAmqpLogger: true` → pass your own `logger` (see [subsystems/logger.md](subsystems/logger.md)).
- `useRedis: true, redisSettings: { … }` → `redis: { enabled: true, … }`.
- `redis: redisClient` (the ioredis instance) → `redisInstant: redisClient`.
- `amqpLoggerSettings` → no equivalent. Remove it; the schema rejects AMQP settings.

For a key-by-key V3 reference (including the
`redisInstant` strip seam), see [configuration.md](configuration.md).
