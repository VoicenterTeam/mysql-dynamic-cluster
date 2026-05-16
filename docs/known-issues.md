# Known Issues

This document catalogues bugs, footguns, and rough edges discovered during the V3.0
audit of `mysql-dynamic-cluster`. Each entry records where the problem lives, what
it does, and a suggested fix. **Suggested fixes are informational only — none of
them have been applied.** This is a deferred work log, not a changelog.

Sibling docs: [architecture.md](architecture.md), [configuration.md](configuration.md),
[events.md](events.md), [sql-assets.md](sql-assets.md), [testing.md](testing.md),
[glossary.md](glossary.md).

## Table of contents

### Runtime correctness bugs
- [1. `Pool.query` does not return after reject](#1-poolquery-does-not-return-after-reject)
- [2. `Pool.multiStatementQuery` commits before queries finish](#2-poolmultistatementquery-commits-before-queries-finish)
- [3. `Validator.check` crashes on missing status key](#3-validatorcheck-crashes-on-missing-status-key)
- [4. `LoadFactor.check` crashes on missing status key](#4-loadfactorcheck-crashes-on-missing-status-key)
- [5. `Events.emit` wraps args in an array](#5-eventsemit-wraps-args-in-an-array)
- [6. `ClusterHashing._insertNodes` swallows errors silently](#6-clusterhashing_insertnodes-swallows-errors-silently)

### Configuration / wiring fragility
- [7. `ClusterHashing` SQL-asset paths are dist-depth fragile](#7-clusterhashing-sql-asset-paths-are-dist-depth-fragile)
- [8. `Redis.connect` double-connect risk](#8-redisconnect-double-connect-risk)
- [9. `config.load(userSettings).validate` lacks call parens](#9-configloadusersettingsvalidate-lacks-call-parens)

### Data model & SQL constraints
- [10. Hashing tables capped at 127 entries each (signed TINYINT)](#10-hashing-tables-capped-at-127-entries-each-signed-tinyint)
- [11. `SP_NodeServiceUpdate` parameter is smallint but column is tinyint](#11-sp_nodeserviceupdate-parameter-is-smallint-but-column-is-tinyint)

### Project hygiene
- [12. README describes dev-branch API, not V3.0](#12-readme-describes-dev-branch-api-not-v30)
- [13. Tests don't compile on V3.0](#13-tests-dont-compile-on-v30)
- [14. `tests/loads/` is excluded from `npm test`](#14-testsloads-is-excluded-from-npm-test)
- [15. No CI, no lint script](#15-no-ci-no-lint-script)

---

## Runtime correctness bugs

### 1. `Pool.query` does not return after reject

- **Severity:** **high**
- **Location:** [src/pool/Pool.ts:167-194](../src/pool/Pool.ts#L167-L194)
- **Description:** Inside the nested `getConnection` -> `changeUser` -> `query`
  callback chain, every error branch calls `reject(err)` without a following
  `return`. After a rejection in the `getConnection` branch (lines 167-174),
  execution falls through into the `!conn` check, the `changeUser` call and the
  outer `query` call. The Promise stays rejected (resolves only once), but the
  callbacks still fire side effects against a possibly undefined connection,
  call `conn.release()` on a missing connection, and emit misleading log/metric
  events. The `!conn` branch (lines 176-182) additionally calls
  `conn?.release()` on a connection that, by definition, does not exist.
- **Suggested fix:** add `return;` after every `reject(...)` in the chain and
  remove the redundant `conn?.release()` from the `!conn` branch. Consider
  rewriting around `mysql2/promise` and `async/await` to make the control flow
  explicit.

### 2. `Pool.multiStatementQuery` commits before queries finish

- **Severity:** **high**
- **Location:** [src/pool/Pool.ts:282-307](../src/pool/Pool.ts#L282-L307)
- **Description:** Inside the `beginTransaction` callback, `sqls.forEach` fires
  each `conn.query(...)` callback-style, then `conn.commit(...)` is invoked,
  the results array is returned via `resolve(results)`, and `conn.release()`
  runs — all synchronously, before the per-query callbacks have a chance to
  run. The transaction commits with zero queries executed against it, the
  `results` array is empty (or filled in random order if MySQL happens to be
  fast enough), and the connection is released back to the pool while queries
  are mid-flight. Same pattern as the bug in issue #1, but worse because the
  state being clobbered is a transaction.
- **Suggested fix:** rewrite the method around `mysql2/promise` (or `util.promisify`
  the callback API), awaiting each `query` sequentially, then `commit`, then
  `release` in a `try/finally`. The current implementation cannot be salvaged
  by adding `return` statements alone.

### 3. `Validator.check` crashes on missing status key

- **Severity:** **medium**
- **Location:** [src/pool/Validator.ts:45](../src/pool/Validator.ts#L45)
- **Description:** In the `default` branch of the switch, the expression
  `result.find(res => res.Variable_name === validator.key).Value` dereferences
  `.Value` on the find result without a guard. If the configured validator key
  does not appear in the `SHOW GLOBAL STATUS` output — e.g. a typo, a
  non-Galera MySQL flavour, or a status variable that was dropped between
  versions — `find` returns `undefined` and the access throws
  `TypeError: Cannot read property 'Value' of undefined`. The exception
  propagates out of `Validator.check`, aborting pool validation.
- **Suggested fix:** capture the find result into a local variable, guard for
  `undefined`, log a warning naming the missing key, and treat the validator as
  failing (return `false` for that pool) so the cluster downgrades the pool
  rather than crashing.

### 4. `LoadFactor.check` crashes on missing status key

- **Severity:** **medium**
- **Location:** [src/pool/LoadFactor.ts:28](../src/pool/LoadFactor.ts#L28)
- **Description:** The same pattern as issue #3:
  `result.find(res => res.Variable_name === loadFactor.key).Value` is
  dereferenced without checking the find result. The downstream
  `isNaN(+value)` check on line 29 was clearly intended to handle the missing
  case, but the dereference on line 28 throws before that check ever runs. A
  missing or renamed status variable aborts load-factor scoring for the
  affected pool.
- **Suggested fix:** capture the find result, guard for `undefined`, log the
  missing key, and treat it as contributing 0 to the score. The existing
  `isNaN/!value` check can then handle string and missing values uniformly.

### 5. `Events.emit` wraps args in an array

- **Severity:** **medium**
- **Location:** [src/utils/Events.ts:22](../src/utils/Events.ts#L22)
- **Description:** The `emit` wrapper is declared as
  `emit(event, ...args: any[])` and forwards to
  `eventEmitter.emit(event, args)` — passing the rest-collected array as a
  single argument instead of spreading it back out. Every listener registered
  via `Events.on(event, (a, b) => ...)` receives `a = [originalA, originalB]`
  and `b = undefined`. Listeners that assume one-argument-per-payload (the
  natural EventEmitter contract) silently see the wrong shape. See
  [events.md](events.md) for the documented signatures.
- **Suggested fix:** change to `eventEmitter.emit(event, ...args)` and audit
  every `Events.on(...)` callback in the codebase to confirm none of them rely
  on the accidental array-wrapping behaviour.

### 6. `ClusterHashing._insertNodes` swallows errors silently

- **Severity:** **low**
- **Location:** [src/cluster/ClusterHashing.ts:205-218](../src/cluster/ClusterHashing.ts#L205-L218)
- **Description:** The method wraps `this._cluster.query(...)` in
  `try/catch (e) { Logger.error(...) }`, but `cluster.query` returns a Promise
  and is not awaited. Synchronous exceptions are rare here; the actual failure
  mode is a Promise rejection, which never enters the `catch` and instead
  surfaces as an unhandled rejection (or is lost outright). The forEach also
  fires all inserts in parallel without serialising them, so the order in
  which `SP_NodeInsert` rows land is non-deterministic.
- **Suggested fix:** either `await` each `this._cluster.query(...)` inside a
  `for...of` (sequential, deterministic order) or collect the promises and use
  `Promise.all` with per-promise `.catch` handlers. Either way the function
  itself should be properly awaited by its caller.

---

## Configuration / wiring fragility

### 7. `ClusterHashing` SQL-asset paths are dist-depth fragile

- **Severity:** **low**
- **Location:** [src/cluster/ClusterHashing.ts:108-114](../src/cluster/ClusterHashing.ts#L108-L114)
- **Description:** `_createDB` constructs SQL-asset paths by prefixing
  `'../'` + `'../../assets/sql/create_hashing_database/...'` and resolving
  against `__dirname`. At runtime `__dirname` is
  `<pkg>/dist/src/cluster/`, so the `../../../assets/...` traversal lands on
  `<pkg>/assets/...`. The exact number of `../` segments is hard-coded against
  the current `tsconfig.outDir` layout — any change to `outDir`, to the source
  folder structure under `src/cluster/`, or to whether files are bundled into
  a single dist directory, silently breaks the path resolution at runtime with
  an `ENOENT` from `readdirSync`. Cross-reference [sql-assets.md](sql-assets.md)
  for the directory layout this depends on.
- **Suggested fix:** resolve the assets path once at module load time, either
  relative to a stable anchor (the directory containing `package.json`, found
  by walking up until a `package.json` is encountered) or by exposing a config
  knob that defaults to the bundled `assets/` directory.

### 8. `Redis.connect` double-connect risk

- **Severity:** **low**
- **Location:** [src/Redis/Redis.ts:49-53](../src/Redis/Redis.ts#L49-L53)
- **Description:** `Redis.connect()` calls `this.redis?.connect(callback)`
  unconditionally if `isEnabled()` is false. `ioredis` initiates a connection
  on construction by default, so by the time `connect()` is reached the
  underlying client is typically already connecting or already connected.
  Calling `.connect()` on an already-connecting client rejects with
  `Redis is already connecting/connected`. The `isEnabled()` guard only filters
  the fully-ready state; the transient "connecting" state still slips through.
- **Suggested fix:** before invoking `.connect()`, check `this.redis.status`
  against `'ready'`, `'connecting'`, `'connect'`, and `'reconnecting'`, and
  short-circuit in any of those states. Optionally wait on the `'ready'` event
  rather than calling `.connect()` at all (ioredis will get there on its own).

### 9. `config.load(userSettings).validate` lacks call parens

- **Severity:** **low**
- **Location:** [index.ts:15](../index.ts#L15)
- **Description:** The statement reads
  `config.load(userSettings).validate;` — it accesses the `.validate` method
  as a property but never invokes it. Result: user settings are loaded into
  the convict store but never validated at boot. The only validation that
  actually runs is the eager call at module load time in
  [src/configs/index.ts:23](../src/configs/index.ts#L23), which validates the
  *defaults* (since user settings have not been loaded yet). Cross-reference
  [configuration.md](configuration.md) for the validation contract this
  silently breaks.
- **Suggested fix:** append `()` so the call becomes
  `config.load(userSettings).validate({ allowed: 'strict' });`. With
  `allowed: 'strict'`, unknown keys in user settings will raise a clear error
  at boot instead of being silently ignored.

---

## Data model & SQL constraints

### 10. Hashing tables capped at 127 entries each (signed TINYINT)

- **Severity:** **medium**
- **Location:** [assets/sql/create_hashing_database/tables/node.sql](../assets/sql/create_hashing_database/tables/node.sql),
  [assets/sql/create_hashing_database/tables/node_services.sql](../assets/sql/create_hashing_database/tables/node_services.sql)
- **Description:** Both `node.node_id` and `node_services.service_id` /
  `node_services.node_id` are declared `tinyint` (signed by default in MySQL,
  range -128..127). Practically, the hashing infrastructure can address at
  most 127 nodes and 127 services. Beyond that, an `INSERT` either truncates
  to 127, fails with an out-of-range error, or silently wraps to -128
  depending on the active `sql_mode` (`STRICT_TRANS_TABLES` vs. lax). Foreign
  key relationships further interact unpleasantly with the truncation case.
  Cross-reference [sql-assets.md](sql-assets.md) for the schema overview.
- **Suggested fix:** widen the affected columns to `SMALLINT UNSIGNED`
  (65 535 entries) or `INT UNSIGNED` (~4 B entries) in a new migration. Bump
  `ClusterHashing._databaseVersion` so existing deployments recreate the
  schema. Coordinate with the column-versus-parameter mismatch in issue #11.

### 11. `SP_NodeServiceUpdate` parameter is smallint but column is tinyint

- **Severity:** **low**
- **Location:** [assets/sql/create_hashing_database/routines/SP_NodeServiceUpdate.sql](../assets/sql/create_hashing_database/routines/SP_NodeServiceUpdate.sql)
- **Description:** The procedure signature is
  `SP_NodeServiceUpdate(IN _ServiceID tinyint, IN _NodeID smallint)`, yet
  the column the second parameter writes into (`node_services.node_id`) is
  declared `tinyint`. MySQL accepts the wider parameter happily, then either
  truncates or rejects the insert when the value falls outside `-128..127`,
  depending on `sql_mode`. The mismatch hides the truncation: callers see a
  `smallint`-typed input that "should" work, and there is no error from the
  type system to indicate the narrowing on assignment.
- **Suggested fix:** change `_NodeID` to `tinyint` to match the destination
  column, or — preferably — widen both the column and the parameter together
  as part of the migration described in issue #10. Picking only one without
  the other re-introduces the same class of bug from the opposite direction.

---

## Project hygiene

### 12. README describes dev-branch API, not V3.0

- **Severity:** **medium**
- **Location:** [README.md](../README.md)
- **Description:** The repository README documents the older `dev` branch
  surface: top-level `globalPoolSettings`, top-level `logLevel`, the old AMQP
  configuration shape, and a flat `redisSettings`. V3.0 expects these under
  `defaultPoolSettings`, the AMQP block to live under
  `amqpLogger.amqpConnection`, and `redis` (not `redisSettings`) at the top
  level. Anyone copy-pasting a README example into V3.0 will hit a convict
  strict-validation error at boot. See [configuration.md](configuration.md)
  for the V3.0 schema.
- **Suggested fix:** leave the README untouched for the moment — a future
  `dev` -> V3 merge is expected to land the canonical README rewrite. Pull the
  README rewrite into that merge rather than as a standalone change.

### 13. Tests don't compile on V3.0

- **Severity:** **medium**
- **Location:** `tests/` — see [testing.md](testing.md) for the per-file breakdown.
- **Description:** The suite was written against the dev-branch API and never
  ported. Failures include a deleted `AmqpLoggerConfig` import in
  [tests/utils/settings.test.ts:7](../tests/utils/settings.test.ts#L7), wrong
  constructor arity in
  [tests/pool/query.test.ts:11](../tests/pool/query.test.ts#L11) and
  [tests/cluster/hashing.test.ts:53,72](../tests/cluster/hashing.test.ts#L53),
  and top-level `user`/`password`/`validators`/`loadFactors` (instead of nested
  under `defaultPoolSettings`) in
  [tests/cluster/query.test.ts:11-32](../tests/cluster/query.test.ts#L11-L32)
  and [tests/loads/load.test.ts:14-37](../tests/loads/load.test.ts#L14-L37).
- **Suggested fix:** rewrite each test file against the V3 schema and
  constructor signatures. Defer until after the dev -> V3 merge to avoid
  redoing the work.

### 14. `tests/loads/` is excluded from `npm test`

- **Severity:** **low**
- **Location:** [jest.config.js:11](../jest.config.js#L11) — `testPathIgnorePatterns` contains `'tests/loads'`.
- **Description:** `npm test` skips everything under `tests/loads/`. The only
  file there (`tests/loads/load.test.ts`) is also broken on V3 (issue #13), so
  the load tests neither run automatically nor pass. `npx jest tests/loads/load.test.ts` overrides the ignore pattern but is undocumented.
- **Suggested fix:** delete `tests/loads/` if abandoned; otherwise add a
  `test:load` script to `package.json` and document the contract in
  [testing.md](testing.md).

### 15. No CI, no lint script

- **Severity:** **low**
- **Location:** [package.json](../package.json) (the `scripts` block) and the
  absence of any `.github/workflows/` directory.
- **Description:** `package.json` declares `tslint` as a dev dependency but
  there is no `lint`, `lint:fix`, or `typecheck` script. `tslint` itself has
  been deprecated upstream since 2019. There is no GitHub Actions config in
  the repository, so `npm test`, `npm run build`, and any linter never run on
  push or PR. Schema breaks, type regressions, and the cluster of bugs above
  ride into `main` unchecked.
- **Suggested fix:** migrate to ESLint (`@typescript-eslint`), add `lint` and
  `typecheck` scripts, and add a GitHub Actions workflow running
  `npm ci && npm run build && npm test && npm run lint && npm run typecheck`.
