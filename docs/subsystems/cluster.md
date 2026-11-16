# Subsystem: `GaleraCluster`

`GaleraCluster` is the orchestrator. It owns the `Pool` instances, the
`ClusterHashing` module, the `ServiceNames` cache, and the query routing
logic. Every consumer call (`connect`, `disconnect`, `on`, `query`) flows
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
- `_escapeNamedValues` ← `escapeNamedValues`.
- `_nullServiceName` is a constant `"mdc"` initialized on the field
  ([src/cluster/GaleraCluster.ts:44](../../src/cluster/GaleraCluster.ts#L44));
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

## `disconnect()`

`disconnect` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).

Tears the cluster down in this order:

1. `this.connected = false`.
2. `this._clusterHashing?.stop()` halts the hashing refresh timer.
3. `Redis.disconnect()` closes the shared Redis client.
4. `pool.disconnect()` on every pool (synchronously kicked off via
   `forEach`).
5. Emits `'disconnected'`.

The method is `async` but does not await pool disconnects.

## `on(event, callback)`

`on` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Thin pass-through to `Events.on`. The full event list is in
[../events.md](../events.md).

## `query()`

`query` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Steps 1 to 9 are all in that one method, in this order.

Signature:
`query<T>(sql: string, values?: QueryValues, queryOptions?: IQueryOptions): Promise<T>`.

### 1. Option defaults

`queryOptions` is rebuilt via spread so caller-supplied keys win
(the first two statements of `query`; the second sets `escapeNamedValues`):

- `redis` defaults to `_useRedis` (i.e. `config.current.redis.enabled`).
- `maxRetry` defaults to `_errorRetryCount`.
- `redisRefreshCache` defaults to `false`.
- `escapeNamedValues` defaults to the `escapeNamedValues` setting, `false` unless set.

### 2. Metrics

Starts a `QueryTimer` before any work. Every way out of `query` records
one `mysql_dynamic_cluster.query.duration` sample through the local
`record` helper ([src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts)).
See [metrics.md](./metrics.md).

### 3. Service-id resolution

The first lines of the `try` block.

- If the caller passed `serviceName` but no `serviceId`, look it up via
  `ServiceNames.getID(serviceName)` and write it back onto
  `queryOptions.serviceId`.
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
4. If the pinned pool exists in `_pools`, find it and `unshift` it to
   the front so the pinned pool is tried first.
5. Throw `"There is no pool that satisfies the parameters"` if the
   final list is empty. Since 3.2.2 `query()` first serves cached Redis
   data for that SQL, even expired, when `redis` is on for the query and
   no `redisRefreshCache` was asked — the same fallback it already used
   when every pool errors.

### 5. Retry clamp

`retryCount = this._maxRetryCount(queryOptions.maxRetry, activePools.length)`.
`_maxRetryCount`
clamps the retry count to the active-pool count so the retry loop never
overruns the array; if `maxRetry` is missing or non-positive it falls
back to `_errorRetryCount`.

Service-id resolution and active-pool selection share a single
`try`/`catch`: a thrown error is recorded as a failed query and
re-wrapped before being rethrown
(the `catch` of that block).

### 6. SQL formatting

`sql = this._formatSQL(sql, values)`, right after the `try`/`catch`.
`_formatSQL`:

- Array `values` → `mysql2`'s `format(sql, values)` (positional `?`).
- String `values` → same `format()` call.
- Object `values` → regex `:paramName` substitution: `sql.replace(/:(\w+)/g, ...)`
  swaps in the value when the object has the key as its own property,
  otherwise leaves the placeholder verbatim. With `escapeNamedValues` on
  the value goes through `mysql2.escape`. With it off, the default, the
  value goes in as text, not escaped, and the first such value of the
  cluster logs one warning. See
  [../configuration.md](../configuration.md#escapenamedvalues).

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
`this._queryRequest(sql, activePools[i], queryOptions)`. First success
records the query with source `pool` and returns. Each failure pushes
`{ error, pool }` into `errorList` and the loop continues until exhausted.

### 9. Aggregated failure / stale-while-down

The end of `query`, after the loop.

When every pool has failed:

- Build a multi-line error message of `Pool: <name>; Error: <message>`
  per entry in `errorList`.
- If `redisData` is non-null (cache existed but was expired), log a
  warning, record the query with source `stale_cache`, and **return the
  stale payload** anyway.
- Otherwise record the query as failed and throw the aggregated
  message.

### 10. `_queryRequest`

`_queryRequest` in [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts).
Wraps a single `pool.query(sql, queryOptions)` call. The pool records
the attempt as `mysql_dynamic_cluster.operation.duration`. On success:

- If `queryOptions.serviceId` is truthy and `_clusterHashing.connected`,
  awaits `_clusterHashing.updateNodeForService(serviceId, pool.id)` to
  pin the service to the pool that just served it.

On failure the error is
rewrapped as `"Query error: " + e.message` and rethrown to the retry
loop in `query`.

## Public API summary

| Member | Source | Notes |
| --- | --- | --- |
| `connected: boolean` | [:23](../../src/cluster/GaleraCluster.ts#L23) | Flipped to `true` by the first successful pool connect; reset to `false` by `disconnect()`. |
| `pools: Pool[]` (getter) | [:30](../../src/cluster/GaleraCluster.ts#L30) | Tagged `@internal` at [:28](../../src/cluster/GaleraCluster.ts#L28). Used by `ClusterHashing`, `ServiceNames`, and the test harness; not meant for consumers. |
| `connect(): Promise<void>` | [`connect`](../../src/cluster/GaleraCluster.ts) | Resolves on the first pool that comes up; rejects on the first failure before any success. |
| `disconnect(): Promise<void>` | [`disconnect`](../../src/cluster/GaleraCluster.ts) | Synchronous in practice — does not await pool disconnects. |
| `on(event, callback)` | [`on`](../../src/cluster/GaleraCluster.ts) | Pass-through to the shared `Events` emitter. |
| `query<T>(sql, values?, queryOptions?)` | [`query`](../../src/cluster/GaleraCluster.ts) | The full routing pipeline described above. |
