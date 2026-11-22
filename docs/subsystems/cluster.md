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
The references below name the function to look in. Line numbers are given
only for the declarations above the constructor.

## Construction

The constructor takes no arguments. Every configuration value is read
off the `config` singleton via `config.current`; `createPoolCluster` has
already validated the user settings and loaded them into it before
`new GaleraCluster()` is called.

Fields populated from `config.current`, at the top of the constructor:

- `_useClusterHashing` ← `useClusterHashing`.
- `_clusterName` ← `clusterName`.
- `_errorRetryCount` ← `errorRetryCount`.
- `_useRedis` ← `redis.enabled`.
- `_nullServiceName` is a constant `"mdc"` initialized on the field
  ([src/cluster/GaleraCluster.ts:48](../../src/cluster/GaleraCluster.ts#L48));
  the fallback service name becomes `${clusterName}_mdc`.

Pool construction, in the constructor:

1. `_sortPoolIds(config.current.hosts)` collects every manually-set
   numeric `id` from the host list and returns them sorted ascending
   (`_sortPoolIds`).
2. The constructor iterates `config.current.hosts`; for any host with no
   `id`, the next id is `0` when the sorted list is empty, otherwise
   `last + 1`, and the new id is pushed back into the list so subsequent
   gaps still increment from the highest assigned id.
3. Only hosts with a truthy `host` value get a `Pool`; otherwise an
   error is logged. Pools are constructed with `(poolSettings,
   clusterName)`.

After the pool array is built, the constructor instantiates
`ServiceNames(this, config.current.serviceMetrics)` and
`ClusterHashing(this, clusterName, config.current.clusterHashing)`,
the last step of the constructor.
Note: `ClusterHashing` is constructed unconditionally — the
`_useClusterHashing` flag only gates `connect()` calling `_enableHashing`.

## `connect()`

`connect` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).

`connect` first hands its pools to `Metrics.registerPools`, which reports
their connection counts from then on, see
[metrics.md](./metrics.md#pool-connection-metrics).

`connect` returns a `Promise<void>` that wraps a `forEach` loop firing
`pool.connect()` on every pool in parallel. The **first** pool to resolve
wins the race:

- Sets `this.connected = true`.
- If `_useClusterHashing` is true, awaits `_enableHashing()`.
- Emits `'connected'` via the shared `Events` bus and resolves the outer
  promise.

Subsequent resolutions short-circuit on the `if (this.connected) return`
guard
at the top of the `then` callback.

Failure semantics: any `pool.connect()` rejection calls `reject(err.message)`
in the `catch` callback.
Because `forEach` does not await between iterations, **other pools may
still be in flight or failing** after the outer promise has resolved or
rejected. The first rejection that lands before the first success will
reject the outer promise even though slower pools could still come up.
This is tracked behaviour — see [../known-issues.md](../known-issues.md).

`_enableHashing`
awaits `_clusterHashing.connect()`, emits `'hashing_created'`, and logs;
errors are caught and logged but do not propagate to `connect`.

Since 4.5.0 every `connect()` call also settles the `ready` promise. It
resolves once every `pool.connect()` of that call ended, with one result per
pool, and it never rejects. `connect()` itself resolves and rejects as
described above. See [../node-api.md](../node-api.md#ready).

Since 4.6.0 every `connect()` call also settles the `firstReady` promise. It
resolves when the first `pool.connect()` of that call passed, with the
results that are in by then, or together with `ready` when none passed. It
does not wait for `_enableHashing()`. `connect()` hands every
`pool.connect()` an empty object, and the pool fills it with how the health
check of that connect ended (`ICheckOutcome` in
[src/types/PoolInterfaces.ts](../../src/types/PoolInterfaces.ts)).
`_readyResult` builds the result when the `pool.connect()` settles and reads
that object then. A check that was recorded puts its own error on the result,
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

1. `this.connected = false`.
2. `Metrics.unregisterPools` ends the pool connection metrics of its pools.
3. `this._clusterHashing?.stop()` halts the hashing refresh timer.
4. `Redis.disconnect()` closes the shared Redis client.
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
  call are checked right after it.

### 2. Metrics

Starts a `QueryTimer` before any work. Every way out of `query` records
one `mysql_dynamic_cluster.query.duration` sample through the local
`record` helper ([src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts)).
See [metrics.md](./metrics.md).

### 3. Service-id resolution

The first lines of the `try` block.

- If the caller passed `serviceName` but no `serviceId`, look it up via
  `ServiceNames.getID(serviceName)` and write it back onto
  `queryOptions.serviceId`. Since 5.0.0 the lookup is a `cluster.execute()`,
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
   Since 4.5.0 steps 2 and 3 are the helper `_validPools(exclude)`, called
   here with the pinned pool id. `getConnection()` picks its node through the
   same helper, with the caller's `exclude` and without steps 1 and 4.
4. If the pinned pool exists in `_pools`, find it and `unshift` it to
   the front so the pinned pool is tried first, also when it is not valid.
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
back to `_errorRetryCount`. Since 5.0.0 the count is at least 1, so a
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

`sql = this._formatSQL(sql, values)`, right after the `try`/`catch` and
the check of the signal that follows it. Not for `execute`: its values stay
apart from the text. The `formatSQL` debug line is logged for text queries
only. `valuesInText` is `sql !== originalSql`: whether the formatting
wrote a value into the text.
`_formatSQL`:

- Array `values` → `mysql2`'s `format(sql, values)` (positional `?`).
- String `values` → same `format()` call.
- Object `values` → regex `:paramName` substitution: `sql.replace(/:(\w+)/g, ...)`
  swaps in the value when the object has the key as its own property,
  otherwise leaves the placeholder verbatim. The value goes through
  `mysql2.escape(value, true)`, so a plain object becomes the string
  `'[object Object]'`, not SQL. Since 5.0.0 always: the setting and the
  query option `escapeNamedValues` of 4.x, which left the value as text by
  default, are gone, and so is their warning. A `mysql2.raw()` value, or
  any object with a `toSqlString` function, is still written as SQL.

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

For `i` from `0` to `retryCount - 1`, calls
`this._queryRequest(sql, activePools[i], queryOptions, outcome, values, valuesInText)`, with a
new empty `outcome` for each node. First success records the query with
source `pool` and returns. Each failure is kept as `{ nodeId, error }` in
`errors`. The loop goes on to the next pool only when the statement cannot
have run on the one that failed, so one call never writes twice.

`mayTryNextNode(error, outcome, queryOptions)` in
[src/cluster/QueryRetry.ts](../../src/cluster/QueryRetry.ts) decides it,
and nothing else does. `Pool.query` fills `outcome.sent`: `false` from the
start of the call, `true` once it hands the statement to the connection. It
stays `false` when the borrow of the connection failed: there is no mysql2
pool, mysql2 gave no connection, every connection failed its probe, or the
session could not be got ready, as a reset of a dirty connection or a
`USE` of another database that failed or timed out. See
[pool.md](pool.md#borrow-taking-and-giving-back-a-connection). Since 5.0.0
the pool sends no change of user. A pooled connection the path forgot
that was idle longer than `probeIdle` fails its probe, which costs the
call nothing: the pool takes the next connection of the node (#93). One
used more recently fails under the statement itself, with `sent: true`,
and the next node is not tried.
The pool also writes `sent` on the error when the error can take it, but
the loop reads the outcome: a frozen error, or one the app handed
`failWaiting()` that many queries share, is decided the same way.

| The node failed with | Next node |
| --- | --- |
| errno 1045, 1698, 1044, 3118, 3955 or 1130, a refused login | no, although `sent` is `false` |
| `MDC_UNSAFE_SQL_MODE`, values in the text under `NO_BACKSLASH_ESCAPES` | no, although `sent` is `false` |
| `MDC_PACKETS_OUT_OF_ORDER`, a reply whose packets came with a wrong sequence number (#94) | no: a defect of the client or the server, which another node would meet again |
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
brings back the retry of 4.x, which tried the next node after any error.
Since 5.0.0.

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

Since 5.0.0. Before, `query()` rejected with a new `Error` whose message
joined `Pool: <name>; Error: Query error: <message>` lines and which had
no code. See the changelog.

A frozen error, or a rejection that is no object, cannot take `nodeId`
or `errors` and is thrown without them. An error that already has an
`errors` array of its own keeps it and gets no list: Node's
`AggregateError`, when every address of a host name refused, holds the
error of each address there. An error that the app handed `failWaiting()`
is one object that many queries can meet. An entry that would lead back
to it, itself or through the list an earlier query set, is left out, so
the errors never form a cycle and `JSON.stringify` works on them. Each
attempt is still logged with `Logger.error`. The single
`All pools have error` line that listed them all is gone.

### 10. `_queryRequest`

`_queryRequest` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Wraps a single `pool.query(sql, queryOptions, outcome, { values, valuesInText })` call. The
pool records the attempt as `mysql_dynamic_cluster.operation.duration`. On success:

- If `queryOptions.serviceId` is truthy and `_clusterHashing.connected`,
  awaits `_clusterHashing.updateNodeForService(serviceId, pool.id)` to
  pin the service to the pool that just served it.

On failure the error goes to the retry loop in `query` as it is, and the
outcome says whether the statement was sent. `updateNodeForService`
catches its own errors. Anything it still throws is logged as a warning
and the result is returned: the statement ran, so it must not go to the
next node.

### The `signal` option

Since 5.0.0 (#89). `signal` is an `AbortSignal` that ends the call when it
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

### `execute()` and bound values

Since 5.0.0 (#91). `execute<T>(sql, values?, queryOptions?)` is
`query(sql, values, { ...queryOptions, execute: true })`, and the option
works the same on `query()` itself. Nothing is switched to it for a caller:
`query()` without the option writes its values into the text, as before.

The two forms take the same path: the choice of node, the retry rule of
step 8, the error of step 9, the signal, the metrics and passive health.
The one difference is in `Pool.query`, which hands the statement to
mysql2's `conn.execute({ sql, values, timeout })` in place of
`conn.query({ sql, timeout })`. The values go in the execute packet as
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

Since 5.0.0 (#91). Escaping a value into the text puts a backslash before
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
| `connected: boolean` | [:27](../../src/cluster/GaleraCluster.ts#L27) | Flipped to `true` by the first successful pool connect; reset to `false` by `disconnect()`. |
| `pools: Pool[]` (getter) | [:34](../../src/cluster/GaleraCluster.ts#L34) | Tagged `@internal` at [:32](../../src/cluster/GaleraCluster.ts#L32). Used by `ClusterHashing`, `ServiceNames`, and the test harness; not meant for consumers. Apps use the node API below instead. |
| `connect(): Promise<void>` | [`connect`](../../src/cluster/GaleraCluster.ts) | Resolves on the first pool that comes up; rejects on the first failure before any success. |
| `disconnect(): Promise<void>` | [`disconnect`](../../src/cluster/GaleraCluster.ts) | Synchronous in practice — does not await pool disconnects. |
| `on(event, callback)` | [`on`](../../src/cluster/GaleraCluster.ts) | Pass-through to the shared `Events` emitter. |
| `query<T>(sql, values?, queryOptions?)` | [`query`](../../src/cluster/GaleraCluster.ts) | The full routing pipeline described above. |
| `execute<T>(sql, values?, queryOptions?)` | [`execute`](../../src/cluster/GaleraCluster.ts) | Since 5.0.0. `query()` with the option `execute`: values bound by the server. No Redis. |
| `ready: Promise<INodeReadyResult[]>` (getter) | [`ready`](../../src/cluster/GaleraCluster.ts) | Since 4.5.0. Resolves once every pool finished the first connect of the current `connect()` call. Never rejects. Since 4.6.0 a result has `checkError` when the health check of that connect did not get its answer. |
| `firstReady: Promise<INodeReadyResult[]>` (getter) | [`firstReady`](../../src/cluster/GaleraCluster.ts) | Since 4.6.0. Resolves when the first pool passed the first connect of the current `connect()` call, with the results that are in by then. With every result when none passed. Never rejects. |
| `getConnection(options?)` | [`getConnection`](../../src/cluster/GaleraCluster.ts) | Since 4.5.0. One connection of the valid node with the lowest load score. The `signal` option, which came after 4.6.0, ends the wait: the call rejects with the reason of the signal. Since 5.0.0 the connection is probed on the way out when it was idle, and its `release()` resets it before it goes back (#93). |
| `failWaiting(nodeId, error): number` | [`failWaiting`](../../src/cluster/GaleraCluster.ts) | Since 4.5.0. Fails the requests that wait for a connection of one node. |
| `getPoolStats(): INodePoolStats[]` | [`getPoolStats`](../../src/cluster/GaleraCluster.ts) | Since 4.5.0. Used, idle and waiting connections per node. |
| `nodes(): INodeInfo[]` | [`nodes`](../../src/cluster/GaleraCluster.ts) | Since 4.5.0. A snapshot of the nodes as plain objects. Since 4.6.0 a node has `checkError` when its last health check did not get its answer. |

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
