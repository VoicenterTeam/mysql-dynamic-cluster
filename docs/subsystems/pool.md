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
[src/pool/CheckConnection.ts](../../src/pool/CheckConnection.ts),
[src/pool/IdleConnectionReaper.ts](../../src/pool/IdleConnectionReaper.ts).

## Construction

The constructor of `Pool` in [src/pool/Pool.ts](../../src/pool/Pool.ts).

The constructor takes `(settings: IUserPoolSettings, clusterName:
string)`. The `clusterName` argument is currently unused inside `Pool`
itself; `GaleraCluster` still passes it through for symmetry with other
subsystems. Fields populated from `settings`:

- `id` ← `settings.id`.
- `host` ← `settings.host`.
- `port` ← `settings.port`.
- `name` ← `settings.name`, falling back to `` `${host}:${port}` `` when
  not provided.
- `_user`, `_password`, `_database` ← the matching settings fields.
- `_queryTimeout`, `_slowQueryTime`, `_redisFactor`, `_redisExpire` ←
  the matching settings fields.
- `connectionLimit` ← `settings.connectionLimit`.

After the fields are wired the constructor builds the companion
`PoolStatus` with `active = false`. Since 3.2.2
`Pool.availableConnectionCount` is a getter read from mysql2's own lists:
`connectionLimit - _allConnections.length + _freeConnections.length`
(the limit before `connect()`), so destroyed connections are counted
right. `PoolStatus.availableConnectionCount` returns it. The mysql2 pool
itself is **not** created here; that happens lazily in `connect()`.

## `connect()`

`connect()` in [src/pool/Pool.ts](../../src/pool/Pool.ts).

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
   `status.active = true`). Setting
   `active` to `true` is the trigger for `PoolStatus` to start its
   recurring `SHOW GLOBAL STATUS` poller — see
   [health-and-scoring.md](health-and-scoring.md) for the timer semantics.
   The same call turns the check timer on again, which matters for a
   pool that was disconnected before.
3. Wire mysql2's per-connection events through `_connectEvents`.
4. Run one synchronous (well, `await`ed) `status.checkStatus()` to
   validate the node before declaring success.
5. If `status.isValid`, emit `'pool_connected'` with the pool id; otherwise
   throw `Error("pool in host " + host + " is not valid")` so the
   cluster can log the failure and continue with the remaining pools.

The `'pool_connected'` event is documented in
[../events.md](../events.md).

## `_connectEvents()`

`_connectEvents()` in [src/pool/Pool.ts](../../src/pool/Pool.ts).

Private helper. Subscribes to the underlying `mysql2.Pool`'s three
connection-lifecycle events and re-emits each one onto the shared
`Events` bus. (Before 3.2.2 it also kept `availableConnectionCount` by
hand, `--` on `connection` and `++` on `release`, which climbed with every
reuse and dropped on every destroy.)

- `connection` — log, emit
  `Events.emit('connection', connection, this.id)`.
- `release` — log, emit
  `Events.emit('release', connection, this.id)`.
- `acquire` — log and emit `Events.emit('acquire', connection,
  this.id)`.

See [../events.md](../events.md) for the payload shapes consumers
actually receive (note the `Events.emit` args-wrap quirk documented
there).

## `disconnect()`

`disconnect()` in [src/pool/Pool.ts](../../src/pool/Pool.ts).

Synchronous. Steps:

