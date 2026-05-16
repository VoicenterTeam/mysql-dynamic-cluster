# Subsystem: Health and Scoring

Each `Pool` carries a companion `PoolStatus` instance that decides, on a
self-adjusting timer, whether the underlying MySQL node is still
routable and how heavily loaded it is. The check is a single
`SHOW GLOBAL STATUS` query fed through two small evaluators —
`Validator` (boolean: is this pool still eligible?) and `LoadFactor`
(numeric: how loaded is it?). The output is consumed by
`GaleraCluster._getActivePools` when it picks a pool for the next
query; see [cluster.md](cluster.md) for the routing side.

Sources:
[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts),
[src/pool/Validator.ts](../../src/pool/Validator.ts),
[src/pool/LoadFactor.ts](../../src/pool/LoadFactor.ts),
[src/utils/Timer.ts](../../src/utils/Timer.ts).

Per-pool, single-threaded feedback: nothing in this subsystem talks to
other pools or shares state across the cluster. See [pool.md](pool.md)
for how `PoolStatus` is wired into a `Pool` and
[cluster.md](cluster.md) for how `_getActivePools` consumes
`isValid` and `loadScore`.

## `PoolStatus` state

[src/pool/PoolStatus.ts:16-48](../../src/pool/PoolStatus.ts#L16).

The public surface that `GaleraCluster` and `Pool` read from:

| Field | Kind | Source | Notes |
| --- | --- | --- | --- |
| `active` | `boolean` (mutable) | [:17](../../src/pool/PoolStatus.ts#L17) | Flipped to `true` by `Pool.connect()` (see [pool.md](pool.md)). The first thing `checkStatus()` does is `if (!this.active) return`, so the poll is a no-op until `Pool.connect()` runs. |
| `availableConnectionCount` | `number` (mutable) | [:18](../../src/pool/PoolStatus.ts#L18) | Maintained by `Pool._connectEvents` (see [pool.md](pool.md)). Decremented on `connection`, incremented on `release`. |
| `isValid` | `boolean` (getter over `_isValid`) | [:23-26](../../src/pool/PoolStatus.ts#L23) | Set by `Validator.check`. Initially `false` (line 23 and re-asserted on line 61) — a pool that has never been polled is not yet routable. |
| `queryTime` | `number` (getter over `_queryTime`) | [:28-31](../../src/pool/PoolStatus.ts#L28) | Wall-clock duration in seconds of the most recent `SHOW GLOBAL STATUS`, measured via `QueryTimer`. Set after both the success and the error branches of `checkStatus`. |
| `loadScore` | `number` (getter over `_loadScore`) | [:34-37](../../src/pool/PoolStatus.ts#L34) | Sum from `LoadFactor.check`. **Initial value is `100000`** (set in the constructor at [:62](../../src/pool/PoolStatus.ts#L62), overriding the field's `= 0`). A pool that has never been polled sorts last in `_getActivePools` — see [cluster.md](cluster.md). |

Private members worth knowing about:

- `_nextCheckTime: number = 10000` —
  [src/pool/PoolStatus.ts:43](../../src/pool/PoolStatus.ts#L43). Initial
  delay before the first re-check; hard-coded, not configurable. Note
  that `10000` is outside the default `timerCheckRange` of
  `{start: 5000, end: 15000}`, but the first poll fires via
  `await status.checkStatus()` inside `Pool.connect()` (see
  [pool.md](pool.md)) — only the *next* check uses this number, by
  which time the clamp on line 124 has already brought it into range.
- `timerCheckRange: ITimerCheckRange` —
  [:45](../../src/pool/PoolStatus.ts#L45). Defaults
  `{start: 5000, end: 15000}` ms from the convict schema
  ([src/configs/schema.ts:59-66](../../src/configs/schema.ts#L59)).
- `timerCheckMultiplier: number` —
  [:47](../../src/pool/PoolStatus.ts#L47). Default `1.3` from the
  schema
  ([src/configs/schema.ts:67-71](../../src/configs/schema.ts#L67)).
- `_validator: Validator`, `_loadFactor: LoadFactor`, `_timer: Timer` —
  constructed once and reused for the lifetime of the pool
  ([:64-69](../../src/pool/PoolStatus.ts#L64)).

## `checkStatus()`

[src/pool/PoolStatus.ts:84-111](../../src/pool/PoolStatus.ts#L84).

Async, idempotent against the `active` flag. Sequence on every tick:

1. Start a `QueryTimer(MetricNames.pool.queryTime)`.
2. Bail if `!this.active`
   ([:87](../../src/pool/PoolStatus.ts#L87)) — covers the window
   between `disconnect()` setting `active = false` and the timer
   actually firing.
3. Run `await this._pool.query('SHOW GLOBAL STATUS;', { redis: false })`
   ([:92](../../src/pool/PoolStatus.ts#L92)). `redis: false` is
   important: the status poll must never go through the Redis cache
   layer, or every pool would see the same cached snapshot.
4. End the timer and store it as `_queryTime` so the
   `query_time` custom validator key (below) can read it.
5. `this._isValid = this._validator.check(result)`
   ([:97](../../src/pool/PoolStatus.ts#L97)).
6. `this._loadScore = this._loadFactor.check(result)`
   ([:99](../../src/pool/PoolStatus.ts#L99)).
7. `this.nextCheckStatus()` — schedule the next tick on success.

If any step throws, the `catch` branch
([:103-110](../../src/pool/PoolStatus.ts#L103)) logs, still records
`_queryTime` (so a hanging node's slow poll is visible), and calls
`nextCheckStatus(true)` to schedule a *faster* re-check.

Note: a thrown error does **not** flip `_isValid` to `false`. The
previously-recorded `isValid` survives the failed poll, so a single
transient error does not immediately remove the pool from rotation —
but the bug in [known-issues.md#3](../known-issues.md#3-validatorcheck-crashes-on-missing-status-key)
means a missing status key throws *out of* `Validator.check`, which is
exactly the catch path that leaves `_isValid` stale.

## Adaptive timer

[src/pool/PoolStatus.ts:118-127](../../src/pool/PoolStatus.ts#L118).

```text
nextCheckStatus(downgrade = false):
    if downgrade:  _nextCheckTime /= timerCheckMultiplier   // poll faster after error
    else:          _nextCheckTime *= timerCheckMultiplier   // back off after success
    _nextCheckTime = clamp(_nextCheckTime, range.start, range.end)
    _timer.start(_nextCheckTime)
```

Clamp via [`Utils.clamp`](../../src/utils/Utils.ts#L9):
`Math.min(Math.max(num, min), max)`. With the defaults
(`multiplier = 1.3`, `range = {start: 5000, end: 15000}`), successful
polls walk the interval up from 10000 ms toward 15000 ms in 1.3x steps
and saturate; an error one tick later drops the interval to
`15000 / 1.3 ≈ 11538` ms and continues divisions until it saturates at
5000 ms.

**Rationale:** a healthy node should be polled rarely (every 15 s); a
failing or flapping node should be polled aggressively (every 5 s) so
the cluster sees it recover (or stay broken) quickly. The feedback
loop is purely per-pool — there is no cross-pool coordination, no
exponential cap beyond the clamp, and no jitter.

`Timer` itself is a one-shot wrapper: `start(time)` calls `setTimeout`,
the callback fires once, and `checkStatus` is responsible for calling
`nextCheckStatus` again to re-arm. `dispose()` clears the pending
timeout and flips `_active = false` so `start()` becomes a no-op
([src/utils/Timer.ts:29-41](../../src/utils/Timer.ts#L29)). The
`active` flag on `Timer` is **independent** of `PoolStatus.active` —
the former gates the timer, the latter gates `checkStatus` itself.

## `Validator`

[src/pool/Validator.ts:12-102](../../src/pool/Validator.ts#L12).

Takes an array of `IValidatorParams` shaped as
`{ key: string, operator: '>' | '<' | '=' | 'Like', value: string | number }`.
`Validator.check(result)` walks the array; the pool is valid iff
**every** validator matches (`validateCount === this._validators.length`
on [:51](../../src/pool/Validator.ts#L51)).

### Custom keys

Three keys short-circuit the SQL lookup and instead read straight off
the `PoolStatus`
([src/pool/Validator.ts:33-43](../../src/pool/Validator.ts#L33)):

| Validator key | Source |
| --- | --- |
| `available_connection_count` | `PoolStatus.availableConnectionCount.toString()` |
| `query_time` | `PoolStatus.queryTime.toString()` (the poll's own wall-clock) |
| `active` | `PoolStatus.active.toString()` (`"true"` / `"false"`) |

Every other key is looked up by `Variable_name` in the
`SHOW GLOBAL STATUS` row set
([:45](../../src/pool/Validator.ts#L45)):
`result.find(res => res.Variable_name === validator.key).Value`. The
trailing `.Value` is unguarded — a typo or a non-Galera MySQL flavor
that omits a `wsrep_*` row throws `TypeError`, which propagates out of
`check`. See
[known-issues.md#3](../known-issues.md#3-validatorcheck-crashes-on-missing-status-key).

### Operator semantics

`checkValueIsValid`
([src/pool/Validator.ts:60-101](../../src/pool/Validator.ts#L60))
inspects the *value from the database* first:

- If `isNaN(+value)` (i.e. the value parses as a string):
  - `=` does strict `===` equality
    ([:66-69](../../src/pool/Validator.ts#L66)).
  - `Like` checks substring via `indexOf(...) >= 0`
    ([:70-73](../../src/pool/Validator.ts#L70)) — there is no SQL
    wildcard support; it is plain substring.
  - `<` and `>` on string values log
    `"Operator <op> doesn't support for another type except number"`
    and return `false`
    ([:74-76](../../src/pool/Validator.ts#L74)).
- Otherwise the value is numeric:
  - The validator's `value` is coerced with `+validator.value`. If the
    coercion yields `NaN`, an error is logged and the validator returns
    `false`
    ([:82-85](../../src/pool/Validator.ts#L82)).
  - `<`, `=`, `>` do the obvious numeric comparison
    ([:87-97](../../src/pool/Validator.ts#L87)). `Like` is not in the
    numeric switch, so a `Like` on a numeric column silently returns
    `false`.

### Defaults

The schema defaults exercise both modes
([src/configs/schema.ts:42-50](../../src/configs/schema.ts#L42)):

- `{ key: 'wsrep_ready', operator: '=', value: 'ON' }` — string `=`.
- `{ key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' }` — string `=`.
- `{ key: 'Threads_running', operator: '<', value: 50 }` — numeric `<`.

A pool that returns `wsrep_ready=OFF`, `wsrep_local_state_comment` not
exactly `Synced`, or `Threads_running >= 50` is removed from
rotation until the next successful poll.

## `LoadFactor`

[src/pool/LoadFactor.ts:11-38](../../src/pool/LoadFactor.ts#L11).

Takes an array of `ILoadFactorParams` shaped as
`{ key: string, multiplier: number }`. `LoadFactor.check(result)`
returns a single number — the score:

```text
score = 0
for each loadFactor:
    value = result.find(row.Variable_name == loadFactor.key).Value
    if isNaN(+value) or !value: log error, contribute 0
    else: score += (+value) * loadFactor.multiplier
return score
```

Source:
[src/pool/LoadFactor.ts:25-37](../../src/pool/LoadFactor.ts#L25).

There is no normalisation, no clamp, and no upper bound — the score is
just a weighted sum of MySQL counters. Defaults
([src/configs/schema.ts:51-58](../../src/configs/schema.ts#L51)):

- `{ key: 'Connections', multiplier: 2 }` — cumulative connection
  count since the server started (monotonically increasing across
  uptime).
- `{ key: 'wsrep_local_recv_queue_avg', multiplier: 10 }` — Galera
  receive queue depth.

The `Connections` default is a *cumulative* counter, so `loadScore`
grows monotonically over the lifetime of the MySQL server even when
the actual load is flat. This is mainly a relative-comparison metric:
younger MySQL processes get less load until their counter catches up.

**Higher score ⇒ more loaded ⇒ sorted last** by
`GaleraCluster._getActivePools` (ascending sort by `loadScore`; see
[cluster.md](cluster.md)). The initial value of `100000` on a
never-polled pool is by design — it parks fresh pools at the back of
the rotation until at least one successful poll has produced a real
score.

### Crash on missing status key

`result.find(...).Value`
([src/pool/LoadFactor.ts:28](../../src/pool/LoadFactor.ts#L28)) is the
same unguarded dereference as `Validator`. A typo or a missing
status variable throws before the `isNaN(+value) || !value` check on
line 29 has a chance to run, aborting scoring for the affected pool
and falling into `checkStatus`'s catch branch — which means
`loadScore` stays at its previous value (or `100000` if no successful
poll has ever happened). See
[known-issues.md#4](../known-issues.md#4-loadfactorcheck-crashes-on-missing-status-key).
