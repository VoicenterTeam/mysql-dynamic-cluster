# Testing

This document describes the test layout of `@voicenter-team/mysql-dynamic-cluster` and — importantly — the current state of those tests against the V3 public API. See [architecture.md](./architecture.md) for the runtime layout the tests exercise and [configuration.md](./configuration.md) for the settings shape they should be using.

## Framework and commands

- Runner: **Jest 30** (`jest ^30.4.2`) with `ts-jest ^29.4.9` (see `devDependencies` in [package.json:50](../package.json#L50)).
- Node: running the suite needs Node 20 or later, because of the two `overrides` below. The library itself has no such floor.
- `overrides` in [package.json](../package.json): `glob ^14.0.2` and `minimatch ^11.0.1` are dev-only and lift jest and test-exclude past the ranges they declare, for GHSA-3g3m-2fjr-6pw4 (glob) and GHSA-g3hv-75wg-m249 (minimatch). Remove them when jest and test-exclude declare patched ranges: delete the block, run `npm install` and check that `npm audit` shows neither advisory.
- Config: [jest.config.js:1](../jest.config.js#L1). Uses the `ts-jest` preset, `node` test environment, and a 5-minute per-test timeout (`testTimeout: 300000`).
- Scripts ([package.json:33](../package.json#L33)):
  - `npm test` runs `jest`.
  - `npm run coverage` runs `jest --coverage`. Coverage is collected from `src/**/*.ts` and `index.ts` (`collectCoverageFrom` in [jest.config.js](../jest.config.js)) and checked against the `coverageThreshold` in the same file: statements 79, branches 73, functions 78, lines 80. Measured on 4.3.0 with the suites that run: statements 84.89 %, branches 78.83 %, functions 83.41 %, lines 85.63 %. Each floor is the measured number less 5, rounded down. The command exits 1 either way, as `npm test` does, because of the four stale suites below. So a missed threshold does not change the exit code today: look for a line that starts with `Jest: Coverage for` in the output. There is none when the thresholds are met.
- The `tests/loads` directory is excluded from `npm test` via `testPathIgnorePatterns` ([jest.config.js:9](../jest.config.js#L9)). Load tests must be invoked explicitly (e.g. `npx jest tests/loads`).

## Layout

```
tests/
  cluster/
    hashing.test.ts              # ClusterHashing wiring against a live cluster + helper schema (stale)
    hashing-upgrade.test.ts      # Hashing schema: backward compatible upgrade in place
    hashing-restart.test.ts      # Cluster hashing after stop(): a second connect, a check that ends late
    no-valid-pool-cache.test.ts  # GaleraCluster.query when no pool is valid: stale cache fallback
    named-values.test.ts         # object values: escapeNamedValues on, off, per query, the one-time warning
    named-values-setting.test.ts # the escapeNamedValues setting through createPoolCluster
    host-ids.test.ts             # Host ids: which id each host gets, with and without an id in the settings
    query.test.ts                # GaleraCluster.query() shapes: no values, scalar, array, named, timeout (stale)
  configs/
    settings.test.ts             # Settings schema: defaults, strict validation, mixSettings, no env reading
    settings-guard.test.ts       # createPoolCluster with settings that are not an object
  metrics/
    no-side-effects.test.ts      # Requiring the package has no side effects
    otel-metrics.test.ts         # OpenTelemetry metrics recorded by the cluster
  pool/
    flags.test.ts                # The flags pool setting reaches mysql2's createPool
    auto-flags.test.ts           # Flags picked from the server greeting: the rule, the pool, the log lines
    server-greeting.test.ts      # The probe login against mysql2's own server class on loopback
    probe-timer.test.ts          # The 2 s close timer of the probe: length, unref, cleared on a clean end
    auto-flags-loopback.test.ts  # The real Pool on loopback: which capability each login announces
    idle-defaults.test.ts        # Idle connection defaults in the settings schema
    multi-statement.test.ts      # Pool.multiStatementQuery: order, commit, rollback
    query-hygiene.test.ts        # Pool.query error paths and availableConnectionCount
    query.test.ts                # Single-pool round-trip: connect, query, disconnect, query timeout (stale)
    reaper.test.ts               # IdleConnectionReaper
    status-invalid.test.ts       # PoolStatus.checkStatus validity
    status-missing-key.test.ts   # A status key missing from SHOW GLOBAL STATUS
    check-failed-event.test.ts   # pool_check_failed: the payload, every failed check, a listener that throws
    check-failed-event-public.test.ts # pool_check_failed through createPoolCluster and cluster.on
    check-loop.test.ts           # Health check loop: stop and start, a check that ends late, odd errors
    reconnect-checks.test.ts     # A pool connected, disconnected and connected again is checked again
  toolchain/
    compiler.test.ts             # The compiler parses the syntax zod 4 needs; every import resolves through exports maps
  utils/
    logger.test.ts               # Logger: levels, console default, app-supplied logger
    logger-injection.test.ts     # A logger passed to createPoolCluster
    redis-init.test.ts           # Redis.init: the key prefix, the settings left as they were
    service-names.test.ts        # ServiceNames.getID: the name is passed as a value
    settings.test.ts             # Merge of user settings + defaults via Settings (stale, dev API)
    utils.test.ts                # Pure-unit tests for Timer and Utils.clamp
    timer.test.ts                # Timer: one pending run, dispose, activate
  loads/
    load.test.ts                 # Manual load harness; ignored by jest config (stale)
```

## Prerequisites for integration suites

The integration suites (`tests/pool/query.test.ts`, `tests/cluster/query.test.ts`, `tests/cluster/hashing.test.ts`, `tests/loads/load.test.ts`) open real MySQL connections via `mysql2` and require a `.env` file at the repo root. The keys, copied from [.env.example:1](../.env.example#L1):

| Variable | Used by | Notes |
| --- | --- | --- |
| `DB_HOST1` | (declared but unused by current tests) | Present for parity with three-node Galera setups. |
| `DB_HOST2` | [tests/pool/query.test.ts:13](../tests/pool/query.test.ts#L13), [tests/cluster/query.test.ts:14](../tests/cluster/query.test.ts#L14), [tests/cluster/hashing.test.ts:17](../tests/cluster/hashing.test.ts#L17), [tests/loads/load.test.ts:19](../tests/loads/load.test.ts#L19) | Primary node in cluster suites. |
| `DB_HOST3` | Same files as `DB_HOST2` (second host slot) | Secondary node. |
| `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | All integration tests | The MySQL user must have permission to read `officering_api_doc.MethodType` (cluster/pool query suites) and to create/drop `test_hashing` plus run the hashing helper schema in `mysql-dynamic-cluster` (hashing suite). |

`dotenv.config({ path: './.env' })` is invoked inside each of these suites, so tests must be run from the repo root. `dotenv` is a devDependency for this purpose only; the library itself reads no `.env` file.

## File-by-file summary

- [tests/utils/utils.test.ts](../tests/utils/utils.test.ts) — Pure unit tests. Confirms `Timer` fires roughly N times over a sleep window and that `Utils.clamp` clamps below, above, and within bounds. No DB, no settings layer, fully schema-agnostic.
- [tests/utils/settings.test.ts](../tests/utils/settings.test.ts) — Drives the `Settings` merge layer (`src/utils/Settings.ts`) with a hand-rolled `IUserSettings` and asserts the merged result. **Currently broken on V3** — see below.
- [tests/pool/query.test.ts](../tests/pool/query.test.ts) — Builds a single `Pool` against `DB_HOST2` and exercises `pool.query()` without arguments and with `{ timeout: 5 }`. **Currently broken on V3** — see below.
- [tests/cluster/query.test.ts](../tests/cluster/query.test.ts) — Uses `createPoolCluster` over two hosts and verifies the four `query()` parameter shapes (none, scalar, array, named-object) plus the inactivity-timeout path. **Currently broken on V3** — see below.
- [tests/cluster/hashing.test.ts](../tests/cluster/hashing.test.ts) — Builds a cluster, instantiates `ClusterHashing`, then validates that the helper schema gets created from the SQL assets under [assets/sql/create_hashing_database](../assets/sql/create_hashing_database) and that the in-memory `serviceNodeMap` matches the result of `FN_GetServiceNodeMapping()`. **Currently broken on V3** — see below.
- [tests/loads/load.test.ts](../tests/loads/load.test.ts) — Fires 100 `select sleep(100)` queries across two pools and asserts that `Threads_running` on both nodes climbs above 22. Excluded from the default Jest run. **Currently broken on V3** — see below.

---

## **Warning: four suites are stale on V3.0**

> **Four suites were written against the dev-branch API and no longer compile against the V3 source: `tests/cluster/hashing.test.ts`, `tests/cluster/query.test.ts`, `tests/pool/query.test.ts` and `tests/utils/settings.test.ts`.** They are kept in-tree as a starting point for a future rewrite. `npm test` reports them as failed before they reach any DB call; every other suite passes. `tests/loads/load.test.ts` is stale too, but Jest does not run it.

### `tests/utils/settings.test.ts`

- [tests/utils/settings.test.ts:7](../tests/utils/settings.test.ts#L7) imports `AmqpLoggerConfig` from `../../src/configs/AmqpLoggerConfig` — that module has been removed from V3. Since 4.0.0 the library has no AMQP logger at all; see [subsystems/logger.md](./subsystems/logger.md).
- [tests/utils/settings.test.ts:8](../tests/utils/settings.test.ts#L8) imports `LOGLEVEL` from `../../src/types/AmqpInterfaces`. In V3 `LOGLEVEL` is exported from [src/types/LoggerInterfaces.ts](../src/types/LoggerInterfaces.ts) (and re-exported via [src/types/SettingsInterfaces.ts](../src/types/SettingsInterfaces.ts)).
- The fixture builds `IUserSettings` with a top-level `globalPoolSettings` block ([tests/utils/settings.test.ts:27](../tests/utils/settings.test.ts#L27), [tests/utils/settings.test.ts:88](../tests/utils/settings.test.ts#L88)) and a `useAmqpLogger: true` flag ([tests/utils/settings.test.ts:112](../tests/utils/settings.test.ts#L112)). V3 renamed the key to `defaultPoolSettings` (see [src/types/SettingsInterfaces.ts:28](../src/types/SettingsInterfaces.ts#L28)) and dropped `useAmqpLogger`; since 4.0.0 the app passes its own `logger` instead (see [subsystems/logger.md](./subsystems/logger.md)).
- The `redisSettings` block is flat (`algorithm`, `keyPrefix`, `expiryMode`, `expire`, `clearOnStart` at the top level — see [tests/utils/settings.test.ts:33](../tests/utils/settings.test.ts#L33) and [tests/utils/settings.test.ts:113](../tests/utils/settings.test.ts#L113)). V3 calls this block `redis`, moves `enabled` into it, and rejects `redisSettings`; consult [configuration.md](./configuration.md) for the current shape.

### `tests/cluster/hashing.test.ts`

- [tests/cluster/hashing.test.ts:53](../tests/cluster/hashing.test.ts#L53) calls `new ClusterHashing(cluster, null, database)` passing a database name string in slot 3. The V3 signature is `constructor(cluster: GaleraCluster, clusterName: string, options: IClusterHashingSettings)` — see [src/cluster/ClusterHashing.ts](../src/cluster/ClusterHashing.ts). The actual database name is now derived as `${clusterName}_${options.dbName}` ([src/cluster/ClusterHashing.ts](../src/cluster/ClusterHashing.ts)), so passing a raw schema name is silently wrong even if the call compiled.
- [tests/cluster/hashing.test.ts:72](../tests/cluster/hashing.test.ts#L72) calls `new ClusterHashing(cluster)` with a single argument — V3 requires three.
- [tests/cluster/hashing.test.ts:73](../tests/cluster/hashing.test.ts#L73) and [tests/cluster/hashing.test.ts:74](../tests/cluster/hashing.test.ts#L74) reach into private members: `clusterHashing._checkHashing()` and `clusterHashing.serviceNodeMap`. In V3 `_checkHashing` is `private` ([src/cluster/ClusterHashing.ts](../src/cluster/ClusterHashing.ts)) and the map is stored as `_serviceNodeMap` with no public getter; both accesses fail typecheck.
- The cluster fixture itself uses the dev-branch top-level shape (see next section).

### `tests/cluster/query.test.ts` and `tests/loads/load.test.ts`

- The `createPoolCluster({...})` argument at [tests/cluster/query.test.ts:11](../tests/cluster/query.test.ts#L11) and [tests/loads/load.test.ts:16](../tests/loads/load.test.ts#L16) places `user`, `password`, `database`, `validators`, and `loadFactors` at the **top level** of the settings object. In V3 those fields belong under `defaultPoolSettings` ([src/types/SettingsInterfaces.ts:28](../src/types/SettingsInterfaces.ts#L28); see [configuration.md](./configuration.md) for the resolved shape). Only `hosts` and per-host overrides may stay at the top level.
- Same applies to [tests/cluster/hashing.test.ts:14](../tests/cluster/hashing.test.ts#L14)–[tests/cluster/hashing.test.ts:35](../tests/cluster/hashing.test.ts#L35).

### `tests/pool/query.test.ts`

- [tests/pool/query.test.ts:11](../tests/pool/query.test.ts#L11) calls `new Pool({...})` with a single argument. The V3 `Pool` constructor signature is `constructor(settings: IUserPoolSettings, clusterName: string)` ([src/pool/Pool.ts:46](../src/pool/Pool.ts#L46)) — the second arg is required because the pool's logger and metric names are scoped by cluster.
- The settings object passed in is the dev-branch per-host shape (with `validators`/`loadFactors` and no `defaultPoolSettings` resolution). In V3, a bare `Pool` is rarely instantiated directly outside the cluster — the supported entry point is `createPoolCluster()` (see [architecture.md](./architecture.md)).

---

## What still works

The other suites run clean on V3: [tests/utils/utils.test.ts](../tests/utils/utils.test.ts) and the suites written for this line (everything under `tests/` that the warning above does not name). `utils.test.ts` depends solely on [src/utils/Timer.ts](../src/utils/Timer.ts) and [src/utils/Utils.ts](../src/utils/Utils.ts), neither of which has changed shape between branches. Use it as the canonical reference for a test that doesn't need rewriting.

## Guidance for future agents

When you touch these tests, **rewrite them against the V3 schema documented in [configuration.md](./configuration.md)**. Concretely:

1. Move `user` / `password` / `database` / `validators` / `loadFactors` into `defaultPoolSettings` on every `createPoolCluster()` call.
2. Replace `globalPoolSettings` with `defaultPoolSettings` and drop the top-level `useAmqpLogger` flag (the library has no AMQP logger; see [subsystems/logger.md](./subsystems/logger.md)).
3. Import `LOGLEVEL` from `src/types/LoggerInterfaces` (or `src/types/SettingsInterfaces`), not `src/types/AmqpInterfaces`.
4. Update the `ClusterHashing` test fixture to construct `new ClusterHashing(cluster, clusterName, { nextCheckTime, dbName })`, and drive it through its public surface (`connect()` / `stop()`) instead of poking `_checkHashing` and `serviceNodeMap`. If you genuinely need to assert internal state, add a public read-only getter on `ClusterHashing` first.
5. For the `Pool` suite, pass a `clusterName` as the second constructor argument, or replace the direct `new Pool(...)` with a cluster fixture.
6. Re-enable the commented-out cases in `cluster/query.test.ts` and `cluster/hashing.test.ts` once the schema-changing operations they wrap (`SP_NodeInsert`, `FN_GetServiceNodeMapping`) are validated against current [assets/sql](../assets/sql) — see [sql-assets.md](./sql-assets.md).

**Do not** revert the V3 source to the dev-branch API to make the tests compile. The V3 settings shape is the contract; the tests are the side that's out of date.