1. Drop the login of a `connect()` that still asks the server for its
   version, socket included, so that `connect()` rejects, opens no pool
   and leaves nothing that keeps the process running. Log out of the
   [check connection](#the-check-connection) when the node holds one. Then call
   `this._pool.end(callback)` when a mysql2 pool exists; the callback only
   logs an error if one is reported.
2. Set `status.active = false` and call `status.stopTimerCheck()` to
   shut down the `PoolStatus` polling timer. A check that is still
   running after this changes nothing and reports nothing. The line
   after them stops the timers of
   [the idle connections](#the-idle-connections-of-the-pool), and closes a
   connection whose ping is still out.
3. Emit `'pool_disconnected'` with the pool id.

`pool.end` is callback-style and not awaited; the method returns before
the mysql2 pool has actually flushed in-flight connections. Callers
that need a hard guarantee of shutdown should subscribe to
`'pool_disconnected'` or, better, drive shutdown through
`GaleraCluster.disconnect()` which sequences pools and the hashing
helper.

## `query()`

`query()` in [src/pool/Pool.ts](../../src/pool/Pool.ts).

`async query<T extends QueryResult>(sql: string, queryOptions?:
IQueryOptions, outcome?: IQueryOutcome, call?: IPoolCall): Promise<T | T[]>`.
The body wraps a callback-style mysql2 chain in `new Promise(...)`. The
method is the single execution point used by `GaleraCluster.query` once a
node has been picked, for a text statement and for a bound one alike.
`call.values` are those of the caller: with the option `execute` the server
binds them, without it the cluster wrote them into `sql` already.

### Option defaults

The provided `queryOptions` (or `{}`) is merged on top of the pool's
own defaults:
`{ timeout: _queryTimeout, database: _database, redisFactor:
_redisFactor, redisExpire: _redisExpire, ...queryOptions }`. Caller
overrides win.

### Metric tagging

A `poolMetricOption` is built from the pool's name, host and port, the
query's database and its SQL (`_metricOptions` in
[src/pool/Pool.ts](../../src/pool/Pool.ts)). If the caller passes a
`serviceId`, `serviceName` is added too, defaulting to `String(serviceId)`
when not provided. The options go to one `Metrics.recordOperation` call
per attempt, with the error on failure, so `mysql_dynamic_cluster.operation.duration`
can be broken down by pool, service and error type. Since 4.1.0 the call
also has the `step` the attempt ended in and the time it waited for a
connection, from `timing` (see the next section). The step becomes an
attribute, and the wait a record of `mysql_dynamic_cluster.connection.wait_time`.
See [metrics.md](./metrics.md#the-step-and-the-wait-of-an-attempt).

### Execution sequence

The `Promise` callback chain is, in order:

1. `_borrow.take({ signal, target, probe }, asked, timing)`, `target` being
   `{ database, timeout, valuesInText }` (`valuesInText` only without
   `execute`, and `timeout` clamped to 2147483647 ms, the longest wait of a
   timer) — takes a connection ready for the statement,
   see [Borrow](#borrow-taking-and-giving-back-a-connection): the queue of
   mysql2 and an abort while the request waits, the probe of a connection
   that was idle longer than `probeIdle`, or one the reaper's ping is
   still out on, then a reset when it is dirty,
   `USE` when it is on another database, and `DO 0` for a call with
   values in its text when the `sql_mode` of the connection is unknown, see
   [The session of a connection](#the-session-of-a-connection). Most of
   the time it sends nothing. No change of user is sent, since 4.0.0. On
   error, records the attempt with its `error.type` and rejects with
   `sent: false`: mysql2 gave no connection, `"Can't find connection.
   Maybe it was unexpectedly closed."`, every connection failed its probe,
   or the reset, `USE` or `DO 0` failed or timed out. With the `signal` query
   option, an abort in any of these steps destroys the connection the call
   holds, see [cluster.md](./cluster.md#the-signal-option).
2. From here on `_borrow.watch(conn, ...)` listens for packets out of
   order until the connection goes back: they drop it and fail the call at
   once with `MDC_PACKETS_OUT_OF_ORDER` and `sent: true`, see
   [Borrow](#borrow-taking-and-giving-back-a-connection). An abort of the
   signal destroys the connection, as before.
3. The guard, since 4.0.0: a call without `execute` whose `valuesInText`
   is set (the cluster's formatting changed the text), on a connection
   whose `_session.noBackslashEscapes(conn)` is true, rejects
   with `MDC_UNSAFE_SQL_MODE` and `sent: false` through `fail()`. The
   statement is not sent, and the connection goes back as it is. The
   borrow passed `valuesInText` to the prepare step, which sent `DO 0`
   when the mode was unknown, so the guard reads a known mode. See
   [cluster.md](./cluster.md#values-in-the-text-under-no_backslash_escapes).
4. The send step, the one step a bound statement does differently (the pool
   sets `timing.step` to `statement` right before it):
   `conn.query({ sql })` for text, `conn.execute({ sql, values })` with the
   option `execute`, both through `_session.send()`. mysql2 prepares a bound statement
   once per connection and keeps it until a reset, a `USE` of another
   database or the cap of `maxPreparedStatements` closes it. Before a bound
   send, `_session.executed(conn, sql)` notes the text. The pool's own timer
   bounds the statement with the query's `timeout`, the prepare of a bound
   one included, and mysql2 is handed no `timeout`: see the time limit of a
   command in [The session of a connection](#the-session-of-a-connection). On
   expiry the call fails with `PROTOCOL_SEQUENCE_TIMEOUT` and `sent: true`,
   and the connection is destroyed. A
   throw of mysql2 at the send, such as for values it refuses, fails the
   call with `sent: false`, so a direct call cannot hang. Both forms hand
   their reply to the same callback. `_session.observe()` applies the dirty rule to
   the reply. On
   success the connection goes back through `_borrow.giveBack()`: a clean
   one at once, a dirty one after a reset. On error it goes through
   `fail()`, which settles once and hands the connection back once:
   destroyed with its socket (`drop()` of
   [ServerFlags.ts](../../src/pool/ServerFlags.ts)) after a fatal error or
   `PROTOCOL_SEQUENCE_TIMEOUT` (the statement is still running on the
   server), reset first after a plain SQL error. Both go through
   `_borrow.giveBack()`.
5. On success: stops the `QueryTimer`, records the attempt as
   `mysql_dynamic_cluster.operation.duration`, logs a slow-query
   warning if `queryTimer.get() >= _slowQueryTime`,
   optionally writes the
   result to Redis (see below), and resolves with the mysql2 result.

### Passive health

Every failure of `query()` goes through `fail(error, conn?)`. With a
connection it calls `status.realFailure(error, false)` before it rejects:
the error came on a connection the pool had handed out. An error without a
connection came from the borrow, which told passive health itself: an error
of mysql2 that came in place of a connection with `realFailure(error,
true)`, a failed reset or `USE` with `realFailure(error, false)`, and every
failed probe, once, with `status.probeFailed(error)`, which counts as a
lost connection whatever the error. An abort is never told. `PoolStatus`
decides what the error says about the node, and does nothing for a node
without a `healthCheck` block. See
[health-and-scoring.md](health-and-scoring.md#passive-health).

The status query of a health check is never told. For a node with a
`healthCheck` block it does not run through `query()` at all: it is asked
on the [check connection](#the-check-connection). For a node without the
block it does run through `query()`, as before 4.0.0, and passive health does
nothing for such a node. It passes `{ probe: false }`, the `IPoolCall`
that is the last parameter of `query()`, which no other caller sets: the check draws a connection of the
app as it is, with no probe, no retry and no signal.

`multiStatementQuery()` tells every failure the same way, and a `ROLLBACK`
that failed as an error on a connection. `getConnection()` tells an error
of mysql2 as one that came in place of a connection, also when the signal
ended the call before the error came. The abort itself is not told.

### Redis cache write

If `queryOptions.redis` is truthy, the
successful result is serialised into an `IRedisData`:

- `data`: the raw query result.
- `expired`: `Date.now() + queryTime * 1000 * queryOptions.redisFactor`
  — a payload-level soft TTL the consumer can check independently of
  the Redis key TTL.

`Redis.set(sql, JSON.stringify(redisData), queryOptions.redisExpire)`
writes the entry with the key-level TTL set to `redisExpire`
seconds. The cache key is the raw SQL string. A bound statement never gets
here: the cluster turns `redis` off for `execute`.

### Error handling before 3.2.2

Before 3.2.2 no error branch returned after `reject(...)`, the query was
sent even when `changeUser` failed, and every error ended in
`release()` — so a timed-out connection went back to the pool while
still busy. See
[../known-issues.md#1-poolquery-does-not-return-after-reject](../known-issues.md#1-poolquery-does-not-return-after-reject)
and [#1a](../known-issues.md#1a-connections-released-back-to-the-pool-after-a-timeout-or-failed-changeuser).

## `multiStatementQuery()`

`multiStatementQuery()` in [src/pool/Pool.ts](../../src/pool/Pool.ts).

`async multiStatementQuery<T extends QueryResult>(sqls: string[],
queryOptions: IQueryOptions): Promise<T[]>`. Wraps a series of SQL
statements in a single mysql2 transaction. Used by `ClusterHashing` to
ship the SQL-asset bootstrap statements as one atomic unit (see
[../sql-assets.md](../sql-assets.md)).

### Option defaults

Same merge pattern as `query()`, but the Redis-related defaults are
omitted — this method does not cache:
`{ timeout: _queryTimeout, database: _database, ...queryOptions }`.

### Execution sequence

The steps of `multiStatementQuery()` in [src/pool/Pool.ts](../../src/pool/Pool.ts):

1. `_borrow.take({ target: { database, timeout } })` — the same borrow
   as `query()`, probe included, with no signal. Reject on its error.
2. The borrow did the same reset of a dirty connection and `USE` as for
   `query()`. Packets out of order are not watched during the
   transaction. Inside the transaction
   every header says a transaction is open, so only the rule for the
   database (`observeDatabase()`) reads the replies of the statements: a
   `USE` among them makes the next query send `USE` again. The reply of
   its own `COMMIT` or `ROLLBACK` goes through the whole rule and the
   connection back through `_borrow.giveBack()`: a clean one with no
   reset, one that the transaction left with autocommit off after a reset.
   A failed `ROLLBACK` destroys it. An error reply of `START TRANSACTION`,
   a statement or `COMMIT` goes through the whole rule too, in `fail()`,
   before anything else: the connection is dirty and is reset before it
   goes back, also after a `ROLLBACK` that passed, and a 1047 drops it at
   its release with no reset.
3. `START TRANSACTION` (bounded by `queryOptions.timeout`, as every command here) — open a transaction. On error,
   the connection goes back through `_borrow.giveBack()`, reset first, and
   the call rejects.
4. Run the statements one after another: each `conn.query` starts from
   the previous one's callback, and results are collected in order.
5. `COMMIT` (bounded by `queryOptions.timeout`) — issued only after the last
   statement succeeded. A timed-out `COMMIT` destroys the connection; whether
   it committed on the server is unknown.
6. Record the transaction as one `mysql_dynamic_cluster.operation.duration`
   sample, give the connection back with `_borrow.giveBack(conn)`, and
   `resolve(results)`.

Any error stops the sequence, records the attempt once with its
`error.type` and rejects.
A query or commit error sends `ROLLBACK` (bounded by `queryOptions.timeout`),
then gives the connection back, reset first since the error reply left it
dirty — or destroys it, if the rollback itself fails. After a fatal
error or `PROTOCOL_SEQUENCE_TIMEOUT` the connection is destroyed instead
(no rollback — closing the socket makes the server discard the
transaction). Before 3.2.2 the statements were fired from a `forEach`
and committed before any of them ran — see
[../known-issues.md#2-poolmultistatementquery-commits-before-queries-finish](../known-issues.md#2-poolmultistatementquery-commits-before-queries-finish).

## The session of a connection

[src/pool/SessionState.ts](../../src/pool/SessionState.ts). Since 4.0.0.
Before 4.0.0 every query and every transaction sent a change of user
(`COM_CHANGE_USER`) first, to switch the database. That was two commands
per query, a reset of the whole session each time, and on a Galera node
outside the primary component a change of user gets no answer, so the
query waited for its whole timeout instead of failing with 1047 at once.

`SessionState` keeps four things per connection, in a `WeakMap`: the
database the session is on, whether it is dirty, whether its server has
`NO_BACKSLASH_ESCAPES` (on, off or unknown), and the texts `execute` prepared on it. It is the
one place for the switch of database, the dirty rule, that bit, those
texts, the reset with its time limit and, since 4.0.0, the time limit of
every other command of the pool. `query()` and
`multiStatementQuery()` call it.

- **A connection seen for the first time** is on the `database` of the
  pool, the one mysql2 logged it in with, and clean.
- **`USE` only for another database.** The statement on the database the
  connection is on is one command. For another one, `USE` with the name
  escaped by mysql2's `escapeId` goes first, bounded by the timeout of the
  query as the statement is, see the time limit of a command below. A `USE` that fails or
  times out rejects with `sent: false`, and the next node may be tried. A
  timed-out one destroys the connection with its socket, as a timed-out
  statement does.
- **Dirty**, until the next reset: after an error reply on a connection
  that is still alive, since an error reply carries no status flags, or
  after an OK header with bit 1 (a transaction is open) set or bit 2
  (autocommit) clear. Every header of a reply of many results counts, such
  as the last one of a `CALL`. A reply of rows only has no header and
  changes nothing: it cannot open a transaction while autocommit is on. A
  header is told apart from a row by its class, `ResultSetHeader`, so a
  row with a column named `serverStatus` is not read as one. A header
  without `serverStatus`, from a server that sends no status flags,
  changes nothing.
- **Release.** A clean connection goes back to the pool with no command. A
  dirty one gets `connection.reset()` (`COM_RESET_CONNECTION`) first and
  goes back clean, so the next caller never gets a transaction or session
  variables the last one left. A reset that fails or does not answer
  within `resetTimeout` (1000 ms by default) destroys the connection with
  its socket (`drop()` of [ServerFlags.ts](../../src/pool/ServerFlags.ts)),
  logged at `warn`. mysql2 has no time limit for a reset, and a Galera
  node outside the primary component never answers one, also 8 s after
  it is Primary again (measured in #93). So a connection the node answered
  1047 on is destroyed at once, with no reset. The slot of the pool is
  free again either way. A broken connection, after a fatal error or a
  timeout, is destroyed with its socket too, never reset, and an aborted
  one too. mysql2's own `destroy()` only ends the socket, which on a cut
  path stays open until TCP gives up.
- **A reset keeps the database.** `COM_RESET_CONNECTION` does not change
  the current database of the session, so the state keeps it.
- **A `USE` of the app.** A statement can change the database itself: a
  `USE` the app sends through `query()`, or one in a multi-statement. An OK
  header with bit `0x4000` (session state changed) makes the database of
  the connection unknown, so the next query sends `USE` first. Only
  `serverStatus` is read. The bit comes from session tracking, which mysql2
  asks for and MySQL 8 has on by default. It costs one extra `USE` after
  each tracked change of the session, and on a server that tracks GTIDs
  (`session_track_gtids`) after every write. With
  `session_track_schema=OFF` the pool cannot see such a `USE`: an app must
  not send `USE` through `query()` there, and should use the `database`
  option instead.
- **The texts of `execute`.** Since 4.0.0 (#91). mysql2 keeps one
  prepared statement per text and connection, whatever the database, and
  the server runs it in the database it was prepared in. `executed()`
  notes each text, the one used last at the end, and the database they
  were prepared in. `prepare()` closes all of them
  (`connection.unprepare(sql)`, `COM_STMT_CLOSE`) before it sends a `USE`
  of another database, and forgets them. A `USE` back to that database
  keeps them: a header with `0x4000` makes the database unknown, and the
  `USE` the next statement sends returns to it, so a write on a server that
  tracks GTIDs does not cost a new prepare of everything. `lend()` closes
  them before the app gets the connection, since an `execute()` of the app
  with the same text would get the pool's statement. A reset forgets them
  too: mysql2 clears its own cache when the reset is answered. Past `maxPreparedStatements` texts the one
  used longest ago is closed at once, so mysql2 never keeps a statement
  the list lost. A connection that takes no command any more makes
  `unprepare` throw. That is caught, and the `USE` or statement that
  follows fails the call.
- **`noBackslashEscapes`.** Since 4.0.0 (#91). `observe()` sets it from
  bit 512 of the last header of a reply (`SERVER_STATUS_NO_BACKSLASH_ESCAPES`)
  and clears it when that header lacks the bit, each time: it is not
  sticky. The reply to the `USE` of `prepare()` counts too. A reply without
  a header, rows only or an error, leaves it: mysql2 does not pass on the
  status flags of the end of the rows. It has three states: on, off and
  unknown. A connection seen for the first time has it unknown, and a
  reset makes it unknown again: the session gets the `sql_mode` of the
  server back, and mysql2 does not show the header of the reply to a
  reset. `prepare()` takes `valuesInText`: when it is set and the mode is
  unknown, it sends `DO 0` after the reset and the `USE`, within the
  timeout of the query, and `observe()` reads its header. An error there
  marks the connection dirty and fails the call with `sent: false`.
  `query()` reads the bit through `noBackslashEscapes(connection)`, false
  while unknown, to refuse values written into the text. Inside a transaction of `multiStatementQuery()` only the
  `COMMIT` or `ROLLBACK` sets it, as for the dirty rule.
- **The time limit of a command.** Since 4.0.0 (#120). `send()` sends the
  statement of `query()` and `execute()`, the `USE` and the `DO 0` before
  it, and `START TRANSACTION`, the statements, `COMMIT` and `ROLLBACK` of
  `multiStatementQuery()`, each within the `timeout` of the call, by a
  timer of the pool. mysql2 is handed no `timeout`: it clears the timer of
  that option when the command ends, not when the connection is destroyed.
  So before 4.0.0 a command still out on a lost connection kept a
  timer that held the process open until it fired, after `queryTimeout`,
  120 s by default, and then called back a second time. The timer of the
  pool is unref'd, and is cleared at the reply, at `drop()` of the
  connection and at a throw of mysql2. On expiry the command fails with the
  error mysql2 gave a timeout (`Query inactivity timeout`, `code` and
  `errorno` `PROTOCOL_SEQUENCE_TIMEOUT`, `syscall: 'query'`), not marked
  as the package's own, and a reply after that is not passed on. A bound
  statement fails with the package's `Query inactivity timeout`, code
  `PROTOCOL_SEQUENCE_TIMEOUT`, marked as its own. Either way
  the connection counts as broken and is destroyed with its socket. A
  `timeout` of 0, or none, is no limit. The reset has its own time limit,
  `resetTimeout`, see above.
- **What a clean query leaves stays.** A statement whose reply is clean
  leaves its session state on the connection for the next query that gets
  it: user variables, session variables set with `SET`, named locks of
  `GET_LOCK()`, tables locked with `LOCK TABLES`, temporary tables and
  prepared statements. Before 4.0.0 the change of user released all of them.
  The statements `execute` prepares stay too, in the cache mysql2 keeps
  per connection, up to `maxPreparedStatements`, until a reset or a `USE`
  of another database closes them.
- **A connection the app had.** `Pool.getConnection()` lends it
  (`_borrow.lend()`) before the cluster hands it out. The pool sees
  neither the `USE` nor the transaction the app sends on it, so it marks
  the connection dirty and
  on no known database, after it closed the statements `execute` prepared
  on it. The `release()` of the app goes (#93)
  through the borrow, which resets the connection before it goes back, see
  [Borrow](#borrow-taking-and-giving-back-a-connection). A reset that fails
  or runs out of time destroys it. A query or a transaction of the cluster
  that gets it then sends `USE`, since the database is still unknown.
  `prepare()` still resets a connection that is dirty when it is drawn,
  bounded the same way and with `sent: false` when that fails, but the
  release of a lent connection leaves none such.
- **A cap on statements.** `resetAfterStatements` (1000 by default): every
  reply counts, through `observeDatabase()`, and the one that reaches the
  cap makes the connection dirty, so its release resets it and the count
  starts over. Prepared statements a procedure left on a connection cannot
  pile up when resets are rare. A reset for any reason starts the count
  over too.
- **The health check of a node without a `healthCheck` block** runs
  through `query()` on the database of the pool: no `USE`, and the same
  dirty rule and reset. The check connection of a node with the block is
  not part of this: it still sends a change of user before its status
  query, see [The check connection](#the-check-connection).

## Borrow: taking and giving back a connection

[src/pool/Borrow.ts](../../src/pool/Borrow.ts). Since 4.0.0 (#93, #94).
The one place a connection of the pool is taken and given back: `query()`,
its `execute` form, `multiStatementQuery()` and `getConnection()` all go
through it, and no other code takes or releases a pooled connection.

Taking, `take(options, outcome, timing)`. `options` is `ITakeOptions` of
Borrow.ts, `{ signal?, target?, probe? }`, internal and in no public type;
`probe` is `true` unless the caller says `false`. `timing` is the
`IAttemptTiming` of a query, for its `onTiming` option: `take()` sets
its `step` to `queue`, `probe` or `prepare` as it goes, and adds the
wait of each request to mysql2 to its `queuedMs`. See
[cluster.md](./cluster.md#the-ontiming-option):

1. **One request to mysql2** (`_request`), which waits in its queue while
   the pool is at its limit. An abort there takes the request out of the
   queue, see [A signal on getConnection](#a-signal-on-getconnection). An
   error of mysql2 is told to passive health as one that came in place of
   a connection.
2. **The probe** (`_probe`), when the connection was idle longer than
   `probeIdle` (1000 ms by default), or when a ping of the reaper is still
   out on it, idle or not. How long it was idle comes from the
   reaper: `drawn(connection)` gives what `onAcquire` saw when mysql2 drew
   the connection from its idle ones, the later of its release and the
   last ping of the reaper it answered. A new connection was never idle,
   and neither was one mysql2 handed straight from one caller to the next
   that waited, so neither gets a probe. The probe is `connection.ping()`,
   or, when the reaper's ping is still out on the connection, its answer:
   no second ping is sent. That wait is bounded too: mysql2 starts the
   timer of a query only after a ping queued before it, so a borrow that
   went on behind the reaper's ping on a dead path would wait with no
   limit. It has `probeTimeout` (1000 ms by default). A
   probe that fails, gets no answer in time or meets packets out of order
   drops the connection (`drop()` of
   [ServerFlags.ts](../../src/pool/ServerFlags.ts), with its socket), tells
   passive health once with `status.probeFailed()`, and the loop takes the
   next connection of the node: at most `connectionLimit + 1` tries, and a
   new connection ends it at the latest. Once `status.isValid` is false,
   health gave the node up, the next failed probe ends the loop at once
   and rejects with its error, `sent: false`, so the cluster tries the next
   node instead of probing every idle connection here. Within the loop
   that comes from passive health, which only a node with a `healthCheck`
   block has: the check it starts for the first failed probe decides, and
   with the block's default check `timeout` of 5 s that is after about 6
   to 7 probes. `_heard()` returns at once on a node of the legacy check,
   so there only the check of the timer can end the loop early. An abort during the probe drops
   the connection, tells nothing, and rejects with the reason. The health
   check of a node without a `healthCheck` block passes `probe: false`
   through `IPoolCall` of `Pool.query()`.
3. **For a statement** (`target` given), `_prepare` calls
   `SessionState.prepare()`: a reset when dirty, `USE` for another
   database, and `DO 0` when the target has `valuesInText` and the
   `sql_mode` of the connection is unknown. An error there is told to
   passive health and gives the
   connection back. An abort, or packets out of order, drop it. Without a
   target, for `getConnection()`, the connection is handed out as it is.

Giving back, `giveBack(connection, broken)`, goes through
`SessionState.release()`: a clean connection at once, a dirty one after a
bounded reset, one the node answered 1047 on is dropped, a broken one is
destroyed. The connection goes into the pool of mysql2 with the
`release()` of mysql2 (`_putBack`), also when a lend replaced the one on
the connection. Packets out of order are watched during that reset: the
watch ends when the reset ends, and a warning drops the connection at
once, not after `resetTimeout`.

`lend(connection)` marks the connection dirty with an unknown database in
`SessionState` and replaces its `release()` for the app: the first call
goes through `giveBack()`, so the reset comes before anybody else gets the
connection, and a second call does nothing until the next lend. The
`release()` of mysql2 is kept per connection in a `WeakMap` for
`_putBack`.

**Packets out of order** (#94). mysql2 emits `warn` with an `Error` that
has a numeric `expected` and `received` when a packet comes with an
unexpected sequence number, prints it, and goes on, often until the
timeout of the statement. `watch(connection, outOfOrder)` puts one
listener on the connection, during the probe, the reset and `USE`, the
statement of `query()` or `execute()`, the reset of `giveBack()`, and the
whole time a connection is lent. The listener drops the connection with the warning as the error of
its socket, so a command still out on it fails with that warning, and
`outOfOrder` gets an `Error` with code `MDC_PACKETS_OUT_OF_ORDER`,
`expected`, `received` and `nodeId`. `query()` fails the call with it at
once, `sent` as far as the call got. `mayTryNextNode` never tries another
node after it. During a probe it is a failed probe. On a lent connection
the app's command fails with the warning of mysql2. The listener goes
when the connection is given back or dropped, so a connection that
answered in order has none left. mysql2 also emits it for an
`ER_CLIENT_INTERACTION_TIMEOUT` (4031) the server sends with sequence
number 0 when it closes an idle connection, which is a failed probe when
it comes during one.

[src/utils/Abort.ts](../../src/utils/Abort.ts) holds the helpers Borrow,
`Pool` and `GaleraCluster` share. `whenAborted(signal, aborted)` is the one
shape of an abort listener: it calls `aborted` once, and the function it
returns takes the listener off. A signal that keeps its listeners and calls
them after that changes nothing. `abortReason(signal)` gives the reason of
an aborted signal, see [A signal on getConnection](#a-signal-on-getconnection).
`isBroken(error)` says whether an error leaves the connection unusable:
`fatal`, or `PROTOCOL_SEQUENCE_TIMEOUT`.

## The check connection

[src/pool/CheckConnection.ts](../../src/pool/CheckConnection.ts). Not in
earlier releases, and only for a node with a `healthCheck` block. A node
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
  the database of the node first, which `query()` no longer does since
  4.0.0, then the query, with no `timeout` of mysql2. It opens a connection when the node holds none
  and waits for the server to take the login before it sends anything, so
  a login the server refuses arrives as mysql2 made it, not `fatal`. It
  tells nothing to passive health. It rejects with the error of mysql2, or
  with `POOL_NOT_CONNECTED` outside `connect()` and `disconnect()`. Each
  call is one record of `mysql_dynamic_cluster.operation.duration`, as a
  check through `query()` is.
- **`holdsCheckConnection`** is `true` while the node holds a connection:
  open, or logging in. `PoolStatus` reads it before a check asks, since
  only a connection held from before can be one the path forgot.
- **`checkQuery(sql, keeps, asked)`** fills `asked.drop` before it sends
  anything: a function that destroys the connection this call went to,
  with its socket and whatever was asked on it. `PoolStatus` calls it when
  a check ran into its timeout, so no late answer comes on that
  connection. It is the connection of that call and no other: after a
  second `connect()` the node holds a new one, and a check that timed out
  on the old one leaves the new one alone. A call that was asked again on
  the connection of a second `connect()` gets the function for that one.
- **`dropCheckConnection()`** destroys the connection the node holds at
  that moment, with its socket. No code of the package calls it. The
  loopback suite does, to leave a node without a connection.
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
  and the next check opens a new one. It stays after that first event, so
  a second one on the same connection is taken as well and nothing is
  thrown. No path was found on which mysql2 3.24.6 sends a second one to a
  connection the listener dropped. That was read from its source and not
  run, so the test that holds the listener sends the second event itself.
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
- No check uses a connection of the pool. The timer of the idle
  connections pings them instead, see
  [The idle connections of the pool](#the-idle-connections-of-the-pool).
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

## The idle connections of the pool

[src/pool/IdleConnectionReaper.ts](../../src/pool/IdleConnectionReaper.ts).
The constructor of `Pool` builds one reaper per node. `connect()` starts
its timers and `disconnect()` stops them. The listeners of
`_connectEvents()` tell it of every `release` and `acquire`, so it knows
which connections are idle and since when.

It does two things, each on a timer of its own, every `idleCheckInterval`,
10 s by default. The timer of the age rule is started first, so at a tick
the two share the age rule runs first.

**The age rule, for every node.** A connection that has been idle for
longer than `idleTimeout` is destroyed with its socket (`drop()`), as
long as the pool has more than
`minConnections` free ones. With the defaults the pool keeps one idle
connection whatever its age.

**The ping, for a node with a `healthCheck` block.** Not in earlier
releases. Every idle connection the age rule kept gets one `COM_PING`. The
check of such a node asks on [the check connection](#the-check-connection),
so without the ping nothing would use the pooled connections of a quiet
app, and a balancer, a NAT or a firewall with an idle timeout would forget
them. What an app has to set is in
[health-and-scoring.md](health-and-scoring.md#a-quiet-app-behind-a-path-with-an-idle-timeout).

- **A node without the block gets no ping.** Its check draws a connection
  of the pool each time it runs, as before.
- **The connection stays in the pool while its ping is out.** It is taken
  out of no list of mysql2. So it counts as `idle` in `stats()`,
  `getPoolStats()` and the connection gauges, `availableConnectionCount`
  does not move, and a pool at its limit loses no connection to a ping.
- **A ping is no query of the app and no check.** It emits no
  `connection`, `acquire` or `release` and is no record of any metric.
  Neither the health check nor passive health is told of it.
- **A ping has the `timeout` of the block to be answered**, 5 s with the
  defaults. There is no setting of its own.
- **A ping that fails closes its connection**, with the socket, and so
  does a ping with no answer in time. mysql2 takes the connection out of
  the pool, so the app does not draw it. Every error counts: a reset, a
  connection the server closed, an error packet of the server.
- **Nothing is opened in its place.** The next request that finds no free
  connection opens one, as after the age rule. `minConnections` is a floor
  for the age rule and opens nothing.
- **One `debug` line per connection a ping took out**, with the meta
  `pool`, `idlePing: 'failed'` and `code`. The code is that of the error:
  `ECONNRESET` after a reset, `PROTOCOL_SEQUENCE_TIMEOUT` for a ping with
  no answer in time. A failed ping moves no node, sets no `checkError` and
  emits no `pool_check_failed`.
- **The app can draw a connection whose ping is out.** mysql2 runs the
  commands of a connection one after another, so what the app asks is sent
  after the answer to the ping. The reaper hears the `acquire` and lets go
  of that ping: its timer is cleared, and the reaper closes no connection
  the app holds. When the connection is lost, mysql2 fails the ping and
  what the app queued with the same error. That is the error the app would
  have met on that connection without a ping.
- **One ping at a time per connection.** A connection whose ping is still
  out at the next tick gets no second one. That happens when `timeout` is
  longer than `idleCheckInterval`.
- **A connection in use gets no ping.** Neither does the check connection.
- **`disconnect()` ends it.** No ping is sent after it. A ping that is out
  decides nothing any more and leaves no timer. Its connection is closed
  with the socket, without a logout: mysql2 queues the logout of
  `disconnect()` behind the ping, and a ping that never gets its answer
  would keep the connection open. Every other idle connection is logged
  out of as before. The next `connect()` starts the timers again.
- **A connection mysql2 dropped by itself** while it was idle, as after
  the server closed it, is still known to the reaper. Its next ping fails
  before a byte is sent, and the reaper forgets it with the same `debug`
  line, which has no `code` then.
- **A free list of mysql2 that cannot be read** stops the age rule, which
  needs its length. The ping needs no list of mysql2 and goes on.

### The pace of the ping

The settings take any number as `idleCheckInterval`. Node runs a timer
whose wait is below 1 ms, or above 2147483647 ms, every millisecond. For
the age rule that is a walk over a map, and it is left as it was. A ping
is a round trip to the server for every idle connection, so the timer of
the ping never waits less than 100 ms, and never more than a timer of Node
can.

| `idleCheckInterval` | Age rule, every node | Ping, a node with the block |
| --- | --- | --- |
| 0, a negative number, a fraction below 1 | every millisecond, as before | every 100 ms |
| 1 to 99 | as set | every 100 ms |
| 100 to 2147483647 | as set | as set |
| above 2147483647 | every millisecond, as before | every 2147483647 ms, about 24.8 days |

A node without the block has the one timer of the age rule, started with
the value as it is, as before. Nothing is logged for a value the ping
does not follow.

Measured with the real mysql2 on the loopback interface of one Linux host,
by a probe that is not part of the suite, 3 runs of 1 s per value: one
node with the block and one idle pooled connection. With the ping on the
timer of the age rule, the node got 738 to 805 pings in that second for 0,
-5, 0.4 and 2147483648. With a timer of its own it gets 10 for the first
three and none for the last. A node without the block got no ping either
way.

`_idlePing()` builds the ping for the reaper. It is at the end of the
class, so the line references above did not move.

Pinned by
[tests/pool/idle-ping.test.ts](../../tests/pool/idle-ping.test.ts) against
a mysql2 the test drives, and with the real mysql2 behind a TCP proxy on
loopback by
[tests/cluster/idle-ping-loopback.test.ts](../../tests/cluster/idle-ping-loopback.test.ts).
The age rule is in
[tests/pool/reaper.test.ts](../../tests/pool/reaper.test.ts).

## Node API helpers

Added in 4.0.0, at the end of the class, so the line references above did
not move. `GaleraCluster` calls them for the node API of
[../node-api.md](../node-api.md). `_pool` stays private.

- `getConnection(signal?, outcome?)` takes one connection through
  `_borrow.take({ signal }, outcome)`: probed when it was idle longer than
  `probeIdle`, or one the reaper's ping is still out on, since 4.0.0. Then
  it lends it, `_borrow.lend()`: the app's `release()` resets the
  connection, and a second one does nothing. The lend is inside, so no
  caller can forget it. It does not change the database, sets no timeout
  and records no metric. It rejects with the error object of
  mysql2, with the error of the last probe when every try failed, or with
  `POOL_NOT_CONNECTED` before `connect()` created the mysql2
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

Added in 4.0.0, after them, for `checkError` and `firstReady` of the node
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
[../node-api.md](../node-api.md#give-up-the-wait-with-a-signal). Since
4.0.0 it is `_request` of [Borrow](#borrow-taking-and-giving-back-a-connection),
and `query()` waits for its connection the same way. An abort during the
probe that follows drops the connection, see there. The wait works like
this:

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
  `abortReason(signal)`. When the callback comes later with a
  connection, `_releaseLate` gives it back. When it comes with an error, the
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

`_releaseLate(connection)` calls `giveBack(connection)` in a `try`: a clean
connection goes back with no command, as nobody used it. It runs
in the callback of mysql2, where a throw would be an uncaught exception,
and `release()` runs the `release` listeners of the app. mysql2 pushes the
connection onto its free list before it emits `release`, and the listener
of the pool tells the idle reaper before it emits the event of the cluster.
So after a listener of the app threw, the connection is idle in the pool
and the reaper knows it. The throw is logged at `warn` with `nodeId`, `pool`
and `error`.

`abortReason(signal)` of [src/utils/Abort.ts](../../src/utils/Abort.ts)
returns `signal.reason`, or, when
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
the `PROTOCOL_SEQUENCE_TIMEOUT` error of the time limit of a reset in
`SessionState`.
`failWaiting(error)` marks the error of the app the same way. The mark
changes nothing on the error object, and `query()`, `getConnection()` and
the waiting requests reject with it as before.

## Public API summary

| Member | Kind | Source |
| --- | --- | --- |
| `id` | `readonly number` | [`id`](../../src/pool/Pool.ts) |
| `name` | `readonly string` | [`name`](../../src/pool/Pool.ts) |
| `host` | `readonly string` | [`host`](../../src/pool/Pool.ts) |
| `port` | `readonly number` | [`port`](../../src/pool/Pool.ts) |
| `connectionLimit` | `readonly number` | [`connectionLimit`](../../src/pool/Pool.ts) |
| `status` | getter returning `PoolStatus` | [`status`](../../src/pool/Pool.ts) |
| `connect(outcome?)` | `async (outcome?: ICheckOutcome) => Promise<void>` | [`connect`](../../src/pool/Pool.ts) |
| `disconnect()` | `() => void` | [`disconnect`](../../src/pool/Pool.ts) |
| `query<T>(sql, options?, outcome?, call?)` | `async => Promise<T \| T[]>`, `call` an internal `IPoolCall` `{ values?, valuesInText?, probe? }` | [`query`](../../src/pool/Pool.ts) |
| `multiStatementQuery<T>(sqls, options)` | `async => Promise<T[]>` | [`multiStatementQuery`](../../src/pool/Pool.ts) |
| `getConnection(signal?, outcome?)` | `(signal?: AbortSignal, outcome?: IAbortOutcome) => Promise<PoolConnection>` | [`getConnection`](../../src/pool/Pool.ts) |
| `failWaiting(error)` | `(error: Error) => number` | [`failWaiting`](../../src/pool/Pool.ts) |
| `stats()` | `() => { used, idle, pending }` | [`stats`](../../src/pool/Pool.ts) |
| `checkError` | getter returning `INodeCheckError \| undefined` | [`checkError`](../../src/pool/Pool.ts) |
| `holdsCheckConnection` | getter returning `boolean` | [`holdsCheckConnection`](../../src/pool/Pool.ts) |
| `checkQuery<T>(sql, keeps?, asked?)` | `(sql: string, keeps?: (error: any) => boolean, asked?: { drop?: () => void }) => Promise<T>` | [`checkQuery`](../../src/pool/Pool.ts) |
| `dropCheckConnection()` | `() => void` | [`dropCheckConnection`](../../src/pool/Pool.ts) |

Consumers normally talk to `GaleraCluster`, not to `Pool` directly;
the cluster picks a healthy pool via its routing logic and then
delegates to `Pool.query`. Direct construction of a `Pool` is
supported but undocumented in the README — its primary use case is the
test suite (see [../testing.md](../testing.md)).
