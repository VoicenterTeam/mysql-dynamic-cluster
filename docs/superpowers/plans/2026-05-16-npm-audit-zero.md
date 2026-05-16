# npm audit → zero vulnerabilities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `@voicenter-team/mysql-dynamic-cluster` (V3.0 line) from 35 npm-audit advisories to 0 by upgrading 4 direct dependencies and pinning any residual transitives via `overrides`.

**Architecture:** Sequential, one-commit-per-direct-dep on the `V3.0` branch. Order is biggest-risk-first: `mysql2` → `@pm2/io` → `@voicenter-team/failover-amqp-pool` → `jest` → `overrides` cleanup. Each commit must build (`npm run build`) and pass the demo smoke test (`node demo/index.js` against a `.env`-configured DB, killed after a fixed timeout) before landing.

**Tech Stack:** Node.js, TypeScript (target es6, module commonjs), mysql2, @pm2/io, winston, ioredis, jest + ts-jest, convict.

**Spec:** [docs/superpowers/specs/2026-05-16-npm-audit-zero-design.md](../specs/2026-05-16-npm-audit-zero-design.md)

**Branch:** `V3.0` (active). All commits land directly on `V3.0`.

---

## Conventions (apply to every task)

- **Commit-message style** matches existing V3 log: lowercase, terse, present tense (`upgrade mysql2 to v3`, `pin transitive deps to clear audit`). **No** Claude-attribution co-author trailer — existing V3 commits don't use them. Pass commit messages via `-m` heredoc.
- **Don't commit `dist/` or `node_modules/`.** They're gitignored. Verify with `git check-ignore dist/ node_modules/` before staging.
- **Don't touch tests in `tests/`** — they don't compile on V3 (see [docs/testing.md](../../testing.md)) and rewriting them is out of scope.
- **Don't fix [README.md](../../../README.md)** — it's the dev-branch README; a future merge owns the rewrite.
- **Don't refactor unrelated code** while upgrading. If a bump exposes an existing bug from [docs/known-issues.md](../../known-issues.md), append a note there but do not fix in this work.
- **Leave the `exchage` typo intact** in `config.get('amqp_logs.exchage')` if it persists in failover-amqp-pool v2 — it's documented convention.
- **No `npm audit fix --force`.** Apply every bump via explicit `npm install <pkg>@<version>` so the package.json diff stays inspectable.
- **Smoke test pattern** (used by every task that touches runtime code or runtime deps):
  ```bash
  npm run build
  # Run demo for 20s then kill. demo/index.js never calls cluster.disconnect(),
  # so it would otherwise hang forever.
  node demo/index.js > smoke.log 2>&1 &
  BGPID=$!
  sleep 20
  kill $BGPID 2>/dev/null
  cat smoke.log
  rm smoke.log
  ```
  Expected output in `smoke.log` includes lines like:
  - `Cluster completely created. Called from main program`
  - A JSON-like object dump from `SHOW GLOBAL STATUS` (the line `console.log(res[0])`)
  - The string value of `res[0].Variable_name` from the second query
  - **No unhandled error stack traces.**
- **DB unavailable fallback:** if `.env` has no reachable Galera/MySQL host, skip the smoke step for that task, replace it with `npm run build` only, and note `[smoke deferred: no DB in .env]` in the commit message.
- **Verification step in each task = re-read the audit output and the smoke log.** If anything regressed (new advisory, build error, runtime stack trace in `smoke.log`), fix or revert before committing.

---

## Task 0: Baseline verification

**Files:** read-only.

- [ ] **Step 1: Confirm working branch and tree state**

