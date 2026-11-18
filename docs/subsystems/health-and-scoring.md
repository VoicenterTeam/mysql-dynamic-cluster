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

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

The public surface that `GaleraCluster` and `Pool` read from:

| Field | Kind | Source | Notes |
| --- | --- | --- | --- |
| `active` | `boolean` (mutable) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Set to `true` by `startTimerCheck()`, which `Pool.connect()` calls (see [pool.md](pool.md)), and to `false` by `Pool.disconnect()`. The first thing `checkStatus()` does is `if (!this.active) return`, so the poll is a no-op until `Pool.connect()` runs. |
| `availableConnectionCount` | `number` (getter) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Returns `Pool.availableConnectionCount`: `connectionLimit` minus connections in use, read from mysql2's own lists (see [pool.md](pool.md)). |
| `isValid` | `boolean` (getter over `_isValid`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Set by `Validator.check`. Initially `false` (the field default, re-asserted in the constructor) — a pool that has never been polled is not yet routable. |
| `queryTime` | `number` (getter over `_queryTime`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Wall-clock duration in seconds of the most recent `SHOW GLOBAL STATUS`, measured via `QueryTimer`. Set after both the success and the error branches of `checkStatus`. |
| `loadScore` | `number` (getter over `_loadScore`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Sum from `LoadFactor.check`. **Initial value is `100000`** (set in the constructor at [PoolStatus.ts](../../src/pool/PoolStatus.ts), overriding the field's `= 0`). A pool that has never been polled sorts last in `_getActivePools` — see [cluster.md](cluster.md). |
| `checkError` | `INodeCheckError \| undefined` (getter over `_checkError`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Since 4.6.0. What the last check failed with, reduced to `code`, `errno` and `sqlState`. `undefined` before the first check and after a check whose query ran. A new object on every read. See [The error of the last check](#the-error-of-the-last-check). |

Private members worth knowing about:

- `_nextCheckTime: number = 10000` —
  [src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts). Initial
  delay before the first re-check; hard-coded, not configurable. Note
  that `10000` is outside the default `timerCheckRange` of
  `{start: 5000, end: 15000}`, but the first poll fires via
  `await status.checkStatus()` inside `Pool.connect()` (see
  [pool.md](pool.md)) — only the *next* check uses this number, by
  which time the clamp in `nextCheckStatus` has already brought it into range.
- `timerCheckRange: ITimerCheckRange` —
  [PoolStatus.ts](../../src/pool/PoolStatus.ts). Defaults
  `{start: 5000, end: 15000}` ms from the settings schema
  ([src/configs/schema.ts](../../src/configs/schema.ts)).
- `timerCheckMultiplier: number` —
  [PoolStatus.ts](../../src/pool/PoolStatus.ts). Default `1.3` from the
  schema
  ([src/configs/schema.ts](../../src/configs/schema.ts)).
- `_validator: Validator`, `_loadFactor: LoadFactor`, `_timer: Timer` —
  constructed once and reused for the lifetime of the pool
  ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).

## `checkStatus()`

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

Async, idempotent against the `active` flag. Sequence on every tick:

1. Start a `QueryTimer`.
2. Bail if `!this.active`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)) — covers the window
   between `disconnect()` setting `active = false` and the timer
   actually firing.
3. Run `await this._pool.query('SHOW GLOBAL STATUS;', { redis: false })`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)). `redis: false` is
   important: the status poll must never go through the Redis cache
   layer, or every pool would see the same cached snapshot.
4. End the timer and store it as `_queryTime` so the
   `query_time` custom validator key (below) can read it.
5. `this._isValid = this._validator.check(result)`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).
6. `this._loadScore = this._loadFactor.check(result)`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).
7. `this.nextCheckStatus()` — schedule the next tick on success.

