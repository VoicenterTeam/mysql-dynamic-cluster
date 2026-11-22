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
    named-values.test.ts         # object values: always escaped, the 4.x option ignored, the setting refused
    named-values-setting.test.ts # named values through createPoolCluster: escaped, the setting refused
    execute.test.ts              # execute() and the execute option on loopback: prepare, bound values, NO_BACKSLASH_ESCAPES
    host-ids.test.ts             # Host ids: which id each host gets, with and without an id in the settings
    query-pool-order.test.ts     # The order query() tries its pools in: load score, the pool of the service first
    query-error.test.ts          # What a failed query() rejects with, real mysql2 on loopback: the mysql2 error, nodeId, errors, MDC_NO_NODE_AVAILABLE
    query-error-edges.test.ts    # The same over fake pools: one error from two nodes, a frozen error, a non-object, the stale cache
    node-api.test.ts             # Node API over fake pools: getConnection, failWaiting, getPoolStats, nodes
    node-api-public.test.ts      # Node API through createPoolCluster, before connect()
    node-api-loopback.test.ts    # Node API with the real mysql2 against its server class on loopback, getConnection with a signal included
    get-connection-signal.test.ts # getConnection({ signal }) over fake pools: what counts as a signal, already aborted, the reason, nodeId
    ready.test.ts                # cluster.ready: pass, fail, never rejects, one promise per connect(); connect() as before
    ready-unhandled.test.ts      # cluster.ready and firstReady leave no unhandled rejection, in a clean Node process
    first-ready.test.ts          # cluster.firstReady: first pass, none pass, never rejects, one promise per connect()
    check-error.test.ts          # checkError over fake pools: nodes(), the results of ready and firstReady
    check-error-loopback.test.ts # checkError with the real mysql2 on loopback: refused login, timeouts, reconnect
    health-check-refusal-loopback.test.ts # A healthCheck node whose login the real mysql2 sees refused on loopback: down at once, the next login after authRetryInterval, a refusal held back past the timeout
    passive-health-loopback.test.ts # Passive health with the real mysql2 on loopback: a refused connection, a connection dropped under a query, a deadlock, a refused login. Behind a TCP proxy, with ten connections per pool: idle connections the path forgot, a path that resets or swallows everything, a process that stalls past the connect timer. By name: a name that resolves to an address with no route, for a real ENETUNREACH of a call and of the check after it, with pools that hold a connection and with pools that hold none, and a path that swallows new connections only. The check connection: a pool at its limit, connect and disconnect, a connection lost while idle or forgotten by the path, a check that times out, a process that stalls past the check timer
    idle-ping-loopback.test.ts   # The ping of the idle pooled connections with the real mysql2 behind a TCP proxy on loopback: a path that forgets a flow after 1500 ms and a pause of 3 s of real time, a connection the path forgot before its ping, by a reset and by silence, the app drawing a connection whose ping is out, a node without the block, a cluster with the block on one host only, an `idleCheckInterval` Node runs every millisecond, disconnect with a ping that has no answer, disconnect and connect
    query.test.ts                # GaleraCluster.query() shapes: no values, scalar, array, named, timeout (stale)
  configs/
    settings.test.ts             # Settings schema: defaults, strict validation, mixSettings, no env reading
    settings-guard.test.ts       # createPoolCluster with settings that are not an object
  metrics/
    no-side-effects.test.ts      # Requiring the package has no side effects
    otel-metrics.test.ts         # OpenTelemetry metrics recorded by the cluster
    pool-metrics.test.ts         # Pool connection metrics read at collection: values, attributes, connect and disconnect
    health-metrics.test.ts       # Health-check metric and node gauges: every result, what records nothing, the gauge values
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
    reaper.test.ts               # IdleConnectionReaper: the age rule
    idle-ping.test.ts            # The ping of the idle pooled connections of a healthCheck node: the reaper alone, then a Pool over a mysql2 the test drives. Which connections get a ping, what a ping ends with, its limit, the app drawing the connection, stop and start, the pace of the ping for an `idleCheckInterval` below 100 or above 2147483647, no event, no metric, no check
    status-invalid.test.ts       # PoolStatus.checkStatus validity
    status-missing-key.test.ts   # A status key missing from SHOW GLOBAL STATUS
    check-failed-event.test.ts   # pool_check_failed: the payload, every failed check, a listener that throws
    check-failed-event-public.test.ts # pool_check_failed through createPoolCluster and cluster.on
    check-loop.test.ts           # Health check loop: stop and start, a check that ends late, odd errors
    check-error.test.ts          # PoolStatus.checkError: what it holds, when it is set and cleared, odd errors
    check-error-paths.test.ts    # Every way a check of a real Pool fails, and what checkError holds after each
    reconnect-checks.test.ts     # A pool connected, disconnected and connected again is checked again
    health-check-legacy.test.ts  # Health check as 4.6.0 runs it: waits, timeout, down and up, time to leave rotation
    health-check.test.ts         # Health check with a healthCheck block: interval, timeout, fall, rise, refused logins, authRetryInterval and its slow pace, settings, timing
    check-connection.test.ts     # The check connection of a healthCheck node against a mysql2 the test drives: its options and flags, what a check sends, kept or dropped, the one new connection after a loss, the new connection after a call of the app that could open none, the timeout and its turn of the event loop, connect and disconnect, the operation metric
    passive-health.test.ts       # Passive health of a healthCheck node: the four kinds of error from query, transaction and getConnection, the check that opens a new connection for one it lost, once, the check that asks on a new connection after a call that could open none, the check that finds no route itself and counts toward fall, what never counts, one check at a time, fall and rise, passive false, the legacy check, timing
    node-api.test.ts             # Pool.getConnection, failWaiting and stats over a mocked mysql2 pool
    get-connection-signal.test.ts # Pool.getConnection with a signal over a mocked mysql2 pool: queue, login, listener, reason
    borrow.test.ts               # Borrow with the real mysql2 on loopback, counting the commands of the server: the probe after probeIdle and its timeout, the ping of the reaper, a failed probe, an abort during it, the health check that is never probed, resetAfterStatements, packets out of order, the reset at release() of getConnection()
  toolchain/
    compiler.test.ts             # The compiler parses the syntax zod 4 needs; every import resolves through exports maps
    declarations.test.ts         # The built declarations export the node API types and type the healthCheck block, checked by compiling an app
  utils/
    logger.test.ts               # Logger: levels, console default, app-supplied logger
    logger-injection.test.ts     # A logger passed to createPoolCluster
    redis-init.test.ts           # Redis.init: the key prefix, the settings left as they were
    service-names.test.ts        # ServiceNames.getID: the name is passed as a value
    settings.test.ts             # Merge of user settings + defaults via Settings (stale, dev API)
    utils.test.ts                # Pure-unit tests for Timer and Utils.clamp
    timer.test.ts                # Timer: one pending run, dispose, activate
  galera/                        # The Galera contract suite, see "The Galera rig". Skipped unless MDC_TEST_GALERA is set
    support.ts                   # Shared by the suites: describeRig (skip, one suite at a time), the env file, root connections, until()
    rig.test.ts                  # Smoke test of the three-node Galera rig: connect, each node answers, wsrep_cluster_size is 3, no error logged
    bound-values.test.ts         # Contract test of #91 on MySQL 8.0.42: hostile strings through execute() under the default mode, ANSI_QUOTES and NO_BACKSLASH_ESCAPES, query() refused under the last, also on a new connection under the global mode; cluster hashing (from dist/, as root) registers its nodes
    node-drops-out.test.ts       # #87, #90: a node isolated with gmcast.isolate=1 answers 1047, the call answers from another node; back and Synced, the node is used again
    double-write.test.ts         # #87: write_then_fail() and write_then_sleep() (timeout 1000) reject and leave one row each
    left-open-transaction.test.ts # #90, #93: a transaction left open by a query or by a getConnection() caller is gone for the next caller, its row lock free
    dead-connection.test.ts      # #93: a pooled connection whose path went silent is replaced after 1 s idle, the write runs once on a new connection
  loads/
    load.test.ts                 # Manual load harness; ignored by jest config (stale)
