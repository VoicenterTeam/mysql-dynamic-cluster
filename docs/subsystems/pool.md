# Subsystem: `Pool`

`Pool` is a thin wrapper around `mysql2.createPool` paired with a
`PoolStatus` health checker. One `Pool` instance represents one Galera
node: it owns the underlying `mysql2.Pool`, forwards mysql2's
connection-lifecycle events onto the shared `Events` bus, runs queries
(optionally caching their results in Redis), and exposes a transactional
multi-statement helper. The `PoolStatus` companion polls `SHOW GLOBAL
STATUS` on a timer to decide whether the node is still routable; see
[health-and-scoring.md](health-and-scoring.md) for that subsystem (and
[../architecture.md](../architecture.md) for where `Pool` sits in the
boot flow).

Source: [src/pool/Pool.ts](../../src/pool/Pool.ts).

## Construction

[src/pool/Pool.ts:65-92](../../src/pool/Pool.ts#L65).

The constructor takes `(settings: IUserPoolSettings, clusterName:
string)`. The `clusterName` argument is currently unused inside `Pool`
itself; `GaleraCluster` still passes it through for symmetry with other
subsystems. Fields populated from `settings`:

- `id` ← `settings.id`
  ([src/pool/Pool.ts:66](../../src/pool/Pool.ts#L66)).
- `host` ← `settings.host`
  ([src/pool/Pool.ts:67](../../src/pool/Pool.ts#L67)).
- `port` ← `settings.port`
  ([src/pool/Pool.ts:68](../../src/pool/Pool.ts#L68)).
- `name` ← `settings.name`, falling back to `` `${host}:${port}` `` when
  not provided
  ([src/pool/Pool.ts:69](../../src/pool/Pool.ts#L69)).
- `_user`, `_password`, `_database` ← the matching settings fields
  ([src/pool/Pool.ts:72-74](../../src/pool/Pool.ts#L72)).
- `_queryTimeout`, `_slowQueryTime`, `_redisFactor`, `_redisExpire` ←
  the matching settings fields
  ([src/pool/Pool.ts:75-78](../../src/pool/Pool.ts#L75)).
- `connectionLimit` ← `settings.connectionLimit`
  ([src/pool/Pool.ts:81](../../src/pool/Pool.ts#L81)).

After the fields are wired the constructor builds the companion
`PoolStatus` with `active = false`. Since 3.2.2
`Pool.availableConnectionCount` is a getter read from mysql2's own lists:
`connectionLimit - _allConnections.length + _freeConnections.length`
(the limit before `connect()`), so destroyed connections are counted
right. `PoolStatus.availableConnectionCount` returns it. The mysql2 pool
itself is **not** created here; that happens lazily in `connect()`.

## `connect()`

[src/pool/Pool.ts:97-125](../../src/pool/Pool.ts#L97).

`connect()` is `async` and is the first method `GaleraCluster.connect`
calls on each pool. The steps:

1. Without `flags` in the pool settings, log in once to read the server's
   greeting and pick the flags the node needs
   ([src/pool/ServerFlags.ts](../../src/pool/ServerFlags.ts), rule and log
   lines in [configuration.md](../configuration.md#flags)). A failed login
   does not stop `connect()`. A `disconnect()` during this step makes
   `connect()` reject without opening a pool, and a query that reaches
   the pool during this step is rejected with `POOL_NOT_CONNECTED`.
   Then build the underlying mysql2 pool via `mysql.createPool({ host, port,
   user, password, database, connectionLimit })`, plus `flags` from the
   settings or from that decision
   ([src/pool/Pool.ts](../../src/pool/Pool.ts)).
2. Mark the status as active (`this.status.startTimerCheck()`, which sets
   `status.active = true`)
   ([src/pool/Pool.ts:115](../../src/pool/Pool.ts#L115)). Setting
   `active` to `true` is the trigger for `PoolStatus` to start its
   recurring `SHOW GLOBAL STATUS` poller — see
   [health-and-scoring.md](health-and-scoring.md) for the timer semantics.
   The same call turns the check timer on again, which matters for a
   pool that was disconnected before.
3. Wire mysql2's per-connection events through `_connectEvents`
   ([src/pool/Pool.ts:116](../../src/pool/Pool.ts#L116)).
4. Run one synchronous (well, `await`ed) `status.checkStatus()` to
   validate the node before declaring success
   ([src/pool/Pool.ts:117](../../src/pool/Pool.ts#L117)).
5. If `status.isValid`, emit `'pool_connected'` with the pool id
   ([src/pool/Pool.ts:119-121](../../src/pool/Pool.ts#L119)); otherwise
   throw `Error("pool in host " + host + " is not valid")` so the
   cluster can log the failure and continue with the remaining pools
   ([src/pool/Pool.ts:122-124](../../src/pool/Pool.ts#L122)).

The `'pool_connected'` event is documented in
[../events.md](../events.md).

## `_connectEvents()`

[src/pool/Pool.ts:201-218](../../src/pool/Pool.ts#L201).

Private helper. Subscribes to the underlying `mysql2.Pool`'s three
connection-lifecycle events and re-emits each one onto the shared
`Events` bus. (Before 3.2.2 it also kept `availableConnectionCount` by
hand, `--` on `connection` and `++` on `release`, which climbed with every
reuse and dropped on every destroy.)

- `connection` — log, emit
  `Events.emit('connection', connection, this.id)`
  ([src/pool/Pool.ts:202-205](../../src/pool/Pool.ts#L202)).
- `release` — log, emit
  `Events.emit('release', connection, this.id)`
  ([src/pool/Pool.ts:207-211](../../src/pool/Pool.ts#L207)).
- `acquire` — log and emit `Events.emit('acquire', connection,
  this.id)`
  ([src/pool/Pool.ts:213-217](../../src/pool/Pool.ts#L213)).

See [../events.md](../events.md) for the payload shapes consumers
actually receive (note the `Events.emit` args-wrap quirk documented
there).

## `disconnect()`

[src/pool/Pool.ts:223-240](../../src/pool/Pool.ts#L223).

Synchronous. Steps:

1. Drop the login of a `connect()` that still asks the server for its
   version, socket included, so that `connect()` rejects, opens no pool
   and leaves nothing that keeps the process running. Then call
   `this._pool.end(callback)` when a mysql2 pool exists; the callback only
   logs an error if one is reported
   ([src/pool/Pool.ts:225-233](../../src/pool/Pool.ts#L225)).
2. Set `status.active = false` and call `status.stopTimerCheck()` to
   shut down the `PoolStatus` polling timer. A check that is still
   running after this changes nothing and reports nothing
   ([src/pool/Pool.ts:234-235](../../src/pool/Pool.ts#L234)).
3. Emit `'pool_disconnected'` with the pool id
   ([src/pool/Pool.ts:237](../../src/pool/Pool.ts#L237)).

`pool.end` is callback-style and not awaited; the method returns before
the mysql2 pool has actually flushed in-flight connections. Callers
that need a hard guarantee of shutdown should subscribe to
`'pool_disconnected'` or, better, drive shutdown through
`GaleraCluster.disconnect()` which sequences pools and the hashing
helper.

## `query()`

[src/pool/Pool.ts:247-324](../../src/pool/Pool.ts#L247).

`async query<T extends QueryResult>(sql: string, queryOptions?:
IQueryOptions): Promise<T | T[]>`. The body wraps a callback-style
mysql2 chain in `new Promise(...)`. The method is the single execution
point used by `GaleraCluster.query` once a node has been picked.

### Option defaults

The provided `queryOptions` (or `{}`) is merged on top of the pool's
own defaults:
`{ timeout: _queryTimeout, database: _database, redisFactor:
_redisFactor, redisExpire: _redisExpire, ...queryOptions }`
([src/pool/Pool.ts:252-258](../../src/pool/Pool.ts#L252)). Caller
overrides win.

### Metric tagging

A `poolMetricOption` is built from the pool's name, host and port, the
query's database and its SQL (`_metricOptions` in
[src/pool/Pool.ts](../../src/pool/Pool.ts)). If the caller passes a
`serviceId`, `serviceName` is added too, defaulting to `String(serviceId)`
when not provided. The options go to one `Metrics.recordOperation` call
per attempt, with the error on failure, so `mysql_dynamic_cluster.operation.duration`
can be broken down by pool, service and error type. See
[metrics.md](./metrics.md).

### Execution sequence

The `Promise` callback chain is, in order
([src/pool/Pool.ts:287-322](../../src/pool/Pool.ts#L287)):

1. `_pool.getConnection((err, conn) => { ... })` — checks out a raw
   `mysql2.PoolConnection`. On error, records the
   attempt with its `error.type` and rejects; if `conn` is falsy a
   second guard rejects with `"Can't find connection. Maybe it was
   unexpectedly closed."`.
2. `conn.changeUser({ database: queryOptions.database }, ...)` — swaps
   the database on the borrowed connection so the same `Pool` can serve
   queries against multiple databases.
   It runs through `Pool._changeUser`, which adds a `queryOptions.timeout`
   timer (mysql2 ignores `changeUser`'s own timeout option). The query is
   only sent from its success callback.
3. `conn.query({ sql, timeout: queryOptions.timeout }, ...)` — runs the
   SQL. On success the connection is `release()`d. On error it goes
   through `fail()`, which settles once and hands the connection back
   once: `destroy()` after a fatal error (a failed `changeUser` is always
   fatal) or `PROTOCOL_SEQUENCE_TIMEOUT` (the statement is still running
   on the server), `release()` after a plain SQL error.
4. On success: stops the `QueryTimer`, records the attempt as
   `mysql_dynamic_cluster.operation.duration`, logs a slow-query
   warning if `queryTimer.get() >= _slowQueryTime`
   ([src/pool/Pool.ts:306-308](../../src/pool/Pool.ts#L306)),
   optionally writes the
   result to Redis (see below), and resolves with the mysql2 result.

### Passive health

Every failure of `query()` goes through `fail(error, conn?)`. For a query
of the app it calls `status.realFailure(error, !conn)` before it rejects:
without a connection the error came in place of one, with one it came on a
connection the pool had handed out. `PoolStatus` decides what the error
says about the node, and does nothing for a node without a `healthCheck`
block. See
[health-and-scoring.md](health-and-scoring.md#passive-health).

The status query of a health check runs through `query()` too, and is not
told: `query()` asks `PoolStatus.isCheckQuery(queryOptions)` first, on the
object it was called with, before it copies the options.

`multiStatementQuery()` tells every failure the same way, and a `ROLLBACK`
that failed as an error on a connection. `getConnection()` tells an error
of mysql2 as one that came in place of a connection, also when the signal
ended the call before the error came. The abort itself is not told.

### Redis cache write

If `queryOptions.redis` is truthy
([src/pool/Pool.ts:310-317](../../src/pool/Pool.ts#L310)), the
successful result is serialised into an `IRedisData`:

- `data`: the raw query result.
- `expired`: `Date.now() + queryTime * 1000 * queryOptions.redisFactor`
  — a payload-level soft TTL the consumer can check independently of
  the Redis key TTL.

`Redis.set(sql, JSON.stringify(redisData), queryOptions.redisExpire)`
writes the entry with the key-level TTL set to `redisExpire`
seconds. The cache key is the raw SQL string.

### Error handling before 3.2.2

Before 3.2.2 no error branch returned after `reject(...)`, the query was
sent even when `changeUser` failed, and every error ended in
`release()` — so a timed-out connection went back to the pool while
still busy. See
[../known-issues.md#1-poolquery-does-not-return-after-reject](../known-issues.md#1-poolquery-does-not-return-after-reject)
and [#1a](../known-issues.md#1a-connections-released-back-to-the-pool-after-a-timeout-or-failed-changeuser).

## `multiStatementQuery()`

[src/pool/Pool.ts:331-414](../../src/pool/Pool.ts#L331).

`async multiStatementQuery<T extends QueryResult>(sqls: string[],
queryOptions: IQueryOptions): Promise<T[]>`. Wraps a series of SQL
statements in a single mysql2 transaction. Used by `ClusterHashing` to
ship the SQL-asset bootstrap statements as one atomic unit (see
[../sql-assets.md](../sql-assets.md)).

### Option defaults

Same merge pattern as `query()`, but the Redis-related defaults are
omitted — this method does not cache:
`{ timeout: _queryTimeout, database: _database, ...queryOptions }`
([src/pool/Pool.ts:333-337](../../src/pool/Pool.ts#L333)).

### Execution sequence

[src/pool/Pool.ts:372-412](../../src/pool/Pool.ts#L372):

1. `_pool.getConnection(...)` — same guards as `query()`. Reject on
   error or missing `conn`.
2. `conn.changeUser({ database }, ...)` — same database swap.
3. `START TRANSACTION` (sent with `queryOptions.timeout`) — open a transaction. On error,
   `conn.release()` and reject.
4. Run the statements one after another: each `conn.query` starts from
   the previous one's callback, and results are collected in order.
5. `COMMIT` (sent with `queryOptions.timeout`) — issued only after the last
   statement succeeded. A timed-out `COMMIT` destroys the connection; whether
   it committed on the server is unknown.
6. Record the transaction as one `mysql_dynamic_cluster.operation.duration`
   sample, `conn.release()`, and
   `resolve(results)`.

Any error stops the sequence, records the attempt once with its
`error.type` and rejects.
A query or commit error sends `ROLLBACK` (with `queryOptions.timeout`),
then releases — or destroys, if the rollback itself fails. After a fatal
error or `PROTOCOL_SEQUENCE_TIMEOUT` the connection is destroyed instead
(no rollback — closing the socket makes the server discard the
transaction). Before 3.2.2 the statements were fired from a `forEach`
and committed before any of them ran — see
[../known-issues.md#2-poolmultistatementquery-commits-before-queries-finish](../known-issues.md#2-poolmultistatementquery-commits-before-queries-finish).

## Node API helpers

Added in 4.5.0, at the end of the class, so the line references above did
not move. `GaleraCluster` calls them for the node API of
[../node-api.md](../node-api.md). `_pool` stays private.

- `getConnection(signal?, outcome?)` takes one connection from the mysql2
  pool and resolves with it as it is. It does not change the database, sets
  no timeout and records no metric. It rejects with the error object of
  mysql2, or with `POOL_NOT_CONNECTED` before `connect()` created the mysql2
  pool. An error of mysql2 is told to [passive health](#passive-health)
  first. Without a signal it does what it did before. With one, see
  [A signal on getConnection](#a-signal-on-getconnection).
- `failWaiting(error)` empties `_connectionQueue` of the mysql2 pool, then
  calls every callback it took out with `error`, and returns how many. The
  queue is emptied first, so a callback that asks for a connection again is
  not failed in the same call. A callback that throws is logged and the
  others are still called. It returns `0` before the mysql2 pool exists.
- `stats()` returns `{ used, idle, pending }` from mysql2's own lists:
  `_allConnections.length - _freeConnections.length`,
  `_freeConnections.length` and `_connectionQueue.length`. All zeros before
  the mysql2 pool exists. The pool connection metrics read it at each
  collection, see [metrics.md](./metrics.md#pool-connection-metrics).

Added in 4.6.0, after them, for `checkError` and `firstReady` of the node
API:

- `checkError` (getter) returns `status.checkError`: what the last health
  check failed with, reduced to `code`, `errno` and `sqlState`, or
  `undefined`. See
  [health-and-scoring.md](health-and-scoring.md#the-error-of-the-last-check).
- `connect(outcome?)` takes an object from its caller and fills it with how
  the health check of that call ended (`ICheckOutcome`). `_newAttempt`, at
  the end of the class, sets `recorded: false` before `connect()` first
  waits. `status.checkStatus(outcome)` sets `recorded: true` when the check
  ended while the pool was still running, and adds the reduced `checkError`
  when it failed. A check that was dropped by a `disconnect()`, and a
  `connect()` that is given up before its check, leave `recorded: false`.
  Each call fills its own object, also when two calls overlap.
  `GaleraCluster` builds the results of `ready` and `firstReady` from it.
  The steps of `connect()` above did not change, and no line number of the
  references above moved.

### A signal on getConnection

`GaleraCluster.getConnection()` hands the `signal` of its options to
`getConnection(signal, outcome)`. The contract is in
[../node-api.md](../node-api.md#give-up-the-wait-with-a-signal). Inside the
pool it works like this:

- A signal that is already aborted rejects the call before `_pool` is
  looked at. mysql2 is not asked.
- Otherwise the pool puts one `abort` listener on the signal and then asks
  mysql2. The listener goes on first, because mysql2 can call back inside
  the request, and the callback takes the listener off again.
- The call has two ends, the callback of mysql2 and the listener. Two flags
  say which came first, and the second one does nothing to the promise.
- The callback comes first: the listener is taken off and the promise is
  resolved or rejected as without a signal.
- The listener comes first: it takes itself off, calls `_leaveQueue` for
  the mysql2 pool the request went to, and rejects the promise with
  `Pool.abortReason(signal)`. When the callback comes later with a
  connection, `_releaseLate` releases it. When it comes with an error, the
  error is dropped and nothing is logged.
- mysql2 throws inside the request, which happens when a listener of one of
  its events throws: the listener is taken off and the promise rejects with
  what was thrown, as it did before.

`_leaveQueue(mysqlPool, callback)` looks for the callback in
`_connectionQueue` of that mysql2 pool with the `get` of that queue, and
takes it out with `removeOne`, so the entries around it keep their order.
It does nothing when the callback is not in it. It leaves a queue alone that
is missing or has no `get` or `removeOne`, which would be a mysql2 that
keeps its queue another way. No aborted request can leave such a queue, so
the pool says so at `warn`, with `nodeId` and `pool`. It says it once for a
mysql2 pool: `_unsearchable` is a `WeakSet` of the mysql2 pools it reported.
The callback is not in it while its connection logs in, and when mysql2
queued a wrapper of it, which it does while something subscribes to its
tracing channel `mysql2:pool:connect`. In each of those cases the request is
settled by the release on arrival instead, and nothing is logged: the pool
cannot tell the two apart. The listener runs inside the
`abort()` of the app, so what it does to the queue sits in a `try`. A throw
there is logged at `warn` with `nodeId`, `pool` and `error`, and the promise
is still rejected.

`_releaseLate(connection)` calls `connection.release()` in a `try`. It runs
in the callback of mysql2, where a throw would be an uncaught exception,
and `release()` runs the `release` listeners of the app. mysql2 pushes the
connection onto its free list before it emits `release`, and the listener
of the pool tells the idle reaper before it emits the event of the cluster.
So after a listener of the app threw, the connection is idle in the pool
and the reaper knows it. The throw is logged at `warn` with `nodeId`, `pool`
and `error`.

`Pool.abortReason(signal)` is static. It returns `signal.reason`, or, when
the signal has none, an `Error` with the name `AbortError`, the code
`ABORT_ERR` and the message `The operation was aborted`, as the `AbortError`
of Node has them. The cluster uses it for a signal that is already aborted,
before it picks a pool.

`outcome` is an `IAbortOutcome`, an object of the caller that the pool fills
with `aborted: true` when the abort ended the call. The cluster reads it to
leave the reason alone: it adds `nodeId` to every other rejection. The state
of the signal cannot tell the two apart, since a signal can abort just after
an error ended the call.

The errors `Pool` makes with a code of its own are marked with
`PoolStatus.ownError()`, so a health check that fails with one reports an
empty `checkError`: the `POOL_NOT_CONNECTED` error of `_notConnected()` and
the `PROTOCOL_SEQUENCE_TIMEOUT` error of the timer in `_changeUser`.
`failWaiting(error)` marks the error of the app the same way. The mark
changes nothing on the error object, and `query()`, `getConnection()` and
the waiting requests reject with it as before.

## Public API summary

| Member | Kind | Source |
| --- | --- | --- |
| `id` | `readonly number` | [:26](../../src/pool/Pool.ts#L26) |
| `name` | `readonly string` | [:27](../../src/pool/Pool.ts#L27) |
| `host` | `readonly string` | [:28](../../src/pool/Pool.ts#L28) |
| `port` | `readonly number` | [:29](../../src/pool/Pool.ts#L29) |
| `connectionLimit` | `readonly number` | [:31](../../src/pool/Pool.ts#L31) |
| `status` | getter returning `PoolStatus` | [:22-24](../../src/pool/Pool.ts#L22) |
| `connect(outcome?)` | `async (outcome?: ICheckOutcome) => Promise<void>` | [:97](../../src/pool/Pool.ts#L97) |
| `disconnect()` | `() => void` | [:223](../../src/pool/Pool.ts#L223) |
| `query<T>(sql, options?)` | `async => Promise<T \| T[]>` | [:247](../../src/pool/Pool.ts#L247) |
| `multiStatementQuery<T>(sqls, options)` | `async => Promise<T[]>` | [:331](../../src/pool/Pool.ts#L331) |
| `getConnection(signal?, outcome?)` | `(signal?: AbortSignal, outcome?: IAbortOutcome) => Promise<PoolConnection>` | [`getConnection`](../../src/pool/Pool.ts) |
| `Pool.abortReason(signal)` | `static (signal: AbortSignal) => unknown` | [`abortReason`](../../src/pool/Pool.ts) |
| `failWaiting(error)` | `(error: Error) => number` | [`failWaiting`](../../src/pool/Pool.ts) |
| `stats()` | `() => { used, idle, pending }` | [`stats`](../../src/pool/Pool.ts) |
| `checkError` | getter returning `INodeCheckError \| undefined` | [`checkError`](../../src/pool/Pool.ts) |

Consumers normally talk to `GaleraCluster`, not to `Pool` directly;
the cluster picks a healthy pool via its routing logic and then
delegates to `Pool.query`. Direct construction of a `Pool` is
supported but undocumented in the README — its primary use case is the
test suite (see [../testing.md](../testing.md)).
