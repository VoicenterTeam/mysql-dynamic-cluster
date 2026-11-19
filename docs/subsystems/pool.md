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
boot flow). A node with a `healthCheck` block holds one more connection,
next to the mysql2 pool, for those checks: see
[The check connection](#the-check-connection).

Source: [src/pool/Pool.ts](../../src/pool/Pool.ts),
[src/pool/CheckConnection.ts](../../src/pool/CheckConnection.ts).

## Construction

[src/pool/Pool.ts:71-99](../../src/pool/Pool.ts#L71).

The constructor takes `(settings: IUserPoolSettings, clusterName:
string)`. The `clusterName` argument is currently unused inside `Pool`
itself; `GaleraCluster` still passes it through for symmetry with other
subsystems. Fields populated from `settings`:

- `id` ← `settings.id`
  ([src/pool/Pool.ts:72](../../src/pool/Pool.ts#L72)).
- `host` ← `settings.host`
  ([src/pool/Pool.ts:73](../../src/pool/Pool.ts#L73)).
- `port` ← `settings.port`
  ([src/pool/Pool.ts:74](../../src/pool/Pool.ts#L74)).
- `name` ← `settings.name`, falling back to `` `${host}:${port}` `` when
  not provided
  ([src/pool/Pool.ts:75](../../src/pool/Pool.ts#L75)).
- `_user`, `_password`, `_database` ← the matching settings fields
  ([src/pool/Pool.ts:78-80](../../src/pool/Pool.ts#L78)).
- `_queryTimeout`, `_slowQueryTime`, `_redisFactor`, `_redisExpire` ←
  the matching settings fields
  ([src/pool/Pool.ts:81-84](../../src/pool/Pool.ts#L81)).
- `connectionLimit` ← `settings.connectionLimit`
  ([src/pool/Pool.ts:87](../../src/pool/Pool.ts#L87)).

After the fields are wired the constructor builds the companion
`PoolStatus` with `active = false`. Since 3.2.2
`Pool.availableConnectionCount` is a getter read from mysql2's own lists:
`connectionLimit - _allConnections.length + _freeConnections.length`
(the limit before `connect()`), so destroyed connections are counted
right. `PoolStatus.availableConnectionCount` returns it. The mysql2 pool
itself is **not** created here; that happens lazily in `connect()`.

## `connect()`

[src/pool/Pool.ts:104-141](../../src/pool/Pool.ts#L104).

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
   ([src/pool/Pool.ts](../../src/pool/Pool.ts)). For a node with a
   `healthCheck` block, set up its
   [check connection](#the-check-connection) with the same options and
   flags. No socket is opened here: the check of step 4 opens it. A check
   connection that an earlier `connect()` left, because no `disconnect()`
   came in between, is logged out of first.
2. Mark the status as active (`this.status.startTimerCheck()`, which sets
   `status.active = true`)
   ([src/pool/Pool.ts:131](../../src/pool/Pool.ts#L131)). Setting
   `active` to `true` is the trigger for `PoolStatus` to start its
   recurring `SHOW GLOBAL STATUS` poller — see
   [health-and-scoring.md](health-and-scoring.md) for the timer semantics.
   The same call turns the check timer on again, which matters for a
   pool that was disconnected before.
3. Wire mysql2's per-connection events through `_connectEvents`
   ([src/pool/Pool.ts:132](../../src/pool/Pool.ts#L132)).
4. Run one synchronous (well, `await`ed) `status.checkStatus()` to
   validate the node before declaring success
   ([src/pool/Pool.ts:133](../../src/pool/Pool.ts#L133)).
5. If `status.isValid`, emit `'pool_connected'` with the pool id
   ([src/pool/Pool.ts:135-137](../../src/pool/Pool.ts#L135)); otherwise
   throw `Error("pool in host " + host + " is not valid")` so the
   cluster can log the failure and continue with the remaining pools
   ([src/pool/Pool.ts:138-140](../../src/pool/Pool.ts#L138)).

The `'pool_connected'` event is documented in
[../events.md](../events.md).

## `_connectEvents()`

[src/pool/Pool.ts:217-234](../../src/pool/Pool.ts#L217).

Private helper. Subscribes to the underlying `mysql2.Pool`'s three
connection-lifecycle events and re-emits each one onto the shared
`Events` bus. (Before 3.2.2 it also kept `availableConnectionCount` by
hand, `--` on `connection` and `++` on `release`, which climbed with every
reuse and dropped on every destroy.)

- `connection` — log, emit
  `Events.emit('connection', connection, this.id)`
  ([src/pool/Pool.ts:218-221](../../src/pool/Pool.ts#L218)).
- `release` — log, emit
  `Events.emit('release', connection, this.id)`
  ([src/pool/Pool.ts:223-227](../../src/pool/Pool.ts#L223)).
- `acquire` — log and emit `Events.emit('acquire', connection,
  this.id)`
  ([src/pool/Pool.ts:229-233](../../src/pool/Pool.ts#L229)).

See [../events.md](../events.md) for the payload shapes consumers
actually receive (note the `Events.emit` args-wrap quirk documented
there).

## `disconnect()`

[src/pool/Pool.ts:239-258](../../src/pool/Pool.ts#L239).

Synchronous. Steps:

1. Drop the login of a `connect()` that still asks the server for its
   version, socket included, so that `connect()` rejects, opens no pool
   and leaves nothing that keeps the process running. Log out of the
   [check connection](#the-check-connection) when the node holds one. Then call
   `this._pool.end(callback)` when a mysql2 pool exists; the callback only
   logs an error if one is reported
   ([src/pool/Pool.ts:241-251](../../src/pool/Pool.ts#L241)).
2. Set `status.active = false` and call `status.stopTimerCheck()` to
   shut down the `PoolStatus` polling timer. A check that is still
   running after this changes nothing and reports nothing
   ([src/pool/Pool.ts:252-253](../../src/pool/Pool.ts#L252)).
3. Emit `'pool_disconnected'` with the pool id
   ([src/pool/Pool.ts:255](../../src/pool/Pool.ts#L255)).

`pool.end` is callback-style and not awaited; the method returns before
the mysql2 pool has actually flushed in-flight connections. Callers
that need a hard guarantee of shutdown should subscribe to
`'pool_disconnected'` or, better, drive shutdown through
`GaleraCluster.disconnect()` which sequences pools and the hashing
helper.

## `query()`

[src/pool/Pool.ts:265-341](../../src/pool/Pool.ts#L265).

`async query<T extends QueryResult>(sql: string, queryOptions?:
IQueryOptions): Promise<T | T[]>`. The body wraps a callback-style
mysql2 chain in `new Promise(...)`. The method is the single execution
point used by `GaleraCluster.query` once a node has been picked.

### Option defaults

The provided `queryOptions` (or `{}`) is merged on top of the pool's
own defaults:
`{ timeout: _queryTimeout, database: _database, redisFactor:
_redisFactor, redisExpire: _redisExpire, ...queryOptions }`
([src/pool/Pool.ts:267-273](../../src/pool/Pool.ts#L267)). Caller
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
([src/pool/Pool.ts:304-339](../../src/pool/Pool.ts#L304)):

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
   ([src/pool/Pool.ts:323-325](../../src/pool/Pool.ts#L323)),
   optionally writes the
   result to Redis (see below), and resolves with the mysql2 result.

### Passive health

Every failure of `query()` goes through `fail(error, conn?)`. It calls
`status.realFailure(error, !conn)` before it rejects:
without a connection the error came in place of one, with one it came on a
connection the pool had handed out. `PoolStatus` decides what the error
says about the node, and does nothing for a node without a `healthCheck`
block. See
[health-and-scoring.md](health-and-scoring.md#passive-health).

The status query of a health check is never told. For a node with a
`healthCheck` block it does not run through `query()` at all: it is asked
on the [check connection](#the-check-connection). For a node without the
block it does run through `query()`, as in 4.6.0, and passive health does
nothing for such a node.

`multiStatementQuery()` tells every failure the same way, and a `ROLLBACK`
that failed as an error on a connection. `getConnection()` tells an error
of mysql2 as one that came in place of a connection, also when the signal
ended the call before the error came. The abort itself is not told.

### Redis cache write

If `queryOptions.redis` is truthy
([src/pool/Pool.ts:327-334](../../src/pool/Pool.ts#L327)), the
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

[src/pool/Pool.ts:348-431](../../src/pool/Pool.ts#L348).

`async multiStatementQuery<T extends QueryResult>(sqls: string[],
queryOptions: IQueryOptions): Promise<T[]>`. Wraps a series of SQL
statements in a single mysql2 transaction. Used by `ClusterHashing` to
ship the SQL-asset bootstrap statements as one atomic unit (see
[../sql-assets.md](../sql-assets.md)).

### Option defaults

Same merge pattern as `query()`, but the Redis-related defaults are
omitted — this method does not cache:
`{ timeout: _queryTimeout, database: _database, ...queryOptions }`
([src/pool/Pool.ts:350-354](../../src/pool/Pool.ts#L350)).

### Execution sequence

[src/pool/Pool.ts:389-429](../../src/pool/Pool.ts#L389):

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

## The check connection

[src/pool/CheckConnection.ts](../../src/pool/CheckConnection.ts). Not in
4.6.0 or earlier, and only for a node with a `healthCheck` block. A node
without the block opens none, and its check asks through `query()` as
before.

The health check of a node with the block asks on one connection of its
own, next to the mysql2 pool and never part of it. So a check never waits
in the queue of a pool that is at its limit, and it takes no connection
away from the app. The rules of the check are in
[health-and-scoring.md](health-and-scoring.md#the-check-connection).

- **Opened with the options of the pool.** `mysql.createConnection` gets
  what `_connectionOptions()` gives the pool, and the same `flags`, from
  the settings or from the server. It gets no `connectionLimit`, and no
  option the pool does not get.
- **From `connect()` to `disconnect()`.** `connect()` makes the
  `CheckConnection` object and its first check opens the socket, inside
  the timeout of that check. `disconnect()` logs out with one `COM_QUIT`
  and drops the socket after 2 s when the server keeps it, as the login
  that reads the server version does. `connect()`, `disconnect()`,
  `connect()` leaves one check connection open, and `disconnect()` leaves
  none.
- **A second `connect()` without a `disconnect()`** logs out of the
  connection the node held and holds a new one. A check that was still
  logging in or asking on the old one asks again on the new one, so it is
  no failed check. After a `disconnect()` this is not done: a check from
  before it is dropped. The timer that closes idle
  connections is started again as well, and the one before it ends. The
  mysql2 pool of the first `connect()` is not ended, as before: for a
  node with the block it holds no connection unless a query of the app
  opened one.
- **`checkQuery(sql)`** sends one query of a check: a change of user to
  the database of the node first, as `query()` does, then the query, with
  no `timeout` of mysql2. It opens a connection when the node holds none
  and waits for the server to take the login before it sends anything, so
  a login the server refuses arrives as mysql2 made it, not `fatal`. It
  tells nothing to passive health. It rejects with the error of mysql2, or
  with `POOL_NOT_CONNECTED` outside `connect()` and `disconnect()`. Each
  call is one record of `mysql_dynamic_cluster.operation.duration`, as a
  check through `query()` is.
- **`holdsCheckConnection`** is `true` while the node holds a connection:
  open, or logging in. `PoolStatus` reads it before a check asks, since
  only a connection held from before can be one the path forgot.
- **`dropCheckConnection()`** destroys the connection and its socket, with
  whatever was asked on it. `PoolStatus` calls it when a check ran into
  its timeout, so no late answer comes on that connection.
- **`checkQuery(sql, keeps)`**, with its second argument, sends the query
  on a new connection, opened beside the one the node holds. Once the new
  one logged in the node holds it and logs out of the old one. For a new
  one that did not log in, `keeps(error)` says whether the old one stays.
  `PoolStatus` calls it that way for a check that has to decide after a
  call of the app found no route or got no connection within the connect
  timeout, and keeps the old one after a new one that found no route. See
  [A check after a call that could open no connection](health-and-scoring.md#a-check-after-a-call-that-could-open-no-connection).
- **Kept or dropped as the pool does it.** A `fatal` error drops the
  connection, which every error of a change of user is. An error packet
  under the status query keeps it.
- **A listener for `error` stays on it.** mysql2 tells a connection that
  nobody asks on of its loss with an `error` event, and an `error` event
  without a listener ends the process. The listener drops the connection,
  and the next check opens a new one.
- **mysql2 gives a login 10 s.** The check connection takes the
  `connectTimeout` of mysql2 as the pool does. A check whose
  `healthCheck.timeout` is longer than 10 s ends a login that hangs after
  those 10 s, with `ETIMEDOUT`, and not at its own timeout.

What it costs and what an app sees:

- One more connection per node per process, counted against
  `max_connections` of the server. A cluster of three nodes with the block
  in eight processes holds 24 of them.
- The pool of a node holds no connection after `connect()`. Before, the
  check of `connect()` left one idle there. So the first query of the app
  to each node pays for a login.
- The events `connection`, `acquire` and `release` come from the mysql2
  pool. A check of a node with the block emits none of them.
- `getPoolStats()`, `stats()`, `availableConnectionCount` and the
  connection gauges read the mysql2 pool. They do not count the check
  connection.
- The warn of a slow query and the `debug` lines of `query()` do not come
  for the status query of a node with the block.
- A check after a call of the app that found no route or got no connection
  in time asks on a new connection, which is one more login when it opens,
  and for the time of that check the node holds two. A node with
  `passive: false` is told of no call. Its checks ask on the connection it
  holds, which answers also while no new connection reaches the node.

Pinned by
[tests/pool/check-connection.test.ts](../../tests/pool/check-connection.test.ts)
against a mysql2 the test drives, and with the real mysql2 on loopback by
the describe "the check connection of a healthCheck node" in
[tests/cluster/passive-health-loopback.test.ts](../../tests/cluster/passive-health-loopback.test.ts).

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
| `id` | `readonly number` | [:27](../../src/pool/Pool.ts#L27) |
| `name` | `readonly string` | [:28](../../src/pool/Pool.ts#L28) |
| `host` | `readonly string` | [:29](../../src/pool/Pool.ts#L29) |
| `port` | `readonly number` | [:30](../../src/pool/Pool.ts#L30) |
| `connectionLimit` | `readonly number` | [:32](../../src/pool/Pool.ts#L32) |
| `status` | getter returning `PoolStatus` | [:23-25](../../src/pool/Pool.ts#L23) |
| `connect(outcome?)` | `async (outcome?: ICheckOutcome) => Promise<void>` | [:104](../../src/pool/Pool.ts#L104) |
| `disconnect()` | `() => void` | [:239](../../src/pool/Pool.ts#L239) |
| `query<T>(sql, options?)` | `async => Promise<T \| T[]>` | [:265](../../src/pool/Pool.ts#L265) |
| `multiStatementQuery<T>(sqls, options)` | `async => Promise<T[]>` | [:348](../../src/pool/Pool.ts#L348) |
| `getConnection(signal?, outcome?)` | `(signal?: AbortSignal, outcome?: IAbortOutcome) => Promise<PoolConnection>` | [`getConnection`](../../src/pool/Pool.ts) |
| `Pool.abortReason(signal)` | `static (signal: AbortSignal) => unknown` | [`abortReason`](../../src/pool/Pool.ts) |
| `failWaiting(error)` | `(error: Error) => number` | [`failWaiting`](../../src/pool/Pool.ts) |
| `stats()` | `() => { used, idle, pending }` | [`stats`](../../src/pool/Pool.ts) |
| `checkError` | getter returning `INodeCheckError \| undefined` | [`checkError`](../../src/pool/Pool.ts) |
| `holdsCheckConnection` | getter returning `boolean` | [`holdsCheckConnection`](../../src/pool/Pool.ts) |
| `checkQuery<T>(sql, keeps?)` | `(sql: string, keeps?: (error: any) => boolean) => Promise<T>` | [`checkQuery`](../../src/pool/Pool.ts) |
| `dropCheckConnection()` | `() => void` | [`dropCheckConnection`](../../src/pool/Pool.ts) |

Consumers normally talk to `GaleraCluster`, not to `Pool` directly;
the cluster picks a healthy pool via its routing logic and then
delegates to `Pool.query`. Direct construction of a `Pool` is
supported but undocumented in the README — its primary use case is the
test suite (see [../testing.md](../testing.md)).