```

## The Galera rig

`tests/rig/galera.sh` runs three nodes of `codership/mysql-galera:8.0.42` in docker, for suites that need a real Galera cluster. The image must be on the machine already: the script never pulls or builds. Three nodes, because with two, isolating one leaves no primary component to fail over to.

```
bash tests/rig/galera.sh up       # prints the path of the env file when all three nodes are Synced
npm run build                     # bound-values.test.ts loads dist/ for cluster hashing
MDC_TEST_GALERA=1 npx jest tests/galera
bash tests/rig/galera.sh down     # removes containers, network and state; safe to run twice
bash tests/rig/galera.sh status   # one line per node
```

- `up` returns when each node reports `wsrep_cluster_size = 3`, `wsrep_cluster_status = Primary` and `wsrep_local_state_comment = Synced`. After `MDC_RIG_TIMEOUT` seconds (default 240) it names the node that is not ready, prints the tail of its log and exits 1.
- Each node is published on a random port of 127.0.0.1 only, on the user-defined network `mdc-rig-net`. The passwords are generated at every `up` and stay in the state dir (mode 700, under `${TMPDIR:-/tmp}`), which `down` removes. `down` and `up` leave a `MDC_RIG_STATE` directory alone unless it holds the marker file `.mdc-rig` that `up` writes, and `down` kills the node processes only of a directory with that marker.
- The env file (`MDC_GALERA_HOST`, `MDC_GALERA_PORT1`..`3`, `MDC_GALERA_USER`, `MDC_GALERA_PASSWORD`, `MDC_GALERA_DATABASE`, and `MDC_GALERA_ROOT_PASSWORD` for a suite that must create a schema with stored routines: the app user owns only its database, and with binary logging on only root may create a function) is `${TMPDIR:-/tmp}/mdc-rig-state/rig.env`. The suites read it. Set `MDC_RIG_ENV` to move it, for `up` and the jest run alike. Its first line says the rig wrote it: `down` removes only such a file, and `up` refuses to write over a file without that line.
- Without `MDC_TEST_GALERA` the suites under `tests/galera` are skipped, so `npm test` needs no docker.
- Other settings: `MDC_RIG_IMAGE`, `MDC_RIG_NAME` (prefix of the containers and the network, default `mdc-rig`), `MDC_RIG_STATE`.
- The nodes use the package's default settings and no server settings beyond what Galera needs to form a cluster.

`MDC_RIG_DOCKER_RUN` is the command that starts a node, default `docker run`. A node runs in the foreground, in the background of the script, with its output in `<state dir>/node<N>.log`. On the shared CI machine a bare `docker run` is refused, and the container must go through the slot:

```
export MDC_RIG_DOCKER_RUN="bash $HOME/ci-box/tests/slot.sh docker run"
npm run build
bash tests/rig/galera.sh up
MDC_TEST_GALERA=1 ~/ci-box/bin/lane-cpus npx jest --maxWorkers=6 tests/galera
bash tests/rig/galera.sh down
```

On that machine `up` takes about a minute, the suite under half a minute and `down` a few seconds, see the table at the end of this section.

### The contract suite

Each suite in `tests/galera` runs a cluster with the package's default settings, as the app user, with cluster hashing off (the app user may not create its schema; `bound-values.test.ts` runs its hashing part as root). None sets a timer or a limit, so they check the defaults: `probeIdle`, `probeTimeout`, `resetTimeout`, `errorRetryCount` and the legacy health check. Tables and routines are made as root on a connection of its own, and dropped at the end.

| Suite | Scenario | What it proves |
| --- | --- | --- |
| `node-drops-out.test.ts` | `SET GLOBAL wsrep_provider_options = 'gmcast.isolate=1'` on the node the cluster asks first. The cluster asks again until the node sees it is out of the primary component, about 6 s later. Then `isolate=0`. | The first call after the drop gets 1047 from that node and answers from another node within the same call, in under 1 s (#87, #90: no change of user that waits for its timeout). Once the node is Synced again, the cluster's next check takes it back and `getConnection()` hands it out. The statement reads a table: a node out of the primary component still answers `SELECT 1` and `SELECT @@hostname`. |
| `double-write.test.ts` | `write_then_fail()` inserts a row, then `SIGNAL`s. `write_then_sleep()` inserts a row, then sleeps 3 s, called with `timeout: 1000`. Three nodes valid. | Each call rejects (errno 1644, or `PROTOCOL_SEQUENCE_TIMEOUT` after 1 s), with `sent: true` and an empty `errors`, and leaves one row, counted with `wsrep_sync_wait = 1` after the sleep is over. 4.x wrote two rows each (#87). |
| `left-open-transaction.test.ts` | One node. A `CALL` that leaves a transaction open with a row lock, and a `getConnection()` caller that does the same and calls `release()`. | The next caller on that connection gets reply headers without the in-transaction bit, and another session takes the row lock at once with `FOR UPDATE NOWAIT` and reads the value as it was: the reset rolled the transaction back (#90 for the query, #93 for the lent connection). |
| `dead-connection.test.ts` | A TCP proxy in front of node 1. After a call through it, the proxy goes silent on the open flows, without a close on the client's side. 1.1 s later, an `INSERT` of `CONNECTION_ID()`. | The call resolves, the row is there once, and the connection id in it is higher than any id the node had before the cut: the idle connection failed its ping and the write ran on a new connection (#93). |
| `bound-values.test.ts` | Hostile strings under the default mode, `ANSI_QUOTES` and `NO_BACKSLASH_ESCAPES`; `query()` with values refused on a new connection of a node whose global `sql_mode` has `NO_BACKSLASH_ESCAPES` (restored after); cluster hashing as root. | See #91. |
| `rig.test.ts` | Connect to the three nodes. | Smoke test of the rig: every node valid and answering, `wsrep_cluster_size` 3, nothing logged as an error. |

jest runs the files side by side, and a suite that isolates a node would break one that counts the nodes. `describeRig` in `support.ts` takes a lock (a directory next to the env file) before the hooks of its block and gives it back after them, so the suites run one at a time whatever `--maxWorkers` says. A lock whose process is gone is taken over. `node-drops-out.test.ts` sets `isolate=0` and waits for the node to be Synced in its `afterAll`, also when a test failed, so the next suite gets three nodes.

Measured on the shared CI machine before the 5.0.0 release, three runs in a row, each from a fresh `up` to `down`, 106 tests passed in each:

| Run | `up` | jest `tests/galera` | `down` |
| --- | --- | --- | --- |
| 1 | 50 s | 24 s | 3 s |
| 2 | 55 s | 26 s | 3 s |
| 3 | 54 s | 25 s | 2 s |

Most of the jest time is `node-drops-out.test.ts` (about 12 s: 6 s until the node sees it is out, 5 s until it is Synced again) and the 3.5 s of `write_then_sleep()`.

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