If any step throws, the `catch` branch
([PoolStatus.ts](../../src/pool/PoolStatus.ts)) logs, still records
`_queryTime` (so a hanging node's slow poll is visible), and calls
`nextCheckStatus(true)` to schedule a *faster* re-check.
Last, it emits `pool_check_failed` with the error and the pool id, so the app can read the
error's `code` and `errno`; see [events.md](../events.md#a-failed-health-check).

Since 3.2.2 the `catch` also counts failures in a row (`_failedChecks`).
The **second** failed check in a row sets `_isValid = false`; a single
failure (network blip, proxy restart, DNS) keeps the last `isValid` so one
bad poll doesn't take the node out of rotation. A passing check resets the
counter and assigns `_isValid` from the validator again. Before 3.2.2 a
failed check never touched `_isValid`, so a node whose checks all failed
stayed in rotation.

Every check that ends is recorded as the metric
`mysql_dynamic_cluster.health_check.duration`, with the result `valid`,
`invalid` or `error`. The success branch records it as its last step, after
`nextCheckStatus()`, and the `catch` branch right after it stored
`_queryTime`. A check that was dropped and a check that did not run record
nothing. `isValid` and `loadScore` are also published, as the gauges
`mysql_dynamic_cluster.node.valid` and
`mysql_dynamic_cluster.node.load_score`. See
[metrics.md](./metrics.md#health-check-metric).

When every node is invalid, `GaleraCluster` throws
`"There is no pool that satisfies the parameters"` before the Redis cache
lookup — the reason one failed check isn't enough to drop a node.

The whole check has one timeout, `min(queryTimeout, timerCheckRange.end)`
(15 s with the defaults; `queryTimeout: 0` means no query timeout, so the
check then uses `timerCheckRange.end`). `checkStatus` races the status
query against that timer, so it also covers waiting for a free connection
(mysql2's `getConnection` queue has no timer) and a hung server. A check
slower than that counts as failed. The same value is also passed as the
query's own timeout, so a hung connection is destroyed.

A missing status key no longer throws: `Validator.check` logs the key by
name and that validator fails, so the pool is marked invalid (see
[known-issues.md#3](../known-issues.md#3-validatorcheck-crashes-on-missing-status-key)).

### The error of the last check

Since 4.6.0 `PoolStatus` keeps what the last check failed with, and
`checkError` hands it out. `GaleraCluster` reads it through
`Pool.checkError` for `nodes()`. The results of `ready` and `firstReady`
take the outcome of the check of their own connect instead, see below. The
contract is in [../node-api.md](../node-api.md#checkerror).

- The `catch` branch sets it, before it logs. The value is the error the
  status query was rejected with, reduced by `_reduce`: `code` when it is a
  string, `errno` when it is an integer, `sqlState` when it is a string.
  The message is never taken. The reduction is done once, at that moment,
  so a later change of the error object does not show.
- The success branch clears it as soon as the query ran, before the
  validators are asked. So it is cleared also when a validator then says no.
- A check that is dropped because it outlived `stopTimerCheck()` neither
  sets nor clears it.
- `stopTimerCheck()` does not clear it. It keeps its value over a
  `disconnect()`, as `isValid` does.

`checkStatus(outcome?)` also tells a caller how this one check ended. The
caller hands in an object. A check that is recorded, in either branch, sets
`recorded: true` on it, and the `catch` branch adds a copy of the reduced
error as `checkError`. A check that is dropped, and a call while the status
is not active, leave the object as it was. `Pool.connect()` passes the object
of its own caller through, so `GaleraCluster` can put the error of exactly
that check on a result of `ready` and `firstReady`. The timer calls
`checkStatus()` with no object.

Only values that mysql2, the socket or the server produced are kept. The
value is an empty object in these cases:

- The check ran into its own timer. That error has no code.
- The error was marked with `PoolStatus.ownError(error)`. `Pool` marks the
  errors it makes with a code of its own, `POOL_NOT_CONNECTED` and the
  `PROTOCOL_SEQUENCE_TIMEOUT` of its timer around the change of database,
  and the error the app passes to `failWaiting()`. The mark is kept in a
  `WeakSet`, so the error object is not changed and still has its code for
  every other caller.
- The error was thrown after the answer came, by the code that reads the
  answer. Only what the status query is rejected with is reduced.
- The error is not an object, or reading one of the three fields throws.

A check that times out ends by its own timer, not by the `timeout` option
of mysql2 that the status query is sent with. Both have the same length,
and the timer of the check is set first: mysql2 sets its timer only after
the connection was handed out and the database was changed, which is never
in the same turn. So a timed out check reports `{}`, not
`PROTOCOL_SEQUENCE_TIMEOUT`. The connect timeout of mysql2 is set when the
connection is made, before the timer of the check, and is 10 s. It ends the
check with `ETIMEDOUT` when the timer of the check is longer than that.

## Adaptive timer

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

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
`nextCheckStatus` again to re-arm. A second `start` replaces the pending
run, so there is never more than one. `dispose()` clears the pending
timeout and flips `_active = false` so `start()` becomes a no-op, until
`activate()` is called ([src/utils/Timer.ts](../../src/utils/Timer.ts)).
The `active` flag on `Timer` is **independent** of `PoolStatus.active` —
the former gates the timer, the latter gates `checkStatus` itself.

### Stop and start again

`Pool.disconnect()` calls `stopTimerCheck()`, and `Pool.connect()` calls
`startTimerCheck()` before its first check. That call sets `active` and
turns the timer on, so a pool that is connected again is checked again. Up to 4.4.0 the timer stayed off after the first
disconnect.

A check that is still running at `stopTimerCheck()` belongs to a
connection that is gone. When it ends it changes neither `isValid` nor the
failure count nor `checkError`, sets no timer, logs nothing and emits
nothing, also when the pool was connected again in the meantime.

A check may be rejected with anything. The log line of a failed check
prints the message of the error, its `code` when the message is empty, the
value itself when it is not an error, and `unreadable error` for a value
that cannot be turned into text. A dropped check and a restart are logged
at `debug`.

`disconnect()` does not reset `isValid`, the failure count or `checkError`.
They keep their last values until the first check of the next `connect()`
ends.

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
`result.find(res => res.Variable_name === validator.key)?.Value`. If the
key is missing (a typo, or a non-Galera server without `wsrep_*` rows),
`check` logs the key by name and counts that validator as failed. Before
3.2.2 this threw `TypeError` out of `check`; see
[known-issues.md#3](../known-issues.md#3-validatorcheck-crashes-on-missing-status-key).

`available_connection_count` is the real number of free slots
(`connectionLimit` minus connections in use). Before 3.2.2 it was a
counter that only grew, so thresholds like `> 50` always passed; re-tune
them when upgrading. With `connectionLimit: 0` (mysql2: no limit) it is
`Infinity`.

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
([src/configs/schema.ts](../../src/configs/schema.ts)):

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
([src/configs/schema.ts](../../src/configs/schema.ts)):

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