Run:
```bash
git rev-parse --abbrev-ref HEAD
git status --short
```
Expected: branch `V3.0`. Working tree should have at most the untracked items already known (`docs/superpowers/plans/` and the earlier `docs/superpowers/specs/2026-05-16-agent-onboarding-design.md`). If anything else is modified or staged, stop and surface to the user.

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install
```
Expected: completes; produces `node_modules/` and `package-lock.json` (lock may already exist; it's gitignored — verify with `git check-ignore package-lock.json` is **false** if it should be committed, or **true** if it should not). On this repo `package-lock.json` is **tracked** — confirm with `git ls-files package-lock.json` and re-stage it if it changes during this work.

- [ ] **Step 3: Capture baseline `npm audit` numbers**

Run:
```bash
npm audit --json > baseline-audit.json 2>/dev/null
node -e "const j=require('./baseline-audit.json');console.log(JSON.stringify(j.metadata.vulnerabilities,null,2))"
```
Expected output approximately:
```
{
  "info": 0,
  "low": 10,
  "moderate": 9,
  "high": 11,
  "critical": 5,
  "total": 35
}
```
If `total` differs materially from 35, that's fine — package metadata may have shifted since the design. Record the actual numbers in your task notes; the goal remains "0 at the end".

Then delete the baseline file (it's local-only):
```bash
rm baseline-audit.json
```

- [ ] **Step 4: Confirm baseline build passes**

Run:
```bash
npm run build
```
Expected: `tsc --build` completes cleanly. `dist/` is created. If the baseline build fails, stop — that's a pre-existing issue not introduced by this work.

- [ ] **Step 5: Capture baseline `npm test` failure mode**

Run:
```bash
npm test 2>&1 | head -40 > baseline-test-output.txt
head -40 baseline-test-output.txt
```
Expected: TypeScript compile errors from the V3-stale tests (e.g., references to `AmqpLoggerConfig`, `globalPoolSettings`, wrong arity on `new ClusterHashing(...)`). Save the first 40 lines aside mentally; you'll compare against this after Task 4 (jest bump). Then:
```bash
rm baseline-test-output.txt
```

- [ ] **Step 6: Confirm `.env` reachability**

Run:
```bash
test -f .env && echo "OK: .env present" || echo "NOTE: no .env — smoke will be skipped"
```
If `.env` is present, optionally:
```bash
node -e "require('dotenv').config(); console.log('hosts:', process.env.DB_HOST1, process.env.DB_HOST2, process.env.DB_HOST3)"
```
Decide whether smoke-testing is viable. Note the decision; it applies to Tasks 1–5.

**No commit for Task 0.**

---

## Task 1: Upgrade `mysql2` `^2.3.0` → `^3.22.3`

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json` (auto)
- Possibly modify: `src/pool/Pool.ts`, `src/cluster/GaleraCluster.ts`, `src/cluster/ClusterHashing.ts` (only if v3 forces signature changes)
- Possibly append: `docs/known-issues.md` (only if a v3 default-behavior drift is uncovered)

