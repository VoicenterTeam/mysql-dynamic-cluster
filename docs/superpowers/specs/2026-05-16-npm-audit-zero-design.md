# npm audit → zero vulnerabilities — Design

**Date:** 2026-05-16
**Branch:** V3.0
**Status:** Approved (brainstorming phase complete)
**Next step:** Implementation plan via `writing-plans` skill

## Purpose

Bring `@voicenter-team/mysql-dynamic-cluster` (V3.0 line) from **35 npm-audit
advisories** (5 critical, 11 high, 9 moderate, 10 low across 532 deps) down to
**0**, by upgrading the 4 direct dependencies that source those advisories. The
31 transitive vulns are expected to cascade-resolve as a side-effect of those
direct bumps; any stragglers are pinned via a `package.json` `overrides` block.

This work patches a critical RCE in mysql2 ([GHSA-67hx-6x53-jw92](https://github.com/advisories/GHSA-67hx-6x53-jw92))
and 4 other criticals plus 11 highs that currently affect this repo.

## Audience

- Primary: a future agent or developer executing the implementation plan.
- Secondary: reviewers verifying the commit chain on `V3.0`.

## Scope

In scope:

- Bump these direct deps in [package.json](../../../package.json):
  - `mysql2` `^2.3.0` → `^3.22.3` (critical RCE + 4 others).
  - `@pm2/io` `^5.0.0` → latest patched 5.x (high, via `semver`).
  - `@voicenter-team/failover-amqp-pool` `^1.4.2` → `^2.3.10` (moderate, via `nanoid`).
  - `jest` `^27.1.1` → `^30.x`, plus `@types/jest` and `ts-jest` to compatible majors.
- Any `src/` adjustments **forced** by a bump (e.g. mysql2 v2→v3 API drift in
  [src/pool/Pool.ts](../../../src/pool/Pool.ts), AMQP config shape changes
  consumed by [src/utils/Logger.ts](../../../src/utils/Logger.ts)).
- `package-lock.json` regeneration.
- A `package.json` `overrides` block if any transitive vuln remains after the
  direct bumps.

Out of scope:

- The test suite: it already doesn't compile on V3 (see
  [docs/testing.md](../../testing.md)). Rewriting it is a separate project.
- `README.md`: it's the dev-branch README; a future dev→V3 merge owns the
  rewrite. Per [CLAUDE.md](../../../CLAUDE.md), don't fix it here.
- CI, lint setup, ADRs.
- Fixing items catalogued in [docs/known-issues.md](../../known-issues.md).
- Adding new features or unrelated refactors. Bug fixes outside the upgrade
  fallout do not belong in these commits.

## Constraints & Principles

- **Each commit builds and smoke-tests cleanly.** A commit only lands once
  `npm run build` is clean AND `npm start` exercises connect → query →
  disconnect against the `.env`-configured DB without runtime errors. If a
  reachable DB isn't available, fall back to `tsc --build` only and call it
  out in the commit message.
- **One commit per direct dep + forced fixups.** Do not bundle upgrades.
  Sequential commits remain individually revertable.
- **All work on `V3.0`.** No cross-branch PRs; no work on `dev`.
- **Commit-message style matches existing V3 log:** lowercase, terse, present
  tense (e.g. `upgrade mysql2 to v3`, `pin transitive deps to clear audit`).
  No Claude-attribution co-author trailer (existing V3 commits don't use them).
- **Don't commit `dist/`.** It's gitignored; verify with
  `git check-ignore dist/` before staging.
- **Don't refactor unrelated code while upgrading.** Per
  [CLAUDE.md](../../../CLAUDE.md). If a bump exposes an existing issue from
  `docs/known-issues.md`, append a note there instead of fixing in scope.
- **Leave the `exchage` typo alone** in any config schema work — it's an
  intentional non-fix per the V3 conventions.

## Approach: sequential upgrades, biggest-risk-first

Order: **mysql2 → @pm2/io → failover-amqp-pool → jest → overrides cleanup.**

Rationale:

- **mysql2 first** — it's the critical RCE (CVSS ~9.x); patches the highest-
  severity surface earliest, and it's the bump most likely to require `src/`
  adjustments. Doing it first means later upgrades land on settled code.
- **@pm2/io second** — in-range patch within major 5; expected drop-in.
- **failover-amqp-pool third** — Voicenter internal; v1→v2 may shift the AMQP
  config shape consumed by Logger.
- **jest last** — dev-only, runtime-safe. Forces `@types/jest` and `ts-jest`
  along with it; isolates dev-toolchain churn from production code.

**Alternative considered (rejected):** safest-first ordering (`jest` →
`@pm2/io` → `failover-amqp-pool` → `mysql2`). Would prove the toolchain works
incrementally before tackling mysql2. Rejected because each commit is
independently revertable, so defensive ordering matters less than minimizing
time-to-patch for the critical RCE.

## Per-task plan (one commit each)

### Task A — mysql2 `^2.3.0` → `^3.22.3`

- Bump in [package.json](../../../package.json) `dependencies`; `npm install`.
- Read the mysql2 v3 changelog for default-behavior drift:
  `decimalNumbers`, `dateStrings`, `nestTables`, prepared-statement caching,
  default auth plugin handling.
- Audit call sites for API drift:
  - [src/pool/Pool.ts](../../../src/pool/Pool.ts) — `createPool`, callback
    `getConnection` / `changeUser` / `query` / `beginTransaction` / `commit`
    / `rollback` / `release` / `end`.
  - [src/cluster/GaleraCluster.ts:300-314](../../../src/cluster/GaleraCluster.ts#L300-L314)
    — `mysql.format()` / `mysql.escape()` from the `mysql2` top-level import.
  - [src/cluster/ClusterHashing.ts](../../../src/cluster/ClusterHashing.ts)
    — `multiStatementQuery` users; confirm `multipleStatements: true` is still
    the v3 option name.
- If a v3 default change alters runtime behavior (e.g. result-shape drift),
  set the option explicitly to preserve v2 behavior or append a new entry in
  [docs/known-issues.md](../../known-issues.md) describing the divergence.
- Verify: `npm run build` clean, `npm start` against `.env` DB.
- Commit: `upgrade mysql2 to v3`.

### Task B — @pm2/io `^5.0.0` → latest 5.x

- `npm install @pm2/io@latest`. Same major; expected drop-in (the advisory's
  vulnerable range is `4.3.4-beta.0 - 5.0.0` — any 5.0.1+ clears it).
- No source changes expected.
- Verify: `npm run build` clean, `npm start` shows metrics register without
  error (peek at demo logs).
- Commit: `upgrade @pm2/io to patched 5.x`.

### Task C — @voicenter-team/failover-amqp-pool `^1.4.2` → `^2.3.10`

- Bump; `npm install`. Inspect v2's exported `WinstonAMQPPoolTransport` and
  `IDefaultAmqpConfig` (imported in
  [src/utils/Logger.ts](../../../src/utils/Logger.ts)). Adjust the transport
  construction in `Logger.init()` if signatures or pool-entry shape changed.
- If `amqp_logs.*` schema keys move (`topic`, `connection_master`, `exchage`,
  `queue`, `bindings`, `prefetch` — see
  [src/configs/schema.ts:213-306](../../../src/configs/schema.ts#L213-L306)),
  update the schema. **Leave the `exchage` typo intact** if it persists in v2.
- Verify: `npm run build` clean, `npm start` with
  `logs.output=console,amqp` to exercise the AMQP path against a reachable
  broker (or skip the AMQP leg and document if no broker is available).
- Commit: `upgrade failover-amqp-pool to v2`.

### Task D — jest `^27.1.1` → `^30.x` (plus `@types/jest`, `ts-jest`)

- Bump `jest`, `@types/jest`, `ts-jest` to versions compatible with jest 30.
- Update [jest.config.js](../../../jest.config.js) if jest 28+/30 deprecated
  any config keys you use (e.g. `testEnvironment` defaults, reporter shape).
- **Don't rewrite tests.** Per [docs/testing.md](../../testing.md), they
  already fail to compile on V3 against the dev-shape API. Confirm the failure
  mode after the bump is still TypeScript compile errors against the V3
  schema — not "jest itself broke".
- Verify: `npm run build` clean (jest isn't on the build path, but ts-jest's
  type fork could regress); `npm test` exits with the same pre-existing
  compile-error class.
- Commit: `upgrade jest to v30`.

### Task E — overrides for residual transitives

- Re-run `npm audit`. For any remaining vuln, add a `package.json`
  `overrides` block pinning the fixed transitive (e.g.
  `"overrides": { "semver": "^7.5.2" }`).
- `npm install`; re-run `npm audit`; confirm "0 vulnerabilities".
- Verify: `npm run build` clean, `npm start` against the DB.
- Commit: `pin transitive deps to clear audit`.

## Verification (per task, before commit)

1. `npm install` completes without errors.
2. `npm run build` (= `tsc --build`) completes without errors.
3. `npm start` connects → queries → disconnects against the `.env`-configured
   DB without runtime errors. If no DB is reachable, skip step 3 and document
   in the commit message.
4. `npm audit` shows the targeted advisory has dropped off, and no new
   advisories surfaced.

## Success Criteria

- `npm audit` reports **0 vulnerabilities** at any severity.
- `npm run build` is clean.
- `npm start` exercises connect → query → disconnect end-to-end against a
  real Galera/MySQL node from `.env` without runtime errors.
- Diff is confined to: [package.json](../../../package.json),
  `package-lock.json`, and any `src/*` files whose APIs were directly forced
  by an upgrade. README, tests, CI, docs untouched (except an appended note in
  [docs/known-issues.md](../../known-issues.md) if a v3 default-behavior drift
  is uncovered).
- 4–5 commits land on `V3.0`, each independently revertable (one per direct
  dep + one for `overrides` if needed).

## Deliverables

- Bumped `package.json` and regenerated `package-lock.json`.
- Any forced `src/*` adjustments.
- Optional `overrides` block.
- This spec file, committed.
- A separate implementation-plan document produced by the `writing-plans`
  skill before any upgrades land.

## Out of Scope (explicit)

- Rewriting [tests/](../../../tests/) for V3 schema (separate project; see
  [docs/testing.md](../../testing.md)).
- Fixing items in [docs/known-issues.md](../../known-issues.md), including the
  `Pool.query` no-return-after-reject bug, `multiStatementQuery` commit
  ordering, `Validator` / `LoadFactor` crashes, `Events.emit` array-wrap,
  hashing TINYINT caps, `ClusterHashing` SQL-path fragility.
- README updates (the V3 README is the dev README; a future merge resolves).
- Adding `lint` / `typecheck` npm scripts, ESLint migration, or CI wiring.
- Opening GitHub issues for any audit fallout.

## Open Questions / Risks

- **DB reachable?** `npm start` verification requires a Galera/MySQL host in
  `.env` plus a `REDIS_HOST` for the Redis path. If unavailable, fall back to
  `tsc --build` and document in the commit message.
- **mysql2 v3 result-shape drift** could affect cached Redis payloads
  (cached v2 results have a different shape from v3 results, so stale entries
  may deserialize oddly). Mitigation: rely on `clearOnStart: true` for the
  first deploy after this work, or flag in known-issues.
- **failover-amqp-pool v2 changelog** is unread at design time. If its API
  has moved significantly, Task C may need more than the one-commit
  adjustment budgeted here.
- **`npm audit fix --force` is not used.** All bumps are done explicitly via
  `npm install <pkg>@<version>` so the diff stays inspectable.
