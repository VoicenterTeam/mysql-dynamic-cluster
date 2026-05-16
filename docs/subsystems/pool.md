# Subsystem: `Pool`

`Pool` is a thin wrapper around `mysql2.createPool` paired with a
`PoolStatus` health checker. One `Pool` instance represents one Galera
node: it owns the underlying `mysql2.Pool`, forwards mysql2's
connection-lifecycle events onto the shared `Events` bus, runs queries
(optionally caching their results in Redis), and exposes a transactional
multi-statement helper. The `PoolStatus` companion polls `SHOW GLOBAL
STATUS` on a timer to decide whether the node is still routable; see
[poolStatus.md](poolStatus.md) for that subsystem (and
[../architecture.md](../architecture.md) for where `Pool` sits in the
boot flow).

Source: [src/pool/Pool.ts](../../src/pool/Pool.ts).

## Construction

[src/pool/Pool.ts:46-66](../../src/pool/Pool.ts#L46).

The constructor takes `(settings: IUserPoolSettings, clusterName:
string)`. The `clusterName` argument is currently unused inside `Pool`
itself; `GaleraCluster` still passes it through for symmetry with other
subsystems. Fields populated from `settings`:

- `id` ← `settings.id`
  ([src/pool/Pool.ts:47](../../src/pool/Pool.ts#L47)).
- `host` ← `settings.host`
  ([src/pool/Pool.ts:48](../../src/pool/Pool.ts#L48)).
- `port` ← `settings.port`
  ([src/pool/Pool.ts:49](../../src/pool/Pool.ts#L49)).
- `name` ← `settings.name`, falling back to `` `${host}:${port}` `` when
  not provided
  ([src/pool/Pool.ts:50](../../src/pool/Pool.ts#L50)).
- `_user`, `_password`, `_database` ← the matching settings fields
  ([src/pool/Pool.ts:53-55](../../src/pool/Pool.ts#L53)).
- `_queryTimeout`, `_slowQueryTime`, `_redisFactor`, `_redisExpire` ←
  the matching settings fields
  ([src/pool/Pool.ts:56-59](../../src/pool/Pool.ts#L56)).
- `connectionLimit` ← `settings.connectionLimit`
  ([src/pool/Pool.ts:61](../../src/pool/Pool.ts#L61)).

After the fields are wired the constructor builds the companion
`PoolStatus` with `active = false` and an initial
`availableConnectionCount` equal to `connectionLimit`
([src/pool/Pool.ts:63](../../src/pool/Pool.ts#L63)). The mysql2 pool
itself is **not** created here; that happens lazily in `connect()`.

## `connect()`

[src/pool/Pool.ts:71-92](../../src/pool/Pool.ts#L71).

`connect()` is `async` and is the first method `GaleraCluster.connect`
calls on each pool. The steps:

1. Build the underlying mysql2 pool via `mysql.createPool({ host, port,
   user, password, database, connectionLimit })`
   ([src/pool/Pool.ts:73-80](../../src/pool/Pool.ts#L73)).
2. Mark the status as active (`this.status.active = true`)
   ([src/pool/Pool.ts:82](../../src/pool/Pool.ts#L82)). Setting
   `active` to `true` is the trigger for `PoolStatus` to start its
   recurring `SHOW GLOBAL STATUS` poller — see
   [poolStatus.md](poolStatus.md) for the timer semantics.
3. Wire mysql2's per-connection events through `_connectEvents`
   ([src/pool/Pool.ts:83](../../src/pool/Pool.ts#L83)).
4. Run one synchronous (well, `await`ed) `status.checkStatus()` to
   validate the node before declaring success
   ([src/pool/Pool.ts:84](../../src/pool/Pool.ts#L84)).
5. If `status.isValid`, emit `'pool_connected'` with the pool id
   ([src/pool/Pool.ts:86-88](../../src/pool/Pool.ts#L86)); otherwise
   throw `Error("pool in host " + host + " is not valid")` so the
   cluster can log the failure and continue with the remaining pools
   ([src/pool/Pool.ts:89-91](../../src/pool/Pool.ts#L89)).

The `'pool_connected'` event is documented in
[../events.md](../events.md).

## `_connectEvents()`

[src/pool/Pool.ts:98-115](../../src/pool/Pool.ts#L98).

Private helper. Subscribes to the underlying `mysql2.Pool`'s three
connection-lifecycle events and re-emits each one onto the shared
`Events` bus, additionally maintaining `availableConnectionCount`:

- `connection` — decrement `availableConnectionCount`, log, emit
  `Events.emit('connection', connection, this.id)`
  ([src/pool/Pool.ts:99-103](../../src/pool/Pool.ts#L99)).
- `release` — increment `availableConnectionCount`, log, emit
  `Events.emit('release', connection, this.id)`
  ([src/pool/Pool.ts:105-109](../../src/pool/Pool.ts#L105)).
- `acquire` — log and emit `Events.emit('acquire', connection,
  this.id)` (no counter change — `acquire` and `release` come in pairs
  bracketing a query, only `release` needs to bump the counter)
  ([src/pool/Pool.ts:111-114](../../src/pool/Pool.ts#L111)).

See [../events.md](../events.md) for the payload shapes consumers
actually receive (note the `Events.emit` args-wrap quirk documented
there).

## `disconnect()`

[src/pool/Pool.ts:120-132](../../src/pool/Pool.ts#L120).

Synchronous. Steps:

1. Call `this._pool.end(callback)`; the callback only logs an error if
   one is reported
   ([src/pool/Pool.ts:122-126](../../src/pool/Pool.ts#L122)).
2. Set `status.active = false` and call `status.stopTimerCheck()` to
   shut down the `PoolStatus` polling timer
   ([src/pool/Pool.ts:127-128](../../src/pool/Pool.ts#L127)).
3. Emit `'pool_disconnected'` with the pool id
   ([src/pool/Pool.ts:129](../../src/pool/Pool.ts#L129)).

`pool.end` is callback-style and not awaited; the method returns before
the mysql2 pool has actually flushed in-flight connections. Callers
that need a hard guarantee of shutdown should subscribe to
`'pool_disconnected'` or, better, drive shutdown through
`GaleraCluster.disconnect()` which sequences pools and the hashing
helper.

## `query()`

[src/pool/Pool.ts:139-228](../../src/pool/Pool.ts#L139).

`async query<T extends QueryResult>(sql: string, queryOptions?:
IQueryOptions): Promise<T | T[]>`. The body wraps a callback-style
mysql2 chain in `new Promise(...)`. The method is the single execution
point used by `GaleraCluster.query` once a node has been picked.

### Option defaults

The provided `queryOptions` (or `{}`) is merged on top of the pool's
own defaults:
`{ timeout: _queryTimeout, database: _database, redisFactor:
_redisFactor, redisExpire: _redisExpire, ...queryOptions }`
([src/pool/Pool.ts:141-147](../../src/pool/Pool.ts#L141)). Caller
overrides win.

### Metric tagging

A `poolMetricOption` is built with `{ pool: { id, name } }`
([src/pool/Pool.ts:148-153](../../src/pool/Pool.ts#L148)). If the
caller passes a `serviceId`, a `service` block is added too —
`serviceName` defaults to `String(serviceId)` when not provided
([src/pool/Pool.ts:154-159](../../src/pool/Pool.ts#L154)). The merged
options are passed to every `Metrics.inc` / `Metrics.mark` / `QueryTimer`
call so dashboards can break down queries by pool and (optionally) by
service.

### Execution sequence

The `Promise` callback chain is, in order
([src/pool/Pool.ts:167-226](../../src/pool/Pool.ts#L167)):

1. `_pool.getConnection((err, conn) => { ... })` — checks out a raw
   `mysql2.PoolConnection`. On error, increments the
   `errorQueries` metric and rejects; if `conn` is falsy a
   second guard rejects with `"Can't find connection. Maybe it was
   unexpectedly closed."`.
2. `conn.changeUser({ database: queryOptions.database }, ...)` — swaps
   the database on the borrowed connection so the same `Pool` can serve
   queries against multiple databases.
3. `conn.query({ sql, timeout: queryOptions.timeout }, ...)` — runs the
   SQL. Always calls `conn.release()` after the callback fires, whether
   it succeeded or not.
4. On success: stops the `QueryTimer`, saves metrics, logs a slow-query
   warning if `queryTimer.get() >= _slowQueryTime`
   ([src/pool/Pool.ts:209-211](../../src/pool/Pool.ts#L209)),
   increments the `successfulQueries` metric, optionally writes the
   result to Redis (see below), and resolves with the mysql2 result.

### Redis cache write

If `queryOptions.redis` is truthy
([src/pool/Pool.ts:215-222](../../src/pool/Pool.ts#L215)), the
successful result is serialised into an `IRedisData`:

- `data`: the raw query result.
- `expired`: `Date.now() + queryTime * 1000 * queryOptions.redisFactor`
  — a payload-level soft TTL the consumer can check independently of
  the Redis key TTL.

`Redis.set(sql, JSON.stringify(redisData), queryOptions.redisExpire)`
writes the entry with the key-level TTL set to `redisExpire`
seconds. The cache key is the raw SQL string.

### Known bug

Every error branch (`getConnection`, the `!conn` guard, `changeUser`,
the inner `query`) calls `reject(...)` without a following `return`, so
execution continues into the next callback chain even after a
rejection. The Promise itself stays rejected (it can only resolve
once), but the misleading side effects — `conn?.release()` on a missing
connection, follow-up metric writes, and continuing into `conn.query`
after `changeUser` errored — are real. See
[../known-issues.md#1-poolquery-does-not-return-after-reject](../known-issues.md#1-poolquery-does-not-return-after-reject).

## `multiStatementQuery()`

[src/pool/Pool.ts:235-310](../../src/pool/Pool.ts#L235).

`async multiStatementQuery<T extends QueryResult>(sqls: string[],
queryOptions: IQueryOptions): Promise<T[]>`. Wraps a series of SQL
statements in a single mysql2 transaction. Used by `ClusterHashing` to
ship the SQL-asset bootstrap statements as one atomic unit (see
[../sql-assets.md](../sql-assets.md)).

### Option defaults

Same merge pattern as `query()`, but the Redis-related defaults are
omitted — this method does not cache:
`{ timeout: _queryTimeout, database: _database, ...queryOptions }`
([src/pool/Pool.ts:237-241](../../src/pool/Pool.ts#L237)).

### Execution sequence

[src/pool/Pool.ts:253-308](../../src/pool/Pool.ts#L253):

1. `_pool.getConnection(...)` — same guards as `query()`. Reject on
   error or missing `conn`.
2. `conn.changeUser({ database }, ...)` — same database swap.
3. `conn.beginTransaction(...)` — open a transaction. On error,
   `conn.release()` and reject.
4. `sqls.forEach(sql => conn.query({ sql, timeout }, ...))` — fire every
   query callback-style. Each callback rolls back, releases, and
   rejects on its own error.
5. `conn.commit(...)` — commit. On error, `conn.rollback(() => 0)`,
   release, and reject.
6. Increment `successfulQueries`, `conn.release()`, and
   `resolve(results)`.

### Known bug

Steps 4-6 in the list above run synchronously: `forEach` only schedules
the per-query callbacks, then `commit` is invoked, `release` runs, and
`resolve(results)` returns — all before any of the actual query
callbacks have fired. The transaction commits with zero queries
executed against it, `results` is empty, and the connection is released
back to the pool while queries are still in flight. The pattern cannot
be fixed by adding `return` after each `reject` — it needs a full
rewrite around `mysql2/promise` (or `util.promisify` on the callback
API) to sequence the awaits properly. See
[../known-issues.md#2-poolmultistatementquery-commits-before-queries-finish](../known-issues.md#2-poolmultistatementquery-commits-before-queries-finish).

## Public API summary

| Member | Kind | Source |
| --- | --- | --- |
| `id` | `readonly number` | [:25](../../src/pool/Pool.ts#L25) |
| `name` | `readonly string` | [:26](../../src/pool/Pool.ts#L26) |
| `host` | `readonly string` | [:27](../../src/pool/Pool.ts#L27) |
| `port` | `readonly number` | [:28](../../src/pool/Pool.ts#L28) |
| `connectionLimit` | `readonly number` | [:30](../../src/pool/Pool.ts#L30) |
| `status` | getter returning `PoolStatus` | [:21-23](../../src/pool/Pool.ts#L21) |
| `connect()` | `async () => Promise<void>` | [:71](../../src/pool/Pool.ts#L71) |
| `disconnect()` | `() => void` | [:120](../../src/pool/Pool.ts#L120) |
| `query<T>(sql, options?)` | `async => Promise<T \| T[]>` | [:139](../../src/pool/Pool.ts#L139) |
| `multiStatementQuery<T>(sqls, options)` | `async => Promise<T[]>` | [:235](../../src/pool/Pool.ts#L235) |

Consumers normally talk to `GaleraCluster`, not to `Pool` directly;
the cluster picks a healthy pool via its routing logic and then
delegates to `Pool.query`. Direct construction of a `Pool` is
supported but undocumented in the README — its primary use case is the
test suite (see [../testing.md](../testing.md)).
