# CLAUDE.md

`@voicenter-team/mysql-dynamic-cluster` is a Galera-aware MySQL client that picks pools by health and load, optionally caches results in Redis, and pins services to nodes via a hashing database. This file routes agents into [docs/](docs/); read the linked doc before changing the matching subsystem.

## Repo layout

- `src/` — library source (`cluster/`, `pool/`, `Redis/`, `utils/`, `configs/`, `types/`, `metrics/`).
- `tests/` — Jest suites (four stale suites fail to compile; see [docs/testing.md](docs/testing.md)).
- `assets/sql/` — hashing-database DDL + stored routines bundled at publish time.
- `demo/` — runnable example used by `npm start`.
- `docs/` — V3.0 documentation set (this file's routing targets).
- Root configs: `index.ts`, `tsconfig.json`, `jest.config.js`, `tslint.json`, `package.json`, `ecosystem.config.js`.

## Working on the V3.0 branch

You are on the **V3.0** line. The `dev` branch ships a different (older) public API: top-level `globalPoolSettings`, flat `redisSettings`, an AMQP logger. Do **not** copy patterns across branches without checking [docs/branch-divergence.md](docs/branch-divergence.md) first — examples that compile on `dev` often hit strict-validation errors on V3.0.

## Commands

From `package.json` (no inventing scripts):

- `npm install` — install dependencies.
- `npm run build` — `tsc -p tsconfig.build.json` (target es6, commonjs, emits to `dist/`).
- `npm test` — run Jest. Four stale suites fail to compile on V3.0, every other suite passes; see [docs/testing.md](docs/testing.md).
- `npm run coverage` — `jest --coverage`.
- `npm start` — `npm run build && node demo/index.js`.

There is **no** `lint`, `typecheck`, or `test:load` script. `tslint` is in devDependencies but unwired.

## Where to read before changing X

| You're touching… | Read first |
| --- | --- |
| `GaleraCluster.query` / routing | [docs/subsystems/cluster.md](docs/subsystems/cluster.md) |
| Pool health checks / scoring | [docs/subsystems/health-and-scoring.md](docs/subsystems/health-and-scoring.md) |
| Redis caching | [docs/subsystems/redis-cache.md](docs/subsystems/redis-cache.md) |
| Config / settings | [docs/configuration.md](docs/configuration.md) |
| Hashing helper DB | [docs/sql-assets.md](docs/sql-assets.md) + [docs/subsystems/cluster-hashing.md](docs/subsystems/cluster-hashing.md) |
| Tests | [docs/testing.md](docs/testing.md) **first** — four suites are stale on V3.0 |

## Footguns

- **Singletons everywhere.** `Logger`, `Redis`, `Metrics`, `config`, `Events` are module-level singletons — effectively one cluster per process. See [docs/architecture.md](docs/architecture.md).
- **`Events.emit` wraps args in an array.** Listeners get `(allArgsArray, undefined)` instead of spread args — see [docs/known-issues.md#5-eventsemit-wraps-args-in-an-array](docs/known-issues.md#5-eventsemit-wraps-args-in-an-array).
- **`Validator` / `LoadFactor` missing status key** was a crash before 3.2.2; now it's logged by name (validator fails, load factor skipped) — see [docs/known-issues.md#3-validatorcheck-crashes-on-missing-status-key](docs/known-issues.md#3-validatorcheck-crashes-on-missing-status-key) and [#4](docs/known-issues.md#4-loadfactorcheck-crashes-on-missing-status-key).
- **`Pool.query` error handling was fixed in 3.2.2** (returns after reject, destroys connections after fatal errors/timeouts) — see [docs/known-issues.md#1-poolquery-does-not-return-after-reject](docs/known-issues.md#1-poolquery-does-not-return-after-reject).
- **`Pool.multiStatementQuery` commit-before-queries bug was fixed in 3.2.2** — see [docs/known-issues.md#2-poolmultistatementquery-commits-before-queries-finish](docs/known-issues.md#2-poolmultistatementquery-commits-before-queries-finish).
- **Four suites in `tests/` don't compile on V3.** Constructor signatures and settings shape have moved — see [docs/known-issues.md#13-tests-dont-compile-on-v30](docs/known-issues.md#13-tests-dont-compile-on-v30).
- **Hashing tables capped at 127 nodes / 127 services** (signed `TINYINT`) — see [docs/known-issues.md#10-hashing-tables-capped-at-127-entries-each-signed-tinyint](docs/known-issues.md#10-hashing-tables-capped-at-127-entries-each-signed-tinyint).
- **`ClusterHashing` SQL-asset paths are dist-depth fragile.** Hard-coded `../` traversal against `__dirname`; any `outDir` change breaks it — see [docs/known-issues.md#7-clusterhashing-sql-asset-paths-are-dist-depth-fragile](docs/known-issues.md#7-clusterhashing-sql-asset-paths-are-dist-depth-fragile).

## Conventions

- **TypeScript:** interfaces named `I*` (e.g. `IClusterSettings`); default exports for singletons (`Logger`, `Redis`, `Metrics`, `config`, `Events`); 2-space indent.
- **Build:** `tsc -p tsconfig.build.json` only (target `es6`, module `commonjs`). No Babel, esbuild, or bundler.
- **Linting:** `tslint` is in deps but no `lint` script. Don't add one as part of feature work.
- **Layout:** new subsystems live under `src/<area>/`; their types go in `src/types/`.
- **Adding a metric:** see the "Adding a new metric" section of [docs/subsystems/metrics.md](docs/subsystems/metrics.md).

## Don't do this

- Don't refactor unrelated code while implementing a feature.
- Don't fix `README.md` to match V3 unless explicitly asked — a future `dev` → V3 merge owns that rewrite (see [docs/known-issues.md#12-readme-describes-dev-branch-api-not-v30](docs/known-issues.md#12-readme-describes-dev-branch-api-not-v30)).
- Don't add tests against the old (dev) API.
- Don't make breaking changes to the hashing helper schema (`assets/sql/create_hashing_database/`), and don't bump `ClusterHashing._databaseVersion`: older versions share the schema and would drop it back. Keep changes backward compatible and apply them to existing schemas in `ClusterHashing._upgradeInPlace()` — see [docs/subsystems/cluster-hashing.md](docs/subsystems/cluster-hashing.md).
- Don't commit `dist/` — it's gitignored; verify with `git check-ignore dist/` before staging anything generated.

## Docs index

Full human-facing index lives in [docs/README.md](docs/README.md). Quick map:

**Foundation**

- [docs/architecture.md](docs/architecture.md) — boot/runtime diagrams, singletons, lifecycle.
- [docs/configuration.md](docs/configuration.md) — zod schema, strict validation, `Settings.mixSettings` merge order.
- [docs/events.md](docs/events.md) — cluster/pool event catalog and the array-wrapping listener quirk.
- [docs/sql-assets.md](docs/sql-assets.md) — hashing-DB tables, routines, capacity caps, path resolution.
- [docs/testing.md](docs/testing.md) — Jest layout, which suites run, and the four stale suites.
- [docs/known-issues.md](docs/known-issues.md) — bugs/footguns with file:line refs and a fixed-in status where one landed.
- [docs/branch-divergence.md](docs/branch-divergence.md) — `dev` vs V3 API shapes side-by-side.
- [docs/glossary.md](docs/glossary.md) — Galera, validator, load factor, hashing, OpenTelemetry metric terms.

**Subsystems**

- [docs/subsystems/cluster.md](docs/subsystems/cluster.md) — `GaleraCluster` orchestration, pool selection, query flow.
- [docs/subsystems/pool.md](docs/subsystems/pool.md) — `Pool` lifecycle, query callback chain, multi-statement txns, events.
- [docs/subsystems/health-and-scoring.md](docs/subsystems/health-and-scoring.md) — `PoolStatus`, `Validator`, `LoadFactor`.
- [docs/subsystems/cluster-hashing.md](docs/subsystems/cluster-hashing.md) — service-to-node pinning, hashing DB, pool ordering.
- [docs/subsystems/redis-cache.md](docs/subsystems/redis-cache.md) — key derivation, TTL, stale fallback, `clearOnStart`.
- [docs/subsystems/metrics.md](docs/subsystems/metrics.md) — OpenTelemetry metrics, attributes, enabling an exporter, pm2 migration table.
- [docs/subsystems/logger.md](docs/subsystems/logger.md) — console logger, app-supplied `logger`, `LOGLEVEL`.