**Why this bump:** mysql2 ≤3.9.7 carries 5 advisories including a critical RCE via `readCodeFor` ([GHSA-4y9r-h6c2-2v2g](https://github.com/advisories/GHSA-4y9r-h6c2-2v2g)) and prototype pollution. mysql2 3.22.3 is the latest patched release.

**Known v3 changes to look for** (apply only if observed; this is a checklist, not a directive):
- `decimalNumbers` default changed for some result paths.
- `dateStrings` and `nestTables` behavior unchanged at the option level but result-shape can differ for `INFORMATION_SCHEMA` queries.
- `caching_sha2_password` (MySQL 8 default auth) — handled differently; the demo connects with `wsrep_*`-validated Galera nodes, so this is unlikely to affect the smoke.
- The `format` named export is still available (used in [src/cluster/GaleraCluster.ts:9](../../../src/cluster/GaleraCluster.ts#L9): `import { format as MySQLFormat } from 'mysql2'`).
- Callback-style `getConnection`, `changeUser`, `query`, `beginTransaction`, `commit`, `rollback`, `release`, `end` are all retained.
- `multipleStatements: true` option is still valid (used implicitly by [src/pool/Pool.ts:235-310](../../../src/pool/Pool.ts#L235-L310) via `pools[0].multiStatementQuery` in [src/cluster/ClusterHashing.ts:132-134](../../../src/cluster/ClusterHashing.ts#L132-L134)). Note: the createPool call in [src/pool/Pool.ts:73-80](../../../src/pool/Pool.ts#L73-L80) does **not** set `multipleStatements`. If hashing breaks under v3 and didn't under v2, that's a pre-existing latent bug, not a v3 regression.

- [ ] **Step 1: Pre-upgrade smoke baseline** *(only if `.env` is reachable; otherwise skip)*

Run the smoke pattern from the conventions block. Confirm `smoke.log` shows the two `SHOW GLOBAL STATUS` results without errors. Save the log content mentally as the "v2 baseline".

- [ ] **Step 2: Apply the bump**

Run:
```bash
npm install mysql2@^3.22.3
```
Expected: `package.json` `dependencies.mysql2` becomes `^3.22.3`; `package-lock.json` updated; no error output from `npm install`.

Verify the package.json change:
```bash
node -e "console.log(require('./package.json').dependencies.mysql2)"
```
Expected: `^3.22.3`.

- [ ] **Step 3: Build and audit-walk the source for forced changes**

Run:
```bash
npm run build
```

**If build is clean,** proceed to Step 4.

**If build errors,** read the error. Most likely candidates:
- Type errors at [src/pool/Pool.ts:40](../../../src/pool/Pool.ts#L40) (`private _pool: mysql.Pool;`) — mysql2 v3 may have refined this type; replace `mysql.Pool` with the correct imported type if needed.
- Type errors on `connection` parameter in [src/pool/Pool.ts:99-114](../../../src/pool/Pool.ts#L99-L114) — `PoolConnection` shape may have shifted.
- `MySQLFormat(sql, values)` in [src/cluster/GaleraCluster.ts:303-305](../../../src/cluster/GaleraCluster.ts#L303-L305) — the `format` function signature is `(sql: string, values?: any | any[] | { [param: string]: any })`. If v3 narrowed this, you may need to coerce string-`values` to array first: `MySQLFormat(sql, [values])`.

Fix each error with the **smallest possible change** that preserves intent. **Do not** rewrite the methods. After each fix, re-run `npm run build` until clean.

- [ ] **Step 4: Post-upgrade smoke** *(only if `.env` is reachable; otherwise skip)*

Run the smoke pattern:
```bash
node demo/index.js > smoke.log 2>&1 &
BGPID=$!
sleep 20
kill $BGPID 2>/dev/null
cat smoke.log
rm smoke.log
```
Expected: same observable output as v2 baseline. The `SHOW GLOBAL STATUS` result shape from `cluster.query` should still be an array of `{Variable_name, Value}` rows.

**Drift watch:** if `res[0]` looks different from baseline (e.g., row keys changed, encoding differs), that's a v3 default-behavior drift. Append a new entry to [docs/known-issues.md](../../known-issues.md) documenting the divergence — do **not** "fix" the source to compensate unless the demo throws.

- [ ] **Step 5: Audit re-check**

Run:
```bash
npm audit --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('Total:',j.metadata.vulnerabilities.total);console.log('mysql2 still present?',!!j.vulnerabilities.mysql2)})"
```
Expected: `mysql2 still present? false`. The total count should have dropped by ~5–10 (mysql2 + its critical transitives).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
# Stage any src/ files you actually had to modify in Step 3:
git add src/  # only paths that show in `git status` — review with `git status` first
git commit -m "upgrade mysql2 to v3"
```

Verify:
```bash
git status --short
git log --oneline -1
```
Expected: clean working tree; top commit is `upgrade mysql2 to v3`.

---

## Task 2: Upgrade `@pm2/io` `^5.0.0` → `^6.1.0`

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json` (auto)
- Possibly modify: `src/metrics/Metrics.ts` (deep-import paths may shift)

**Why this bump:** `@pm2/io` ≤5.0.0 has a high-severity advisory via its `semver` dep. The current `latest` is **6.1.0** — this is a major version bump, **not** a patched 5.x as the design originally framed it. Treat it as a deliberate major upgrade.

**Known concern:** [src/metrics/Metrics.ts:8-12](../../../src/metrics/Metrics.ts#L8-L12) deep-imports from `@pm2/io/build/main/utils/metrics/...`:

```ts
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Counter from "@pm2/io/build/main/utils/metrics/counter";
import Meter from "@pm2/io/build/main/utils/metrics/meter";
import { MetricMeasurements } from "@pm2/io/build/main/services/metrics";
import Histogram from "@pm2/io/build/main/utils/metrics/histogram";
```

These bypass the published `exports` map and rely on the v5 internal layout. The v6 internal layout may differ. The top-level `pm2io.counter/meter/gauge/histogram/metric` API (used in [src/metrics/Metrics.ts:169-188](../../../src/metrics/Metrics.ts#L169-L188)) is more stable.

- [ ] **Step 1: Apply the bump**

Run:
```bash
npm install @pm2/io@^6.1.0
```
Expected: `package.json` `dependencies.@pm2/io` becomes `^6.1.0`.

Verify:
```bash
node -e "console.log(require('./package.json').dependencies['@pm2/io'])"
```
Expected: `^6.1.0`.

- [ ] **Step 2: Build**

Run:
```bash
npm run build
```

**If build is clean,** skip to Step 4.

**If build errors on the deep-import lines,** the v6 internal layout has shifted. Diagnose:
```bash
ls node_modules/@pm2/io/build/main/utils/metrics/ 2>/dev/null
ls node_modules/@pm2/io/build/main/services/ 2>/dev/null
```

Two fix options, in preference order:

**Option A (preferred): drop the deep imports, type via the public API.**

Edit [src/metrics/Metrics.ts:8-12](../../../src/metrics/Metrics.ts#L8-L12). Replace the five deep imports with the inferred return types of the `pm2io.*` factories. The simplest safe change is to type the repository values as `any` (since they're used internally and the public method signatures of `inc()/set()/mark()/update()` are what consumers see):

```ts
// before:
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Counter from "@pm2/io/build/main/utils/metrics/counter";
import Meter from "@pm2/io/build/main/utils/metrics/meter";
import { MetricMeasurements } from "@pm2/io/build/main/services/metrics";
import Histogram from "@pm2/io/build/main/utils/metrics/histogram";

// after:
type Gauge = ReturnType<typeof pm2io.metric>;
type Counter = ReturnType<typeof pm2io.counter>;
type Meter = ReturnType<typeof pm2io.meter>;
type Histogram = ReturnType<typeof pm2io.histogram>;
// MetricMeasurements is used as MetricMeasurements.mean — check the public types:
//   if pm2io.histogram's option type exports a `measurement` enum, use it; else:
const HISTOGRAM_MEAN = 'mean' as const;
```

Then update [src/metrics/Metrics.ts:186](../../../src/metrics/Metrics.ts#L186) from `measurement: MetricMeasurements.mean` to `measurement: HISTOGRAM_MEAN as any`.

**Option B (if Option A doesn't compile): find the new v6 paths.**

Run:
```bash
find node_modules/@pm2/io -name "gauge*" -o -name "counter*" -o -name "meter*" -o -name "histogram*" 2>/dev/null | head -20
```
Adjust the import paths to match. This couples to v6 internals but is the least-invasive fix.

Re-run `npm run build` after fixes until clean.

- [ ] **Step 3: Optional — `pm2/io` API surface check**

If you modified `Metrics.ts`, sanity-check that `pm2io.counter({name})` still returns an object with `.inc()`, etc.:
```bash
node -e "const p=require('@pm2/io'); const c=p.counter({name:'x'}); console.log(typeof c.inc, typeof p.meter({name:'y'}).mark, typeof p.histogram({name:'z'}).update, typeof p.metric({name:'w'}).set)"
```
Expected: `function function function function`. If any is `undefined`, the v6 API has shifted further — flag to the user before proceeding.

- [ ] **Step 4: Smoke** *(only if `.env` is reachable; otherwise skip)*

Run the smoke pattern. Verify `smoke.log` shows clean run and no `Logger.error("Metric type ... doesn't exist")` or pm2 stack traces.

- [ ] **Step 5: Audit re-check**

Run:
```bash
npm audit --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('Total:',j.metadata.vulnerabilities.total);console.log('@pm2/io direct present?',!!j.vulnerabilities['@pm2/io'])})"
```
Expected: `@pm2/io direct present? false`. The total count should have dropped. (A nested `@pm2/io@5` under `failover-amqp-pool` may still appear as transitive — that's expected and addressed in Task 5.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git add src/metrics/Metrics.ts  # only if you modified it
git commit -m "upgrade @pm2/io to v6"
```

Verify:
```bash
git log --oneline -2
```

---

## Task 3: Upgrade `@voicenter-team/failover-amqp-pool` `^1.4.2` → `^2.3.10`

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json` (auto)
- Possibly modify: `src/utils/Logger.ts` (transport import path + construction)
- Possibly modify: `src/types/AmqpInterfaces.ts` (if `IDefaultAmqpConfig` source moved or shape changed)
- Possibly modify: `src/configs/schema.ts` (if `amqp_logs.*` keys renamed)

**Why this bump:** v1.x is affected by a moderate `nanoid` advisory. v2.3.10 is the latest.

**Known concern:** [src/utils/Logger.ts:2](../../../src/utils/Logger.ts#L2) imports the transport via a deep path:
```ts
import winstonTransport from '@voicenter-team/failover-amqp-pool/WinstonAMQPPoolTransport';
```
v2's package shape may have moved this. [src/utils/Logger.ts:5](../../../src/utils/Logger.ts#L5) imports `IDefaultAmqpConfig` from `../types/AmqpInterfaces` (local). [src/utils/Logger.ts:40-53](../../../src/utils/Logger.ts#L40-L53) constructs:

```ts
const amqpConfig: IDefaultAmqpConfig = {
  topic: config.get('amqp_logs.topic'),
  pool: []
};
amqpConfig.pool.push({
  connection: config.get('amqp_logs.connection_master'),
  channel: {
    exchange: config.get('amqp_logs.exchage'),  // ← typo preserved intentionally
    queue: config.get('amqp_logs.queue'),
    binding: config.get('amqp_logs.bindings'),
    prefetch: config.get('amqp_logs.prefetch')
  }
});
this.logger.add(new winstonTransport(amqpConfig));
```

Both the deep `/WinstonAMQPPoolTransport` import path and the `IDefaultAmqpConfig` shape are likely-to-move. **Preserve the `exchage` typo** if the schema/transport still accepts it (it's a documented quirk).

- [ ] **Step 1: Apply the bump**

```bash
npm install @voicenter-team/failover-amqp-pool@^2.3.10
```

Verify:
```bash
node -e "console.log(require('./package.json').dependencies['@voicenter-team/failover-amqp-pool'])"
```
Expected: `^2.3.10`.

- [ ] **Step 2: Inspect v2's exports**

```bash
node -e "const p=require('@voicenter-team/failover-amqp-pool'); console.log('keys:', Object.keys(p))"
ls node_modules/@voicenter-team/failover-amqp-pool/
cat node_modules/@voicenter-team/failover-amqp-pool/package.json | head -40
```
Look for:
- A top-level export named something like `WinstonAMQPPoolTransport` or `WinstonTransport`.
- A `main` / `exports` field that may have moved the transport to a different sub-path.
- Type declarations exporting an `IDefaultAmqpConfig` (or renamed equivalent).

- [ ] **Step 3: Build, observe errors**

```bash
npm run build
```

**If build is clean,** skip to Step 5.

**If the deep import in `src/utils/Logger.ts:2` errors,** adjust based on Step 2 findings. Try in this order:

1. **Top-level import:**
   ```ts
   import { WinstonAMQPPoolTransport } from '@voicenter-team/failover-amqp-pool';
   ```
   and rename usages of `winstonTransport` to `WinstonAMQPPoolTransport`.

2. **Sub-path that matches v2 layout** (use whatever path Step 2 surfaced), e.g.:
   ```ts
   import winstonTransport from '@voicenter-team/failover-amqp-pool/dist/WinstonAMQPPoolTransport';
   ```

3. **If `IDefaultAmqpConfig` no longer comes from the local types file** (because v1 was the source via a re-export, now removed):
   ```ts
   import type { IDefaultAmqpConfig } from '@voicenter-team/failover-amqp-pool';
   ```
   Delete the now-unused import from `../types/AmqpInterfaces` in `src/utils/Logger.ts:5`.

**If the construction shape (Logger.ts:40-53) errors**, the v2 config type may have renamed:
- `pool[].channel.exchange` → check if v2 wants `exchange` only (the schema key `amqp_logs.exchage` stays — only the *destination* property on the transport may have a different name).
- `pool[].channel.binding` (singular) → may be `bindings` (plural) in v2 to match the schema; check v2's type and adjust the *property name* on the constructed object only.

For each fix:
- Adjust only the field name being read or assigned.
- **Do not** touch `src/configs/schema.ts` unless v2 outright rejects a value of the current shape at runtime.
- **Do not** fix the `exchage` typo in `schema.ts` or in `config.get('amqp_logs.exchage')`.

Re-run `npm run build` until clean.

- [ ] **Step 4: AMQP-side smoke** *(optional — only run if you have a reachable AMQP broker)*

Without an AMQP broker the existing `LOGTYPES_OUTPUT=console` (default) path is exercised by Step 5's smoke. To exercise the AMQP transport specifically you'd need a running broker plus `.env` overrides. **Skip this if no broker is available** — note in the commit message: `[amqp leg unverified: no broker]`.

- [ ] **Step 5: Smoke** *(only if `.env` is reachable; otherwise skip)*

Run the smoke pattern. Expected: no winston / amqp stack traces in `smoke.log`. The default config has `logs.output = 'console'` and `useAmqpLogger` unset, so the AMQP branch in `Logger.init()` doesn't even execute — the smoke just confirms the build + import path still resolve at runtime.

- [ ] **Step 6: Audit re-check**

```bash
npm audit --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('Total:',j.metadata.vulnerabilities.total);console.log('failover-amqp-pool direct present?',!!j.vulnerabilities['@voicenter-team/failover-amqp-pool'])})"
```
Expected: `failover-amqp-pool direct present? false`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git add src/utils/Logger.ts  # only if modified
# Only add these if you actually had to modify them:
# git add src/types/AmqpInterfaces.ts
# git add src/configs/schema.ts
git commit -m "upgrade failover-amqp-pool to v2"
```

---

## Task 4: Upgrade `jest` `^27.1.1` → `^30.4.2` (+ `@types/jest`, `ts-jest`)

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `package-lock.json` (auto)
- Possibly modify: `jest.config.js` (deprecated keys)

**Why this bump:** `jest@^27` carries low-severity transitive vulns (`@tootallnate/once`, `jest-environment-jsdom`/jsdom chain). `jest@30.4.2` is current latest and clears those.

**Version compatibility (verified via npm registry):**
- `jest@30.4.2` works with `ts-jest@^29.0.0` (peer accepts `^29 || ^30`). There is no `ts-jest@30` yet (latest is `29.4.9`).
- `@types/jest@30.0.0` matches `jest@30`.

**Pre-existing constraint:** `tests/` does not compile against V3 (see [docs/testing.md](../../testing.md)). `npm test` is expected to **continue failing** with TypeScript compile errors — the goal here is *same failure class*, not green tests.

- [ ] **Step 1: Capture pre-upgrade `npm test` first-error class**

```bash
npm test 2>&1 | head -20 > test-before.txt
head -20 test-before.txt
```
Expected: TS compile errors against the V3-stale tests (typical: `Cannot find name 'AmqpLoggerConfig'`, `Property 'globalPoolSettings' does not exist on type 'IUserSettings'`, wrong arity on `new ClusterHashing(...)`).

- [ ] **Step 2: Apply the bumps**

```bash
npm install --save-dev jest@^30.4.2 @types/jest@^30.0.0 ts-jest@^29.4.9
```
Verify:
```bash
node -e "const d=require('./package.json').devDependencies; console.log({jest:d.jest, types:d['@types/jest'], tsjest:d['ts-jest']})"
```
Expected: `{ jest: '^30.4.2', types: '^30.0.0', tsjest: '^29.4.9' }`.

- [ ] **Step 3: Run `npm test` and capture new first-error class**

```bash
npm test 2>&1 | head -30 > test-after.txt
head -30 test-after.txt
```

**Verify the failure class is unchanged.** Compare:
```bash
diff <(grep -oE "(error TS[0-9]+|Cannot find|does not exist|expected [0-9]+ arguments)" test-before.txt | sort -u) <(grep -oE "(error TS[0-9]+|Cannot find|does not exist|expected [0-9]+ arguments)" test-after.txt | sort -u)
```

**Expected result:** the failure-mode signatures should be ≈identical (TypeScript compile errors against V3-stale tests). If `npm test` instead crashes with a jest runtime error (e.g. `Jest configuration is invalid`, `expect(...).toEqual is not a function`), that's a real regression — proceed to Step 4.

Then:
```bash
rm test-before.txt test-after.txt
```

- [ ] **Step 4: Adjust `jest.config.js` if needed**

If Step 3 surfaced a jest-runtime regression (not the pre-existing TS compile errors), inspect:

[jest.config.js](../../../jest.config.js):
```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleDirectories: ['node_modules'],
  testPathIgnorePatterns: ['dist', 'tests/loads'],
  testTimeout: 300000,
  collectCoverageFrom: [ /* ... */ ],
  coverageThreshold: { global: { branches: 10, functions: 10, lines: 10, statements: 10 } }
};
```

Possible jest-30 changes to apply (only if needed):

- **`collectCoverageFrom` glob `"**/*.{ts}"`** — the `{ts}` brace pattern is degenerate (a single-element brace). Jest 30 may stricter-parse it. If it errors, change to `"**/*.ts"`.
- **`preset: 'ts-jest'`** — ts-jest 29 still ships this preset; should remain valid.
- **`testEnvironment: 'node'`** — still valid.

Re-run `npm test` after each adjustment until the failure mode matches the pre-upgrade class.

- [ ] **Step 5: Build sanity check**

```bash
npm run build
```
Expected: still clean (jest doesn't participate in the build, but ts-jest's bundled TypeScript fork could theoretically clash — confirm).

- [ ] **Step 6: Audit re-check**

```bash
npm audit --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('Total:',j.metadata.vulnerabilities.total);console.log('jest direct present?',!!j.vulnerabilities.jest)})"
```
Expected: `jest direct present? false`. Most low/moderate transitive entries under `jest-environment-jsdom`, `jsdom`, `jest-config`, `jest-cli`, `@jest/core`, `@tootallnate/once`, `http-proxy-agent` should also clear.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git add jest.config.js  # only if modified
git commit -m "upgrade jest to v30"
```

---

## Task 5: Pin residual transitives with `overrides`

**Files:**
- Modify: `package.json` (add `overrides` block)
- Modify: `package-lock.json` (auto)

**Why:** After Tasks 1–4, some transitive vulns will remain. Most likely candidates:
- `@pm2/io@^5.x` nested under `@voicenter-team/failover-amqp-pool@2.3.10` (failover-amqp-pool's `dependencies` list `@pm2/io: ^5.0.2`, not `^6`).
- `semver` nested under that nested `@pm2/io@5`.
- Possibly `nanoid` nested under older transitive paths.

`overrides` instructs npm to substitute a different version for any matching transitive without forking the upstream package's `dependencies`.

- [ ] **Step 1: Survey residuals**

```bash
npm audit --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const list=Object.entries(j.vulnerabilities).map(([n,x])=>({name:n,severity:x.severity,direct:x.isDirect,via:x.via.map(v=>typeof v==='string'?v:v.title).slice(0,1),fix:!!x.fixAvailable}));console.log(JSON.stringify(list,null,2));console.log('TOTAL:',j.metadata.vulnerabilities.total)})"
```

For each remaining advisory:
- Note the **package name** and the **fixed range** (visible from `npm audit` text output or the advisory URL).
- Confirm it's transitive (`direct: false`) — if a direct dep is still flagged, return to Tasks 1–4.

- [ ] **Step 2: Build the `overrides` block**

For each package that needs pinning, add an entry. Typical shape (illustrative — substitute the actual package list from Step 1):

```json
"overrides": {
  "@pm2/io": "^6.1.0",
  "semver": "^7.5.2",
  "nanoid": "^5.1.6"
}
```

Edit [package.json](../../../package.json) and add `overrides` as a top-level key. Place it **after** `devDependencies`:

```json
{
  "dependencies": { /* ... */ },
  "devDependencies": { /* ... */ },
  "overrides": {
    /* the entries from above */
  }
}
```

**Rules:**
- Only pin packages flagged by `npm audit`. Don't pin speculatively.
- Use the **lowest version that clears the advisory** (per the advisory's "Patched in" field) — don't jump to a major version unless required.
- If a transitive dep has multiple consumers with conflicting constraints, npm will warn at install time. In that case, use a scoped override:
  ```json
  "overrides": {
    "failover-amqp-pool": {
      "@pm2/io": "^6.1.0"
    }
  }
  ```

- [ ] **Step 3: Reinstall to apply overrides**

```bash
npm install
```
Expected: completes; `package-lock.json` regenerated with the pinned versions.

- [ ] **Step 4: Audit re-check**

```bash
npm audit
```
Expected: `found 0 vulnerabilities`. Or:
```bash
npm audit --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(JSON.stringify(j.metadata.vulnerabilities,null,2))})"
```
Expected: `total: 0`.

**If non-zero:** loop back to Step 2 with the surviving advisories.

- [ ] **Step 5: Build + smoke**

```bash
npm run build
```
Expected: clean.

Run the smoke pattern *(only if `.env` is reachable)*. Expected: same observable output as Task 1's post-upgrade smoke — overrides should not change runtime behavior.

- [ ] **Step 6: Commit**

If overrides were needed:
```bash
git add package.json package-lock.json
git commit -m "pin transitive deps to clear audit"
```

If `npm audit` was already 0 after Task 4 (no overrides needed), **skip the commit** and proceed to Task 6.

---

## Task 6: Final verification

**Files:** read-only.

- [ ] **Step 1: Confirm `npm audit` is 0**

```bash
npm audit
```
Expected: `found 0 vulnerabilities`.

- [ ] **Step 2: Confirm `npm run build` is clean**

```bash
npm run build
```
Expected: no errors.

- [ ] **Step 3: Confirm `npm test` failure mode is unchanged**

```bash
npm test 2>&1 | head -10
```
Expected: same V3-stale TS compile errors that existed pre-Task-4. The point is verifying we didn't accidentally make tests *crash* (jest runtime error) while also not making them *pass* (out of scope).

- [ ] **Step 4: Final smoke** *(only if `.env` is reachable)*

Run the smoke pattern one more time. Verify `smoke.log` shows two `SHOW GLOBAL STATUS` query results without errors, just like Task 0's baseline.

- [ ] **Step 5: Inspect commit chain**

```bash
git log --oneline V3.0~10..V3.0 | head -10
```
Expected (most recent first):
```
xxxxxxx pin transitive deps to clear audit       # only if Task 5 produced a commit
xxxxxxx upgrade jest to v30
xxxxxxx upgrade failover-amqp-pool to v2
xxxxxxx upgrade @pm2/io to v6
xxxxxxx upgrade mysql2 to v3
xxxxxxx docs: add npm-audit-zero brainstorming spec
```
4–5 audit commits, plus the spec commit, plus the plan commit if you committed this plan.

- [ ] **Step 6: Confirm scope was respected**

```bash
git diff V3.0~6..V3.0 -- README.md tests/ assets/ ecosystem.config.js tsconfig.json tslint.json .env.example
```
Expected: **empty** diff. None of these were supposed to change.

```bash
git diff V3.0~6..V3.0 --stat
```
Expected: changes confined to `package.json`, `package-lock.json`, possibly a few `src/*.ts` files (only those whose APIs were forced by an upgrade), and possibly `docs/known-issues.md` (only if a v3 default-behavior drift was uncovered).

- [ ] **Step 7: Stop**

No commit for Task 6. If any of Steps 1–6 failed, surface to the user. If all passed, the work is complete.

---

## Self-review checklist (for plan author — executed inline)

1. **Spec coverage:** every spec section maps to a task:
   - "Scope" → Tasks 1–5 (in/out scope respected); Task 6 Step 6 verifies untouched paths.
   - "Constraints & Principles" → Conventions block at top.
   - "Approach: sequential upgrades, biggest-risk-first" → Task order 1 → 2 → 3 → 4 → 5.
   - "Per-task plan (A–E)" → Tasks 1–5 each carry the spec's task content + concrete steps.
   - "Verification (per task, before commit)" → each task's Step "Build / Smoke / Audit re-check".
   - "Success Criteria" → Task 6 Steps 1–6.
   - "Open Questions / Risks" → DB-reachability fallback baked into every smoke step; mysql2 result-shape drift mentioned in Task 1 Step 4.

2. **Placeholder scan:**
   - No `TBD`, `TODO`, `implement later`, `similar to Task N`, or hand-wavy "handle edge cases".
   - Every step that changes code shows the code (or the bounded set of "fix in this order" options for unknown v6/v2 internals).
   - Every command is exact. Every expected output is named.

3. **Type / identifier consistency:**
   - The smoke pattern is defined once in Conventions and referenced by each task.
   - `cluster.query` / `cluster.connect` / `cluster.disconnect` usage matches `demo/index.js`.
   - `IDefaultAmqpConfig`, `WinstonAMQPPoolTransport`, `amqp_logs.exchage` (preserved typo) referenced consistently across Task 3.
   - `pm2io.counter`/`meter`/`gauge`/`histogram`/`metric` matches the public API used in `Metrics._createMetric`.

4. **Order safety:**
   - Task 0 establishes baseline; Tasks 1–5 each depend only on the previous task's tree state.
   - Task 5 (overrides) explicitly references that nested `@pm2/io@5` under `failover-amqp-pool` is expected residual — won't surprise the executor.
   - Task 6 cross-checks the full chain.

5. **Adjustments from spec:**
   - **Task 2 framing corrected:** spec called this "latest patched 5.x"; reality is `@pm2/io@6.1.0` is a major bump. Plan reflects this with a deeper "Possibly modify Metrics.ts" footnote and a deep-import fallback strategy.
   - **Task 5 expectation set:** nested `@pm2/io@5` under failover-amqp-pool is called out as expected residual to be cleared via `overrides`.

If any spec requirement turns out to lack a task during execution, the executor should surface to the user rather than improvise.
