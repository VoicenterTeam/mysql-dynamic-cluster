# Subsystem: Health and Scoring

Each `Pool` carries a companion `PoolStatus` instance that decides, on a
timer, whether the underlying MySQL node is still
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

## Two modes

A node is checked in one of two ways. Its settings decide which, once, when
the cluster is created.

| | Legacy check | Check with a `healthCheck` block |
| --- | --- | --- |
| Which node | A node whose settings hold no `healthCheck` block. That is every node of an app that does not set the block | A node whose settings hold the block, from `defaultPoolSettings` or from its host. An empty block is enough. Not in 4.6.0 or earlier |
| Wait before the next check | Longer after an answered check, shorter after a failed one, inside `timerCheckRange`. See [Adaptive timer](#adaptive-timer) | `healthCheck.interval`, the same after every check |
| Timeout of one check | `min(queryTimeout, timerCheckRange.end)` | `healthCheck.timeout` |
| Down | At the second failed check in a row, or with one check a validator says no to | At the `fall`th failed check in a row, or with one check a validator says no to |
| Back | With one check that passes | With `rise` passes in a row, or with the first pass since `connect()` |
| Over `disconnect()` and a new `connect()` | The count of failed checks and the wait are kept | Both runs start again |
| A check that throws after its answer came | The node is already set to what the validators said | A failed check. A pass it held does not count, a no does |
| `timerCheckRange` and `timerCheckMultiplier` | Used | Ignored. One `warn` per node when the app wrote one of them |

The check itself is the same in both: one `SHOW GLOBAL STATUS` through
`Pool.query`, the validators, the load factors, `checkError`, the
`pool_check_failed` event and the metrics. Only the rule that moves `isValid`
and the wait before the next check differ. `PoolStatus` keeps the block as
`_healthCheck`. The constructor takes the timeout and `fall` from it,
`startTimerCheck()` resets the runs for it, `checkStatus()` applies its rules
and `nextCheckStatus()` waits its interval.

The settings are in [../configuration.md](../configuration.md#healthcheck).
The legacy check is pinned by
[tests/pool/health-check-legacy.test.ts](../../tests/pool/health-check-legacy.test.ts),
the check with the block by
[tests/pool/health-check.test.ts](../../tests/pool/health-check.test.ts).
The sections below describe the legacy check unless they say otherwise.

## The rules of a `healthCheck` block

Next to `isValid` three values make the state of a node:

| Field | Meaning |
| --- | --- |
| `_failedChecks` | Failed checks in a row. The legacy check counts them too |
| `_passedChecks` | Passed checks in a row |
| `_passedSinceStart` | Whether a check passed since the last `startTimerCheck()`, which `Pool.connect()` calls |

`startTimerCheck()` sets all three back, so every `connect()` starts with no
run. It leaves `isValid` as it is.

A check ends in one of three ways:

1. **It passed.** The status query ran and every validator said yes. The run
   of failures is reset and the run of passes grows by one. A node that is up
   stays up. A node that is down comes back when this is the `rise`th pass in
   a row, or the first pass since `connect()`.
2. **A validator said no.** The status query ran. The node goes down at
   once, whatever `fall` is, and both runs are reset.
3. **It failed.** It got no answer: no connection, a refused login, a lost
   connection, the timeout of the check, or an error the package made. The
   run of passes is reset and the run of failures grows by one. At `fall` in
   a row the node goes down. Every kind of failure counts the same.

After each of the three the next check is set `interval` ms later.

More on these rules:

- **Only a check brings a node back.** No timer and no query of the app
  sets `isValid`.
- **The first pass since `connect()` is enough by itself.** The first check
  that passes after `startTimerCheck()` brings the node up, whenever it
  comes: as the check of `connect()`, or after any number of checks that
  failed or that a validator said no to. From then on the node needs `rise` passes
  each time it went down. A `disconnect()` and a new `connect()` start this
  again. So `connect()`, `ready` and `firstReady` end as they do with the
  legacy check: one passing check is a node that is ready, and a node that
  was down when the app started is not slowed.
- **A pass of a node that is still down** sets the load score, clears
  `checkError` and is recorded as a `valid` check, while `isValid` stays
  `false`. The result of a check says what that one check found. The state
  of the node is `isValid`, and the gauge `mysql_dynamic_cluster.node.valid`.
- **The interval starts when a check ends.** A check that hangs until its
  timeout is followed by the next one `timeout + interval` ms after it
  started, so two checks of the timer do not overlap. A second `connect()`
  without a `disconnect()` runs its own check beside the one of the timer, as
  with the legacy check.
- **A change of state is logged, one line each.** A node that goes down logs
  a `warn`, a node that comes back an `info`. The meta has `pool`, `valid`
  and `reason`: `fall` or `validator` for a node that went down,
  `first_pass` or `rise` for one that came up. A check that leaves the node
  as it was logs no such line, so a dead node logs one `warn` and then only
  the error line of each failed check. A node that was never up logs no
  `warn`. The legacy check logs none of these lines.
- **The passes of a node that is up do not count later.** The check that
  takes a node down resets the run of passes, so the node always needs the
  full `rise` after it.
- **A failed check from before a `disconnect()` does not count after the new
  `connect()`.** `isValid` is kept over the two calls, as with the legacy
  check, so a node that was up stays up until `fall` checks of the new
  connect failed in a row. The legacy check keeps its count instead: one
  failed check before the `disconnect()` and one after take the node down.
- **A check that throws after its answer came is a failed check.** The
  answer was read, and then the package failed, for one in the load factors.
  Such a check has an empty `checkError`. It counts toward `fall`. A pass
  the validators gave it is dropped: it brings no node up, adds nothing to a
  run of passes and is not the first pass since `connect()`. A no the
  validators gave it holds: the node goes down at once. The legacy check
  sets the node to what the validators said before the rest of the check
  runs, so there such a check can leave a node valid.

### Time to leave rotation and to come back

Measured with a fake clock in
[tests/pool/health-check.test.ts](../../tests/pool/health-check.test.ts) and
[tests/pool/health-check-legacy.test.ts](../../tests/pool/health-check-legacy.test.ts),
in ms. A node leaves rotation when `isValid` turns `false`. The first two
rows are the longest it can take: the node stops right after a check that
passed. In the last two rows the node returns right after a check that
failed, or while a check hangs.

| | Legacy, default settings | Legacy, range 15000 to 60000, multiplier 0.1, `queryTimeout` 15000 | `healthCheck: {}` |
| --- | --- | --- | --- |
| Out, the node refuses connections | 26538 | 75000 | 10000 |
| Out, the checks of the node hang | 56538 | 105000 | 20000 |
| Back, the node answers again | 5000 | 60000 | 10000 |
| Back, a check was hanging as the node returned | 20000 | 75000 | 15000 |

- With the block a node is out after `fall` times `interval`, plus `fall`
  times `timeout` when its checks hang. It is back after `rise` times
  `interval`, plus one `timeout` when a check was hanging.
- The legacy defaults wait 15000 after a pass, then 11538 after the first
  failure. A check that hangs adds its 15000 each time.
- The legacy `Back` numbers are the wait the failures left the node with,
  then one pass. With the default settings that is 5000 once the node failed
  five checks in a row, and more before that: 11538 after the first failure.
  With the multiplier 0.1 of the second column one failed check sets the
  wait to the end of the range, 60000.
- With `rise: 2` a node comes back later than with the legacy defaults, 10000
  against 5000, because one answer is not enough. `rise: 1` gives 5000.
- More values of the block, measured the same way. Out: 5000 with `fall: 1`.
  9000 with `interval: 2000`, `timeout: 1000`, `fall: 3` and checks that
  hang. 30000 and 60000 with `interval: 15000`. 5001 when the node stops 1 ms
  before its check is due. Back: 5000 with `rise: 1`, 6000 with
  `interval: 2000` and `rise: 3`.
- The legacy values next to the block change none of these numbers.

### Where the pattern comes from

A fixed interval, a count of failed checks in a row before a server is down
and a count of passed ones before it is back is how HAProxy checks its
servers, with
[`inter`](https://docs.haproxy.org/3.2/configuration.html#5.2-inter),
[`fall`](https://docs.haproxy.org/3.2/configuration.html#5.2-fall) and
[`rise`](https://docs.haproxy.org/3.2/configuration.html#5.2-rise). There
too the interval is the timeout of a check unless one is set. HAProxy
defaults to 2000 ms, 3 and 2, the block to 5000 ms, 2 and 2.

## `PoolStatus` state

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

The public surface that `GaleraCluster` and `Pool` read from:

| Field | Kind | Source | Notes |
| --- | --- | --- | --- |
| `active` | `boolean` (mutable) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Set to `true` by `startTimerCheck()`, which `Pool.connect()` calls (see [pool.md](pool.md)), and to `false` by `Pool.disconnect()`. The first thing `checkStatus()` does is `if (!this.active) return`, so the poll is a no-op until `Pool.connect()` runs. |
| `availableConnectionCount` | `number` (getter) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Returns `Pool.availableConnectionCount`: `connectionLimit` minus connections in use, read from mysql2's own lists (see [pool.md](pool.md)). |
| `isValid` | `boolean` (getter over `_isValid`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Set by a check: from `Validator.check` in the legacy check, by [the rules of the block](#the-rules-of-a-healthcheck-block) for a node that has one. Initially `false` (the field default, re-asserted in the constructor): a pool that has never been polled is not yet routable. |
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
- `_healthCheck?: IHealthCheck`:
  [PoolStatus.ts](../../src/pool/PoolStatus.ts). The `healthCheck` block
  of the node with every key, as `Settings.mixSettings` filled it. Not set
  for a node of the legacy check. See [Two modes](#two-modes).
- `_fall: number`: failed checks in a row that take the node down: `2` in
  the legacy check, `healthCheck.fall` with the block.
- `_passedChecks: number`, `_passedSinceStart: boolean`: the run of passes
  and the first pass since `connect()`. Only a node with the block reads
  them.
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
5. `passed = this._validator.check(result)`, logged at `debug` with the
   meta `pool` and `passed`: what this check found, which for a node with a
   `healthCheck` block is not always the state of the node. The legacy check
   sets `_isValid` to it here. A node with a `healthCheck` block is set here only
   when the validators said no. Its pass counts after step 6, in
   `_upAfter(passed)`, so a check that throws in between brings no node up
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).
6. `this._loadScore = this._loadFactor.check(result)`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).
7. `this.nextCheckStatus()` schedules the next tick on success. With a
   `healthCheck` block the wait is `interval`, here and in the `catch`.

If any step throws, the `catch` branch
([PoolStatus.ts](../../src/pool/PoolStatus.ts)) logs, still records
`_queryTime` (so a hanging node's slow poll is visible), and calls
`nextCheckStatus(true)` to schedule a *faster* re-check.
Then it emits `pool_check_failed` with the error and the pool id, so the app can read the
error's `code` and `errno`; see [events.md](../events.md#a-failed-health-check).

Since 3.2.2 the `catch` also counts failures in a row (`_failedChecks`).
The **second** failed check in a row sets `_isValid = false`; a single
failure (network blip, proxy restart, DNS) keeps the last `isValid` so one
bad poll doesn't take the node out of rotation. A passing check resets the
counter and assigns `_isValid` from the validator again. Before 3.2.2 a
failed check never touched `_isValid`, so a node whose checks all failed
stayed in rotation. With a `healthCheck` block the count that takes the node
down is `fall`, kept as `_fall`, and a failed check also resets the run of
passes.

Every check that ends is recorded as the metric
`mysql_dynamic_cluster.health_check.duration`, with the result `valid`,
`invalid` or `error`. `valid` and `invalid` are what the validators said in
this check, also for a node with a `healthCheck` block that passed and is
still down. Both branches record it as their last step. The
success branch does so after `nextCheckStatus()`. The `catch` branch does so
after the next check is set and `pool_check_failed` is emitted, in a
`finally`, so a step that throws there still leaves the check counted once.
Nothing a record does comes before what the check itself does. A check that
was dropped and a check that did not run record nothing. `isValid` and `loadScore` are also published, as the gauges
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

For a node with a `healthCheck` block the timeout is `healthCheck.timeout`,
which is its `interval` when left out: 5 s with the defaults of the block.
`queryTimeout` and `timerCheckRange` have no part in it. The timer, the race
and the timeout passed to the query work the same.

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

This is the wait of the legacy check. For a node with a `healthCheck` block
`nextCheckStatus` starts the timer with `healthCheck.interval` and returns
before any of the arithmetic below. `_nextCheckTime` is not touched then.

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
ends. For a node with a `healthCheck` block `isValid` and `checkError` are
kept the same way. Its two runs and the mark of the first pass are not:
`startTimerCheck()` sets them back, so the first pass of the new `connect()`
brings such a node up by itself, and a failed check from before the
`disconnect()` no longer counts.

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
rotation until the next successful poll, or until `rise` successful polls
in a row for a node with a `healthCheck` block.

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
