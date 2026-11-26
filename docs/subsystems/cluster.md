# Subsystem: `GaleraCluster`

`GaleraCluster` is the orchestrator. It owns the `Pool` instances, the
`ClusterHashing` module, the `ServiceNames` cache, and the query routing
logic. Every consumer call (`connect`, `disconnect`, `on`, `query`, and the
node API of [../node-api.md](../node-api.md)) flows
through this class. It is constructed by `createPoolCluster` after the
settings have been validated and loaded into the `config` singleton; see
[../architecture.md](../architecture.md) for the boot flow that precedes
this subsystem.

Source: [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
The references below name the function or the field to look in.

## Construction

Since 4.2.0-rc.3 (#86) the constructor takes the context of the cluster,
`IClusterContext` in
[src/types/ClusterContextInterfaces.ts](../../src/types/ClusterContextInterfaces.ts):
its logger and the `clusterName` its metrics carry. `createPoolCluster`
builds it, see [../architecture.md](../architecture.md#singletons). The
cluster logs through that logger and passes the name with every metric it
records.
Without a context, as on a cluster a unit test builds, it logs through the
module logger and its metrics carry the name of `Metrics.init`. Every
configuration value is read off the `config` singleton via
`config.current`; `createPoolCluster` has already validated the user
settings and loaded them into it before `new GaleraCluster(context)` is
called.

Fields populated from `config.current`, at the top of the constructor:

- `_useClusterHashing` ← `useClusterHashing`.
- `_clusterName` ← `clusterName`.
- `_errorRetryCount` ← `errorRetryCount`.
- `_useRedis` ← `redis.enabled`.
- `_nullServiceName` is a constant `"mdc"`, set where the field is
  declared in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts);
  the fallback service name becomes `${clusterName}_mdc`.

Pool construction, in the constructor:

1. `_sortPoolIds(config.current.hosts)` collects every manually-set
   numeric `id` from the host list and returns them sorted ascending
   (`_sortPoolIds`).
2. The constructor iterates `config.current.hosts`; for any host with no
   `id`, the next id is `0` when the sorted list is empty, otherwise
   `last + 1`, and the new id is pushed back into the list so subsequent
   gaps still increment from the highest assigned id.
3. Every host gets a `Pool`, constructed with `(poolSettings,
   clusterName, context)`. A host without `host` never gets here: the settings
   schema rejects it.
4. Since 4.1.1 the constructor logs a `warn` for a host whose id is
   negative, not an integer, the id of another host too, or above 127 with
   `useClusterHashing` on, also an id it gave. The id is kept as it is. A
   host gets one `warn` at most: the line about a replaced `0` says it
   too. See [`hosts`](../configuration.md#hosts).

After the pool array is built, the constructor instantiates
`ServiceNames(this, config.current.serviceMetrics, logger)` and
`ClusterHashing(this, clusterName, config.current.clusterHashing, logger)`,
with the logger of the cluster, the last step of the constructor.
Note: `ClusterHashing` is constructed unconditionally — the
`_useClusterHashing` flag only gates `connect()` calling `_enableHashing`.

## `connect()`

`connect` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).

`connect` first hands its pools and the `clusterName` of its context to
`Metrics.registerPools`, which reports their connection counts from then
on, see
[metrics.md](./metrics.md#pool-connection-metrics).

`connect` returns a `Promise<void>` that wraps a `forEach` loop firing
`pool.connect()` on every pool in parallel. The **first** pool to resolve
wins the race:

- Sets `this.connected = true`.
- If `_useClusterHashing` is true, awaits `_enableHashing()`.
- Emits `'connected'` via the shared `Events` bus and resolves the outer
  promise.

Since 4.1.1 those steps are kept as `_clusterConnect`, the connect of the
cluster. A later pass, of the same call or of another one, finds
`this.connected` set and settles its call with `_clusterConnect`. Before,
it returned at that guard without settling.

Since 4.1.1 a second `connect()` without `disconnect()` keeps its own
promise, connects every pool again and has its own `ready` and
`firstReady`. It settles with the cluster: within one tick when the cluster
is connected, when `_clusterConnect` is done while it runs, and when the
call that still runs resolves (`_connecting`). A rejection of that call
leaves the second one to its own pools, as before: the second connect of a
pool can make the first one fail. Its own first failure still rejects it.
Before 4.1.1 such a call could stay pending for good. `disconnect()`
forgets both, so the next `connect()` waits for its own pools.

A `'connected'` listener that throws makes the `connect()` that connected
the cluster reject with the message, and a later `connect()` without
`disconnect()` rejects at once with the same reason.

Since 4.1.1 `disconnect()` also puts a new object in `_generation`. A pool
of a `connect()` called before it that passes late resolves that call and
leaves the cluster as `disconnect()` left it: not connected, no hashing, no
`'connected'` event, and nothing that counts for a later `connect()`.
Before, such a pass marked the cluster connected again and started hashing.
A `disconnect()` while the hashing of the pass that connected the cluster
runs gets no `'hashing_created'` or `'connected'` event after its
`'disconnected'`, and no `Cluster connected` line.

Failure semantics: any `pool.connect()` rejection rejects the outer
promise in the `catch` callback, with a string: the message of the error,
`String(err)` when it has none, or `unreadable error` when neither can be
read. Since 4.1.1. Before, a rejection with `undefined` or `null` threw
there and left `connect()` pending.
Because `forEach` does not await between iterations, **other pools may
still be in flight or failing** after the outer promise has resolved or
rejected. The first rejection that lands before the first success will
reject the outer promise even though slower pools could still come up.
This is tracked behaviour — see [../known-issues.md](../known-issues.md).

`_enableHashing`
awaits `_clusterHashing.connect()`, emits `'hashing_created'`, and logs;
errors are caught and logged but do not propagate to `connect`.

Since 4.1.1 a cluster without hosts resolves `connect()` at once. It is not
marked connected, and a query fails with `MDC_NO_NODE_AVAILABLE`, as with no
valid node.

Since 4.0.0 every `connect()` call also settles the `ready` promise. It
resolves once every `pool.connect()` of that call ended, with one result per
pool, and it never rejects. `connect()` itself resolves and rejects as
described above. See [../node-api.md](../node-api.md#ready).

Since 4.0.0 every `connect()` call also settles the `firstReady` promise. It
resolves when the first `pool.connect()` of that call passed, with the
results that are in by then, or together with `ready` when none passed. It
does not wait for `_enableHashing()`. `connect()` hands every
`pool.connect()` an empty object, and the pool fills it with how the health
check of that connect ended (`ICheckOutcome` in
[src/types/PoolInterfaces.ts](../../src/types/PoolInterfaces.ts)).
`_readyResult` builds the result when the `pool.connect()` settles and reads
that object then. A pool that rejected with no Error gets one whose message
is the text `connect()` rejects with, `unreadable error` when the value
cannot be made text, since 4.1.1. Before, such a value left `ready` and
`firstReady` pending. A check that was recorded puts its own error on the result,
whatever was called after it. A failed connect whose check was dropped, or
that ran no check, gets an empty `checkError`, and `_failedCheckError` logs
that at `debug` with `nodeId` and `pool`. A passed connect whose check was
dropped gets none. `nodes()` is different: it reads `pool.checkError`, the
error of the last check of the pool. `firstReady` resolves with copies of the
results, made by `_ownResults`, so the two promises share no result object.
See [../node-api.md](../node-api.md#firstready).

## `disconnect()`

`disconnect` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).

Tears the cluster down in this order:

1. `this.connected = false`, and since 4.1.1 a new `_generation`, and
   `_clusterConnect` and `_connecting` are forgotten.
2. `Metrics.unregisterPools` ends the pool connection metrics of its pools.
3. `this._clusterHashing?.stop()` halts the hashing refresh timer.
4. `Redis.disconnect()` closes the shared Redis client, only when this
   cluster enabled redis (`redis.enabled` true).
5. `pool.disconnect()` on every pool (synchronously kicked off via
   `forEach`).
6. Emits `'disconnected'`.

The method is `async` but does not await pool disconnects.

## `on(event, callback)`

`on` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Thin pass-through to `Events.on`. The full event list is in
[../events.md](../events.md).

## `query()`

`query` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Steps 1 to 9 are all in that one method, in this order. `execute()` is
this method with the option `execute`, see
[`execute()` and bound values](#execute-and-bound-values).

Signature:
`query<T>(sql: string, values?: QueryValues, queryOptions?: IQueryOptions): Promise<T>`.

### 1. Option defaults

`queryOptions` is rebuilt via spread so caller-supplied keys win
(the first two statements of `query`; the second turns `redis` off for
`execute`):

- `redis` defaults to `_useRedis` (i.e. `config.current.redis.enabled`).
  With `execute` it is `false`, whatever the caller passed.
- `maxRetry` defaults to `_errorRetryCount`.
- `redisRefreshCache` defaults to `false`.
- `execute` gets no default. Left out, the values go into the text (step 6).
- `retryNotReady` gets no default here. Left out it counts as `true`, see step 8.
- `signal` gets no default. `null` counts as no signal. Right after the
  `record` helper of step 2 the call checks it, before step 3: see
  [The `signal` option](#the-signal-option). The values of an `execute`
  call are checked right after it. Then a `:name` of an object of values
  inside quotes or backticks rejects with `MDC_QUOTED_PLACEHOLDER`. Then an
  aborted signal rejects, then the values are written into the text (step 6),
  and values that can change how a server reads a comment it skips reject
  with `MDC_UNSAFE_COMMENT_VALUE`, see
  [What values do in the SQL text](#what-values-do-in-the-sql-text).
- `onTiming` gets no default. `null` counts as none, as `undefined` does.
  It is checked right after `timeout`, before the values: see
  [The `onTiming` option](#the-ontiming-option).
- `onStep` gets no default. `null` counts as none. It is checked right
  after `onTiming`: see [The `onStep` option](#the-onstep-option).

### 2. Metrics

Starts a `QueryTimer` before any work. Every way out of `query` records
one `mysql_dynamic_cluster.query.duration` sample through the local
`record` helper ([src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts)).
See [metrics.md](./metrics.md). For a call that reached step 8 the same
helper calls `onTiming`, see [The `onTiming` option](#the-ontiming-option).

### 3. Service-id resolution

The first lines of the `try` block.

- If the caller passed `serviceName` but no `serviceId`, look it up via
  `ServiceNames.getID(serviceName)` and write it back onto
  `queryOptions.serviceId`. Since 4.0.0 the lookup is a `cluster.execute()`,
  with the name bound by the server.
- If `serviceId` is still falsy, fall back: set `serviceId = 0` and
  `serviceName = ${clusterName}_${_nullServiceName}` (i.e.
  `${clusterName}_mdc`).

### 4. Active-pool selection

`activePools = await this._getActivePools(serviceId)`.
`_getActivePools` does:

1. If `serviceId` is set and `_clusterHashing.connected`, ask
   `_clusterHashing.getNodeByService(serviceId)` for the pinned pool id
   (`-1` if no mapping).
2. Filter `_pools` to those where `pool.status.isValid` is true **and**
   the pool id is **not** the pinned pool id.
3. Sort the filtered list ascending by `pool.status.loadScore`.
   Since 4.0.0 steps 2 and 3 are the helper `_validPools(exclude)`, called
   here with the pinned pool id. `getConnection()` picks its node through the
   same helper, with the caller's `exclude` and without steps 1 and 4.
4. If the pinned pool exists in `_pools`, find it and `unshift` it to
   the front so the pinned pool is tried first. Since 4.1.1 only a valid
   pinned pool goes first: an invalid one is left out of the list.
5. Throw an `Error` with the code `MDC_NO_NODE_AVAILABLE` and the message
   `"There is no pool that satisfies the parameters"` if the final list is
   empty. `getConnection()` uses the same code. Since 3.2.2 `query()` first serves cached Redis
   data for that SQL, even expired, when `redis` is on for the query and
   no `redisRefreshCache` was asked — the same fallback it already used
   when the query fails on its nodes (step 9).

### 5. Retry clamp

`retryCount = this._maxRetryCount(queryOptions.maxRetry, activePools.length)`.
`_maxRetryCount`
clamps the retry count to the active-pool count so the retry loop never
overruns the array; if `maxRetry` is missing or non-positive it falls
back to `_errorRetryCount`. Since 4.0.0 the count is at least 1, so a
query always tries one node, also with `errorRetryCount: 0`. The count is
how many nodes the call may try at most: step 8 stops sooner when the
statement may have run.

Service-id resolution and active-pool selection share a single
`try`/`catch`. The lookup of a service name catches its own errors, so
the one error that reaches it is `MDC_NO_NODE_AVAILABLE`: it is recorded
as a failed query and rethrown as it is (the `catch` of that block).
When the signal aborted by then, or while Redis is read for stale data
there, the call rejects with the reason of the signal instead.

### 6. SQL formatting

`this._formatSQL(sql, values)`, once, before step 3: right after the
check of the signal that comes before it, before the first `await` of the
call. The check of the comments a server can skip reads that text, step 4 reads
stale data of Redis with it, and after the `try`/`catch` of steps 3 to 5
`sql` becomes it. So a `toSqlString()` runs once per call, and a change to
the values after the call does not reach the text. Since 4.1.1. Before, the
text was written after that `try`/`catch`, or in step 4 for stale data. Not
for `execute`: its values stay apart from the text. The `formatSQL` debug line is logged for text queries
only. `valuesInText` is `sql !== originalSql`: whether the formatting
wrote a value into the text.
`_formatSQL`:

- Array `values` → sql-escaper's `format(sql, values)` (positional `?`).
- String `values` → same `format()` call.
- Object `values` → `:paramName` substitution in one pass: `_namedPlaceholders()`
  reads the text as sql-escaper reads it for a `?`, and each `:name` in code
  gets the value when the object has the key as its own property,
  otherwise the placeholder stays verbatim. The value goes through
  sql-escaper's `escape(value, true)`, so a plain object becomes the string
  `'[object Object]'`, not SQL. Always: there is no `escapeNamedValues`
  setting or query option to leave the value as text, as 3.2.2 did. A
  `mysql2.raw()` value, or
  any object with a `toSqlString` function, is still written as SQL.

What `_formatSQL` throws, such as the error of a `toSqlString()` of a
value, is recorded as a failed query, and the call rejects with that error.
Since the text is written before step 3, such an error comes before
`MDC_NO_NODE_AVAILABLE` too. The same holds for what the check of the
placeholders of an object of values throws before any node, such as a Proxy
whose trap throws. Since 4.1.1. Before, no metric was recorded for it.

#### What values do in the SQL text

`_formatSQL` imports `format()` and `escape()` from sql-escaper, a dependency of the
package, and calls them with the arguments mysql2's calls get. mysql2 exports these same two
functions, so with the same copy the text is the one `mysql2.format()` and `mysql2.escape()`
write; `tests/cluster/values-in-text.test.ts` compares them over a matrix of values. They do
more than put a quoted value in place of each `?` (#121):

- `??` is an identifier placeholder: `SELECT ?? , ?` with `['X', 'Y']` gives
  ``SELECT `X` , 'Y'``.
- A plain object or `Map` among array values, in place of an assignment after `SET` or
  `ON DUPLICATE KEY UPDATE`, becomes `` `key` = value `` pairs: `UPDATE t SET ?` with `[{ a: 1, b: 'x' }]` gives
  ``UPDATE t SET `a` = 1, `b` = 'x'``. Anywhere else, `SELECT ?` for one, it becomes the
  string `'[object Object]'`, and a named value does too, unless it is an `expand()` value
  (sql-escaper 1.7 and later), which becomes pairs.
- An object with a `toSqlString()` function is written as raw SQL, a named value too.
- A `?` inside `'...'`, `"..."`, backticks or a comment (`#`, `-- `, `/* */`) is left alone,
  since sql-escaper 1.6. The exception is `/*! ... */` and `/*+ ... */`: sql-escaper treats
  those as code, so a `?` there is replaced. `query()` refuses values that can change how
  a server reads such a comment, see the next item. 1.5.x also replaced one inside `"..."` or after `#`, so every value
  after it moved one place. mysql2 3.24 allows 1.5.1, so the package depends on
  `sql-escaper ^1.6.0` and calls it itself: `query()` leaves such a `?` alone whatever copy
  mysql2 gets. npm usually resolves the fixed copy for mysql2 too. An app that depends on a
  sql-escaper below 1.6 itself keeps that copy for mysql2 (npm then nests the newer one under
  this package), so `mysql2.format()` and `mysql2.escape()` called by the app directly still
  behave as 1.5.x there.
- A `:name` of the object inside quotes or backticks makes `query()` reject with
  `MDC_QUOTED_PLACEHOLDER` before any node is asked: write `= :name`, never `':name'`
  (see [named values](../configuration.md#named-values)). One in a comment stays text, one
  in `/*! */` or `/*+ */` is replaced, as a `?` there. The server may read such a comment as
  a plain one: a `*/` inside a value ends it, and a skipped `/*!NNNNN */` takes a `/*`, of a
  value or of the app, as the start of a nested comment. Keep values out of comments. Since 4.1.1
  `query()` rejects with `MDC_UNSAFE_COMMENT_VALUE` before any node is asked, with one metric
  record, in two cases (`_unsafeComment()`, #134), each with its own message. The text of the
  app is searched as it is, also inside strings, for `/*+`, for MariaDB's `/*M!` (a bare one
  too: MariaDB runs it as code, sql-escaper reads it as a comment), and for `/*!` followed by
  a digit, or by a `?` or a `:`, whose value can write the version. Up to its first `*/`,
  such a comment is called its first part below. A skipped comment does not always end
  there: it takes a `/*` in it, also one inside a string, as the start of a nested comment,
  and ends at a later `*/`, also one inside a string of the app.
  - First: the values changed the text, and the first part holds a `/*` (up to the `*` of
    its `*/`, for `/*/`), or a string, identifier or comment that sql-escaper reads as
    opening in the first part, the opener being code, ends after it or never ends.
    sql-escaper and the server then read the rest of the text differently, so a value can
    stand inside a string for one and outside it for the other, with no `/*` or `*/` in it.
    A quote left open, a `-- `, a `#` or a nested comment in a hint does that. The message
    points to `execute()`. Balanced quotes, such as `SET_VAR(sql_mode = 'ANSI')` or
    ``BKA(`t`)``, end inside the comment and are fine. An opener inside a string with no
    `*/` after it, as in `SELECT * FROM t WHERE a LIKE '%/*+%' AND id = ?`, refuses values
    too: use `execute()` for such a statement.
  - Then: the text holds such a comment and the values add a `/*` or a `*/` to it: either
    count is higher in the formatted text than in the text of the app, wherever the value
    stands.

  MySQL 8.0.42 ended such a comment inside the value in every position of `/*+ */` and in
  `/*!99999 */`. It runs `/*! */` and `/*!80000 */` as code and keeps the quotes of the value
  there, so `/*! */` alone does not trigger the check. MariaDB skips a `/*!NNNNN */` with a
  version from 50700 to 99999, and runs its own `/*M!NNNNNN */` up to its version.
  `execute()` is not checked.
- Only `execute()` keeps the values out of the text.
- Never pass an object from outside the app, such as a request body or parsed JSON, as a
  value: it can turn into column assignments or raw SQL.

Every escaped value relies on the server reading a backslash in a string
as an escape. A connection whose server has `NO_BACKSLASH_ESCAPES` does
not, so `Pool.query` refuses such a statement, see
[Values in the text under `NO_BACKSLASH_ESCAPES`](#values-in-the-text-under-no_backslash_escapes).

### 7. Redis read

The `if` block after the SQL is formatted.

Runs before any pool query when `queryOptions.redis && !queryOptions.redisRefreshCache`:

1. Start a `QueryTimer` for the lookup.
2. `Redis.get(sql)` — the formatted SQL is the cache key.
3. End the timer. Its value is recorded as
   `mysql_dynamic_cluster.cache.lookup.duration` with the result `hit`,
   `expired` or `miss`.
4. If a value comes back, `JSON.parse` it into `IRedisData`. If
   `redisData.expired > Date.now()`, record the cluster query with source
   `cache` and **return** `redisData.data` immediately (cache hit).
5. Otherwise fall through, **keeping a reference to `redisData` for
   stale-while-down** (step 9).

### 8. Retry loop

The `for` loop.

Walks `activePools` until `retryCount` nodes were tried, and calls
`this._queryRequest(sql, pool, queryOptions, outcome, { values, valuesInText, timing })`,
with a new empty `outcome` and `timing` for each node. The list was taken when the
call started, so since 4.2.0-rc.2 (#151) every attempt after the first skips a node
whose status is not valid when the attempt would start: it is not asked, has no step and
no metric record, and gets one `debug` line. A skipped node is not a try, so it does not
count toward `maxRetry` or `errorRetryCount`. When no node is left, the call rejects with
the error of the last node tried, as before (not `MDC_NO_NODE_AVAILABLE`), and the stale
Redis fallback works as before. The first attempt and the retry rule below are unchanged.

First success records the query with source `pool` and returns.
Each failure is kept as `{ nodeId, error }` in
`errors`. The loop goes on to the next pool only when the statement cannot
have run on the one that failed, so one call never writes twice.

`mayTryNextNode(error, outcome, queryOptions)` in
[src/cluster/QueryRetry.ts](../../src/cluster/QueryRetry.ts) decides it,
and nothing else does. `Pool.query` fills `outcome.sent`: `false` from the
start of the call, `true` once it hands the statement to the connection. It
stays `false` when the borrow of the connection failed: there is no mysql2
pool, mysql2 gave no connection, the node went down while the request
waited in its queue (`MDC_NODE_DOWN`, since 4.2.0), every connection
failed its probe, or the
session could not be got ready, as a reset of a dirty connection or a
`USE` of another database that failed or timed out. See
[pool.md](pool.md#borrow-taking-and-giving-back-a-connection). Since 4.0.0
the pool sends no change of user. A pooled connection the path forgot
that was idle longer than `probeIdle` fails its probe, which costs the
call nothing: the pool takes the next connection of the node (#93). One
used more recently fails under the statement itself, with `sent: true`,
and the next node is not tried.
The pool also writes `sent` on the error when the error can take it, but
the loop reads the outcome: a frozen error, or one the app handed
`failWaiting()` that many queries share, is decided the same way. So is an
error whose `code` or `errno` throws when read: since 4.1.1 it counts as
having none, and the call rejects with that error.
A `query()` or `execute()` that refuses a call before any node is asked
rejects with `sent: false`: the `TypeError`s of the options and of the
`execute` values, `MDC_QUOTED_PLACEHOLDER`, `MDC_UNSAFE_COMMENT_VALUE` and
`MDC_NO_NODE_AVAILABLE`, also when Redis has no stale data. The reason of
an aborted signal and an error the app's values throw carry no `sent`, and
`getConnection()` writes none on its errors.

**What a cut-off node costs a query.** The probes of one node run one
after another, and the `timeout` of the query does not cover the borrow:
it bounds the `USE`, the `DO 0` and the statement (the reset has
`resetTimeout`), not the probes or the login of a new connection. A
node whose idle connections all go unanswered costs one `probeTimeout`
per idle connection, then
mysql2's `connectTimeout` for the login of a new one, before `sent: false`
lets the next node try: about `connectionLimit × probeTimeout` plus one
`connectTimeout`, 20 s with a limit of 10 and the defaults. The borrow
stops sooner once health has given the node up, and only passive health
does that within the borrow, so it needs a `healthCheck` block. On such a
node each failed probe tells passive health of a lost connection, which
starts a check at once, and the first probe that fails after that check
took the node down ends the borrow with `sent: false`. With the block's
default check `timeout` of 5 s that is after about 6 to 7 probes. A node
on the legacy check, the default without a block, has no passive
health: only the check of its timer can take it down, so a query there
pays about the whole worst case. A query that waits in the queue of the
node, behind the logins of `connectionLimit` new connections, moves on
when the node goes down, since 4.2.0 (#98): the node fails it with
`MDC_NODE_DOWN`. Before, it waited for a login of its own after them,
see [health-and-scoring.md](health-and-scoring.md#a-node-that-goes-down-fails-the-requests-that-wait).
Only the `signal` option bounds the whole call.

| The node failed with | Next node |
| --- | --- |
| errno 1045, 1698, 1044, 3118, 3955 or 1130, a refused login | no, although `sent` is `false` |
| `MDC_UNSAFE_SQL_MODE`, values in the text under `NO_BACKSLASH_ESCAPES` | no, although `sent` is `false` |
| `MDC_PACKETS_OUT_OF_ORDER`, a reply whose packets came with a wrong sequence number (#94) | no: a defect of the client or the server, which another node would meet again |
| `MDC_NODE_DOWN`, the node went down while the request waited for a connection (#98) | yes: `sent` is `false`. The attempt ends in the step `queue`, and the next node starts with `queue` |
| any other error with `sent: false` | yes |
| errno 1047, not ready, with `sent: true` | yes, unless `retryNotReady: false` |
| an error reply, a timeout, a connection lost after the statement went out | no |
| anything from a pool that left `sent` unset | no, unless errno 1047 |
| anything, once the signal of the query aborted | no, checked before every other row |

A refused login is the same on every node: Galera replicates the accounts,
and a lockout policy counts each new login. The list is not the one the
health check keeps in `PoolStatus`, which also has errors that differ from
node to node, such as 1049 and 1129. A statement refused with 1047 did not
run, so the next node is safe, except for a procedure that commits part of
its work before the 1047: `retryNotReady: false` is for that. No setting
brings back the retry of earlier releases, which tried the next node after any error.
Since 4.0.0.

The list of step 4 is made once per call, and each turn of the loop takes
the next pool of it, so a retry never asks the pool that just failed. For a
node with a `healthCheck` block, `Pool.query` tells a connection error to
[passive health](health-and-scoring.md#passive-health) before it rejects. A
node that refused the connection is not valid any more when the loop goes
on, and step 4 of every later call leaves it
out. The loop does not
look at `isValid` again: a pool further down the list that went down in the
meantime is still tried, as before.

### 9. Aggregated failure / stale-while-down

The end of `query`, after the loop.

Each failed attempt is kept as `{ nodeId, error }`, in the order the
nodes were tried. `nodeId` is also set on the error itself. When the loop
ends without a result, because every node it tried failed or step 8
stopped it:

- If the signal aborted, in a node or after one failed, reject with the
  reason of the signal as it is. No stale data, no `nodeId`, no `errors`.
- If `redisData` is non-null (cache existed but was expired), log a
  warning, record the query with source `stale_cache`, and **return the
  stale payload** anyway.
- Otherwise reject with the error of the node tried last, as mysql2 made
  it: its own `message`, `code`, `errno`, `sqlState`, `sqlMessage`, `sql`
  and `fatal`, plus `nodeId`. The attempts before it are set on it as
  `errors`, so a single node gives `errors: []`. The query is recorded
  as failed with that error, so the metric carries its code.

`sql` is the statement mysql2 sent, with the values `_formatSQL` wrote
into it. An app that logs or ships the error whole ships those values
too, so it should drop `sql` first.

Since 4.0.0. Before, `query()` rejected with a new `Error` whose message
joined `Pool: <name>; Error: Query error: <message>` lines and which had
no code. See the changelog.

A frozen error, or a rejection that is no object, cannot take `nodeId`
or `errors` and is thrown without them. An error that already has an
`errors` array of its own keeps it and gets no list: Node's
`AggregateError`, when every address of a host name refused, holds the
error of each address there. `MDC_NODE_DOWN` is a new object for each
request, so its `nodeId` and `errors` are those of its own call. An error
that the app handed `failWaiting()` is one object that many queries can
meet. An entry that would lead back
to it, itself or through the list an earlier query set, is left out, so
the errors never form a cycle and `JSON.stringify` works on them. An
error whose `errors` cannot be read, through a getter or a Proxy that
throws, gets no list either, since 4.1.1. Each attempt is still logged at
`error`, since 4.2.0-rc.3 through the logger of the cluster (#86, see
[../architecture.md](../architecture.md#singletons)):
`Query failed in pool <name>: <message> (code <code>, errno <errno>)`.
The code and the errno are there when the error has them, since 4.1.1. A
rejection without a message, such as an `AggregateError`, `undefined` or
`null`, is named by its text. The single `All pools have error` line that listed them all is gone.

### 10. `_queryRequest`

`_queryRequest` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Wraps a single `pool.query(sql, queryOptions, outcome, call)` call, `call` being
`{ values, valuesInText, timing }`. The pool records the attempt as
`mysql_dynamic_cluster.operation.duration` and fills `timing`. On success:

- If `queryOptions.serviceId` is truthy and `_clusterHashing.connected`,
  awaits `_clusterHashing.updateNodeForService(serviceId, pool.id)` to
  pin the service to the pool that just served it.

On failure the error goes to the retry loop in `query` as it is, and the
outcome says whether the statement was sent. `updateNodeForService`
catches its own errors. Anything it still throws is logged as a warning
and the result is returned: the statement ran, so it must not go to the
next node.

### The `signal` option

Since 4.0.0 (#89). `signal` is an `AbortSignal` that ends the call when it
aborts. The call then rejects with `abortReason(signal)` of
[src/utils/Abort.ts](../../src/utils/Abort.ts): the reason of the signal
as it is, or, for a signal without a reason, an `Error` named
`AbortError` with the code `ABORT_ERR`. Nothing is written on the
reason: no `nodeId`, `errors` or `sent`.

| The signal aborts | What happens |
| --- | --- |
| before `query()` is called | rejects at once: no service name is looked up, Redis is not read, no node is asked, no listener is added |
| during the service-name lookup or the choice of nodes (steps 3 and 4) | rejects right after them: Redis is not read and no node is asked |
| while no valid node is found (step 4) | rejects before stale data of Redis is read, or after the read, before it is served |
| while the request waits for a connection | the borrow takes the request out of mysql2's queue. A connection whose login was still running goes back to the pool when it arrives |
| during the probe of an idle connection, the reset of a dirty connection, the `USE` of another database or the statement | the pool destroys the connection with its socket (`drop()` of [ServerFlags.ts](../../src/pool/ServerFlags.ts)) and never releases it: the statement may still run. mysql2 opens a new connection in its place for the next request |
| after a node failed, before the next one | `mayTryNextNode` says no, and the call rejects with the reason |
| after the answer | nothing: no listener is left |

An abort does not stop a statement the server already has: the server may
finish it. An abort is never tried on the next node, also when the
statement was not sent: `mayTryNextNode` reads `outcome.aborted`, which
`Pool.query` sets, and `signal.aborted`. Stale data of Redis is never
served after an abort, since the caller gave up. The signal is not read
after the Redis read of step 7: an abort during that read still gets a
fresh hit, and a call whose entry was expired goes on to a node, whose
pool rejects it at once.

`Pool.query` takes its connection through the borrow, as `getConnection()`
does, so both leave the queue the same way. An abort during the probe, the
reset or the `USE` destroys the connection. From the arrival of the
connection until the call settled, `Pool.query` holds a listener of its
own. See [pool.md](pool.md#borrow-taking-and-giving-back-a-connection). Neither listener stays
once the call settled, whatever way it ends. The abort is recorded as the
error of the attempt (`mysql_dynamic_cluster.operation.duration`) and of
the call (`mysql_dynamic_cluster.query.duration`), as any other rejection;
a falsy reason counts as a failure too. Passive health is never told of
it.

A `signal` that is no `AbortSignal` rejects with the `TypeError`
`query: options.signal must be an AbortSignal`, recorded as a failed
query. `_isAbortSignal` tells a signal by its members, as for
`getConnection()`. The status query of a node without a `healthCheck`
block passes no signal, and its connection gets no probe. `multiStatementQuery()` reads no signal.

### The `onTiming` option

Since 4.1.0 (#122). `onTiming` tells a caller where the time of a call
went: waiting for a connection, or on the node, once the call settled. For
the step while the call runs, see [The `onStep` option](#the-onstep-option).
It gets one object,
`IQueryTiming` of [src/types/PoolInterfaces.ts](../../src/types/PoolInterfaces.ts).
The package exports `IQueryTiming` and `QueryStep` as types:

| Field | Value |
| --- | --- |
| `step` | Where the last attempt ended, see the next table. |
| `queuedMs` | The time the call waited for a connection, summed over every node it tried. In milliseconds, with a fraction: it comes from a monotonic clock. |
| `nodeId` | The node of the last attempt. |

| `step` | The last attempt ended |
| --- | --- |
| `queue` | while it waited for a connection of the pool: in mysql2's queue, or while a new connection opened |
| `probe` | during the ping of an idle connection |
| `prepare` | during the reset, the `USE` or the `DO 0` before the statement, or with the `MDC_UNSAFE_SQL_MODE` refusal |
| `statement` | after the statement went to the connection. A call that resolved has this step too. When mysql2 throws at the send, before it wrote anything, the attempt keeps the step it had, `prepare` |

The wait for a connection runs from the request to mysql2 until the
connection came, the request failed or the signal aborted. The borrow
measures it with `performance.now()` of `perf_hooks`, a monotonic clock,
so a change of the system time does not count. The login of a new connection is part of it. After a failed probe the borrow asks mysql2
again, and that wait is added.

`onTiming` is called once, when the call resolves, rejects or aborts. It
is called before the promise settles, so the caller has the timing when its
`await` returns. It is called only for a call that reached step 8. So it
is not called for a Redis hit, or for a call refused before any node: an
option that is wrong, a signal that was already aborted,
`MDC_QUOTED_PLACEHOLDER`, `MDC_UNSAFE_COMMENT_VALUE`, or
`MDC_NO_NODE_AVAILABLE` and the stale data
of Redis served for it. Stale data served after every node failed (step 9)
does call it, with the step of the last attempt.

The local `record` helper of step 2 calls it, and every way out of
`query` goes through that helper once. Each attempt of step 8 hands
`Pool.query` a new `IAttemptTiming` object through `IPoolCall`. The
borrow sets its step as it goes and adds the wait of each request to
mysql2, see [pool.md](pool.md#borrow-taking-and-giving-back-a-connection).
The pool sets `statement` right before it sends, and sets the step back
when mysql2 throws at the send. The `outcome` the retry
rule reads is not changed. The metrics carry the same values per attempt:
the step as `mysql_dynamic_cluster.attempt.step` on
`mysql_dynamic_cluster.operation.duration`, and the wait as
`mysql_dynamic_cluster.connection.wait_time`, see
[metrics.md](./metrics.md#the-step-and-the-wait-of-an-attempt).

A throw in `onTiming` is caught and logged at `warn`, once. So is the
rejection of a promise it returns, as an `async` function does: it is
never left unhandled. A thrown value that cannot be made text, such as an
object without a prototype, is logged as `a value that is not text`.
Neither changes the result or the error of the call. `record('pool')`
runs after the `try` of the attempt, so nothing it does turns an answer
into a failure of the node. The error and the reason of the signal
stay as they are (#89): no property is added to them. `null` counts as no
`onTiming`, as `undefined` does, and as `null` does for `signal`. Any
other value that is not a function rejects with the `TypeError`
`query: options.onTiming must be a function`, before any node, recorded as
a failed query.

`execute()` takes it as `query()` does. `multiStatementQuery()` and
`getConnection()` do not take it.

### The `onStep` option

Since 4.2.0 (#140). `onStep(step, nodeId)` tells a caller the step a call
is in while it runs, with the node of the attempt. A caller that calls
`abort()` knows at that moment whether the statement may have been sent:
`onTiming` only comes after the call settled, a few milliseconds after
`abort()` returned. `step` is a `QueryStep`.

It is called synchronously, from inside the code that enters the step:

| `step` | Called |
| --- | --- |
| `queue` | as the borrow asks mysql2 for a connection, at each request: the first one of the attempt, and the one after a failed probe too |
| `probe` | as the borrow starts the probe of an idle connection |
| `prepare` | as the borrow starts the reset, the `USE` or the `DO 0` before the statement. Every attempt that got its connection enters it, also one whose connection needs none of them |
| `statement` | right after mysql2's `query()` or `execute()` returned: the statement was handed to the connection and counts as sent. When mysql2 throws there, it is not called |

It is called only when the step or the node differs from its last call in
the same call. After a failed probe the borrow asks mysql2 again: `queue`
again, then `probe` if the next connection is probed. A new attempt on
another node is `queue` with the new node. So is the attempt after one
whose node went down while it waited in the queue, `MDC_NODE_DOWN`: that
attempt ends in `queue`. So when the call settles, the
last step and node `onStep` gave are the ones `onTiming` reports. A call
on a fresh connection gets `queue`, `prepare`, `statement`; one that
probes an idle connection gets `queue`, `probe`, `prepare`, `statement`.

`statement` on one node followed by `queue` on another means that node
answered 1047, not ready, and did not run the statement: no other error
after the send lets the call try the next node. On a connection mysql2
already knows is closed, mysql2 fails the statement inside its `query()`
or `execute()`, so `statement` comes after the attempt failed. `onTiming`
reports `statement` for it too, and `sent` is `true`, as before.

It is not called for a Redis hit, for a call refused before any node, or
after the call settled. `execute()` and `query()` with `execute: true`
take it. `multiStatementQuery()` and `getConnection()` do not.

An `abort()` of the signal from inside `onStep` is an abort at that
moment: the call rejects with the reason as it is, and `onStep` is not
called again. At `queue` the borrow ends before its request reaches
mysql2, so no connection is taken. At `probe` and `prepare` the borrow
destroys the connection, at `statement` the pool does, as for any abort
there.

A throw in `onStep` is caught and logged at `warn` once per call, with the
node: `onStep of a query threw or rejected, the call keeps its result: ...`.
So is the rejection of a promise it returns. Neither changes the call: no
property goes on its error or on the reason of the signal. `null` counts
as no `onStep`. Any other value that is not a function rejects with the
`TypeError` `query: options.onStep must be a function` and `sent: false`,
before any node, recorded as a failed query.

A call without the option gets nothing made for it. For a call with it,
`_stepTeller` keeps the last step and node and catches what `onStep`
throws, and each attempt puts a function `enter` on its `IAttemptTiming`,
which the pool and the borrow call as `timing.enter?.(step)`.

How it differs from `onTiming`:

| | `onTiming` | `onStep` |
| --- | --- | --- |
| Called | once, as the call settles | as each attempt enters a step, while the call runs |
| Gets | the step the last attempt ended in, the time queued, the node | the step and the node |
| `statement` | set right before the send, set back when mysql2 throws | called right after mysql2 took the statement |

Used together, `onTiming` is called once with the same values as without
`onStep`.

### `execute()` and bound values

Since 4.0.0 (#91). `execute<T>(sql, values?, queryOptions?)` is
`query(sql, values, { ...queryOptions, execute: true })`, and the option
works the same on `query()` itself. Nothing is switched to it for a caller:
`query()` without the option writes its values into the text, as before.

The two forms take the same path: the choice of node, the retry rule of
step 8, the error of step 9, the signal, the metrics and passive health.
The one difference is in `Pool.query`, which hands the statement to
mysql2's `conn.execute({ sql, values })` in place of
`conn.query({ sql })`. The values go in the execute packet as
parameters and never become part of the text.

mysql2 prepares the statement on that connection and keeps it in a cache of
its own, keyed by the text alone, so the second call of the same text on
that connection is one command. That cache has costs, and the pool bounds
them:

- **Each kept statement holds memory on the server**, and the server counts
  every statement of every client against `max_prepared_stmt_count`
  (16382 by default). The pool setting `maxPreparedStatements` (100 by
  default) caps the statements of one connection: past it the one used
  longest ago is closed (`COM_STMT_CLOSE`). Keep
  `processes × connectionLimit × maxPreparedStatements` per node below
  `max_prepared_stmt_count`, with room for the other clients of the
  server. 4 processes with `connectionLimit: 10` and the default use at
  most 4000. An app that sends many distinct texts, such as an `IN` list
  of a length that varies, fills the cap and prepares again: send such a
  statement with `query()`.
- **A statement runs in the database it was prepared in**, also after a
  `USE` of another one, and the cache key has no database. So the pool
  closes every statement `execute` prepared on a connection before it
  sends a `USE` of another database there, and the next call prepares
  again. A `USE` back to the database they were prepared in keeps them,
  such as the `USE` the pool sends after a reply header with bit `0x4000`
  (session state changed: a `USE` of the app, or every write on a server
  that tracks GTIDs). Before the pool lends a connection to the app
  (`getConnection()`), it closes them too: an `execute()` of the app with
  the same text would get the pool's statement. `SessionState` keeps the
  texts and their database, see
  [pool.md](./pool.md#the-session-of-a-connection). mysql2 3.24 sends
  each close twice; the server ignores the second.
- **A reset** forgets every prepared statement, on the server and in
  mysql2, so the next call prepares again.

- **Values.** An array, or none (`undefined` or `null`). Anything but an
  array, `null` or `undefined` rejects with the `TypeError` `execute: values
  must be an array, with no undefined and no function in it`, before the
  service-name lookup and any node, and is recorded as a failed query: an
  object, a string, a number, a boolean, and so on. So does an array that
  holds `undefined`, a hole (`[, 'x']`) or a function.
  mysql2 would throw for those, or fail the call after the prepare. Use
  `null` for SQL `NULL`.
- **No Redis.** An `execute` call neither reads Redis nor writes it,
  whatever the `redis` option says, also when no node is valid.
- **Errors.** A prepare that fails, such as a syntax error, comes back as
  the error of the call, with `sent: true`: the prepare went to the server,
  so no other node is tried, and the connection is reset before it goes
  back. A node that answers the prepare with 1047 is left for the next
  node, as for a statement.
- **Timeout.** The `timeout` of the query covers the prepare and the
  execute together: `Pool.query` arms it when it sends the statement, since
  mysql2 times only the execute. On expiry the call fails with
  `code: 'PROTOCOL_SEQUENCE_TIMEOUT'` and `sent: true`, and the connection
  is destroyed. The signal ends either step.
- **Metrics.** The same records and attributes as `query()`.

### Values in the text under `NO_BACKSLASH_ESCAPES`

Since 4.0.0 (#91). Escaping a value into the text puts a backslash before
each quote. A server whose `sql_mode` has `NO_BACKSLASH_ESCAPES` reads that
backslash as a character, so the quote ends the string and the rest of the
value is SQL. The server says so in bit 512 of the status flags of every OK
header. `SessionState` keeps the bit of the last header on each connection,
see [pool.md](./pool.md#the-session-of-a-connection).

A `query()` that wrote values into its text takes its connection and gets
it ready as any other, with a `DO 0` when the mode of the connection is
unknown, see below. If the state of that connection says
`NO_BACKSLASH_ESCAPES`, `Pool.query` rejects before the statement is sent,
with an `Error` whose `code` is `MDC_UNSAFE_SQL_MODE` and whose message
names the mode and `execute()`. Always: there is no setting.

- The error has `sent: false` and `nodeId`. Step 8 tries no other node:
  another node can have the same mode, and the fix is the caller's.
- The connection goes back to the pool as it is: no reset, not destroyed.
  Passive health is not told.
- `execute`, and a `query()` without values, run as before.
- "Wrote values" has one rule: `_formatSQL` changed the text. `query()`
  passes that to the pool as `valuesInText`. So `query(sql, [])`,
  `query(sql, {})` and an object whose keys match no `:name` run as before.
- The package's own statements with values go through `execute`: the
  service-name lookup of `ServiceNames` and, in `ClusterHashing`,
  `SP_NodeServiceUpdate`, `SP_NodeInsert` and the `information_schema`
  checks of `_upgradeInPlace()`. So a server with the mode does not stop
  them. Its statements without values still go through `query()`.
- **A connection learns the mode only from an OK header**: the reply to a
  `SET`, an `INSERT`, an `UPDATE`, a `USE` (the one the pool sends too), a
  `CALL` or a `DO`. Never from rows: mysql2 reads the status flags of the
  end of the rows for itself and does not pass them on. The pool does not
  read the status flags of the server greeting either, and mysql2 does not
  show the header of the reply to a reset. So the mode is unknown on a new
  connection, after every reset, and on a connection that only returned
  rows.
- **`DO 0` when the mode is unknown.** For a `query()` with values in its
  text on such a connection, the prepare step of the borrow sends one
  `DO 0` after the reset and the `USE`, and its header sets the mode
  before the guard reads it. `DO 0` has the `timeout` of the query and is
  watched as the `USE` is: packets out of order and the signal end it, an
  error or a timeout fails the call with `sent: false` (step 8 may try the
  next node), and a timeout destroys the connection. The cost is one
  `DO 0` per connection and per reset, only for calls that write values
  into the text: `execute`, a `query()` without values,
  `multiStatementQuery()` and the health check never send it. Under the
  mode `execute()` is the only safe way to send values.
- The bit of each later OK header is read again: one without it lets
  values through again. A reply of rows leaves the state as it was.

## Public API summary

| Member | Source | Notes |
| --- | --- | --- |
| `connected: boolean` | [`connected`](../../src/cluster/GaleraCluster.ts) | Flipped to `true` by the first successful pool connect; reset to `false` by `disconnect()`. |
| `pools: Pool[]` (getter) | [`pools`](../../src/cluster/GaleraCluster.ts) | Tagged `@internal`. Used by `ClusterHashing`, `ServiceNames`, and the test harness; not meant for consumers. Apps use the node API below instead. |
| `connect(): Promise<void>` | [`connect`](../../src/cluster/GaleraCluster.ts) | Resolves on the first pool that comes up; rejects on the first failure before any success. Resolves at once without hosts. A second call without `disconnect()` settles with the cluster. |
| `disconnect(): Promise<void>` | [`disconnect`](../../src/cluster/GaleraCluster.ts) | Synchronous in practice — does not await pool disconnects. |
| `on(event, callback)` | [`on`](../../src/cluster/GaleraCluster.ts) | Pass-through to the shared `Events` emitter. |
| `query<T>(sql, values?, queryOptions?)` | [`query`](../../src/cluster/GaleraCluster.ts) | The full routing pipeline described above. |
| `execute<T>(sql, values?, queryOptions?)` | [`execute`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. `query()` with the option `execute`: values bound by the server. No Redis. |
| `ready: Promise<INodeReadyResult[]>` (getter) | [`ready`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. Resolves once every pool finished the first connect of the current `connect()` call. Never rejects. A result has `checkError` when the health check of that connect did not get its answer. |
| `firstReady: Promise<INodeReadyResult[]>` (getter) | [`firstReady`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. Resolves when the first pool passed the first connect of the current `connect()` call, with the results that are in by then. With every result when none passed. Never rejects. |
| `getConnection(options?)` | [`getConnection`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. One connection of the valid node with the lowest load score. The `signal` option ends the wait: the call rejects with the reason of the signal. The connection is probed on the way out when it was idle, and its `release()` resets it before it goes back (#93). |
| `failWaiting(nodeId, error): number` | [`failWaiting`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. Fails the requests that wait for a connection of one node. |
| `getPoolStats(): INodePoolStats[]` | [`getPoolStats`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. Used, idle and waiting connections per node. |
| `nodes(): INodeInfo[]` | [`nodes`](../../src/cluster/GaleraCluster.ts) | Since 4.0.0. A snapshot of the nodes as plain objects. A node has `checkError` when its last health check did not get its answer. |

The last six rows are the node API. Its contract, errors and examples are in
[../node-api.md](../node-api.md).

`getConnection()` reads its options in this order: `exclude`, then `signal`,
then whether the signal is already aborted. Only after that it calls
`_validPools`, so an aborted call asks no node. `_isAbortSignal` tells a
signal by its members, a boolean `aborted` and the functions
`addEventListener` and `removeEventListener`, not by its class. The signal
goes to `Pool.getConnection(signal, outcome)`, which does the waiting, the
probe and the abort through the borrow, see
[pool.md](./pool.md#borrow-taking-and-giving-back-a-connection). It also
lends the connection, so the app's `release()` goes through the borrow;
the cluster does nothing more to it. The cluster adds `nodeId` to a
rejection of the pool unless the pool set `outcome.aborted`: the reason of
an abort goes back to the app as it is.
