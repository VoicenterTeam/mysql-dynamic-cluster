# Subsystem: Redis cache

The `Redis` singleton is an **optional** query-result cache that sits in
front of the pool retry loop. When enabled, `GaleraCluster.query` first
asks Redis for a cached result keyed by the post-format SQL string; on a
hit (and if the in-payload freshness check passes) it returns the cached
rows without ever touching MySQL. On a miss the query falls through to
the normal pool loop and `Pool.query` writes the successful result back
to Redis. The cache also doubles as a **stale-while-down** fallback when
every pool fails.

The cache is **off by default** in the V3 schema
([src/configs/schema.ts:159](../../src/configs/schema.ts#L159) —
`redis.enabled` defaults to `false`). The user-facing `useRedis` flag on
the cluster (`_useRedis`) is read directly from `redis.enabled`
([src/cluster/GaleraCluster.ts:52](../../src/cluster/GaleraCluster.ts#L52)),
so unless the caller (or `MYSQL_REDIS_ENABLE`) flips that bit, the cache
is bypassed entirely and no `ioredis` client is constructed.

Source: [src/Redis/Redis.ts](../../src/Redis/Redis.ts). See also
[../configuration.md](../configuration.md) for the schema keys and
[../known-issues.md](../known-issues.md) for known caveats.

## Initialisation

[src/Redis/Redis.ts:15-22](../../src/Redis/Redis.ts#L15).

`Redis.init(newRedis, clusterName, redisSettings)` is invoked by
`GaleraCluster` after the `ioredis` client has been constructed. The
method:

1. Stores the `ioredis` `Redis` or `Cluster` instance on
   `this.redis` ([src/Redis/Redis.ts:17](../../src/Redis/Redis.ts#L17)).
2. Stores the merged `redisSettings`
   ([src/Redis/Redis.ts:18](../../src/Redis/Redis.ts#L18)).
3. **Prefixes `keyPrefix` with the cluster name**:
   `this.redisSettings.keyPrefix = ${clusterName}_${redisSettings.keyPrefix}`
   ([src/Redis/Redis.ts:19](../../src/Redis/Redis.ts#L19)). This is the
   only place `clusterName` is used by the cache, and it guarantees that
   two clusters sharing the same Redis backend produce disjoint keys.
4. Wires the `'ready'` event via `connectEvents()`
   ([src/Redis/Redis.ts:36-43](../../src/Redis/Redis.ts#L36)). On
   `'ready'` the singleton flips `isReady = true` and, if
   `clearOnStart` is set, calls `clearAll()`.

`isEnabled()` ([src/Redis/Redis.ts:45-47](../../src/Redis/Redis.ts#L45))
returns `true` only when both the client exists **and** `'ready'` has
fired; every `get`/`set` early-returns `null` otherwise, so queries
issued during the warm-up window simply miss the cache.

## Connection model

`ioredis` initiates a TCP connection on construction by default, so the
client is typically already connecting (or connected) by the time
`Redis.init` runs.

`Redis.connect()` ([src/Redis/Redis.ts:49-53](../../src/Redis/Redis.ts#L49))
is intended as an idempotent entry point: it short-circuits when
`isEnabled()` is true, otherwise calls `this.redis?.connect(callback)`.
The `isEnabled()` guard only filters the **fully ready** state, not the
transient `connecting`/`reconnecting` states, which means calling
`Redis.connect()` after `init()` can race the auto-connect and reject
with `Redis is already connecting/connected`. See
[../known-issues.md#8-redisconnect-double-connect-risk](../known-issues.md#8-redisconnect-double-connect-risk)
for the full write-up and suggested fix.

`Redis.disconnect(reconnect?)`
([src/Redis/Redis.ts:55-59](../../src/Redis/Redis.ts#L55)) forwards to
`ioredis.disconnect` and clears `isReady`.

## Key derivation

[src/Redis/Redis.ts:86-90](../../src/Redis/Redis.ts#L86).

Every `get` and `set` derives the storage key as:

```text
key = keyPrefix + hash(sql)
hash(sql) = createHash(algorithm).update(sql).digest(encoding)
```

- `algorithm` — `md5` (default) or `sha256`
  ([src/configs/schema.ts:180-185](../../src/configs/schema.ts#L180)).
- `encoding` — `base64` (default) or `hex`
  ([src/configs/schema.ts:186-191](../../src/configs/schema.ts#L186)).
- `keyPrefix` — `${clusterName}_${prefix}` with `prefix` defaulting to
  `mdc:`
  ([src/configs/schema.ts:162-167](../../src/configs/schema.ts#L162)).

The `sql` passed to `hash()` is the **post-format** string built by
`GaleraCluster._formatSQL(sql, values)` at
[src/cluster/GaleraCluster.ts:187](../../src/cluster/GaleraCluster.ts#L187),
i.e. value interpolation has already happened. Different parameter
bindings therefore hash to different keys and produce independent cache
entries — `SELECT * FROM t WHERE id = 1` and
`SELECT * FROM t WHERE id = 2` do not share storage.

## Write path

[src/pool/Pool.ts:215-222](../../src/pool/Pool.ts#L215).

After a successful pool query, `Pool.query` writes the result back to
Redis when `queryOptions.redis` is true:

```ts
if (queryOptions.redis) {
    const redisExpired = new Date().getTime()
        + queryTimer.get() * 1000 * queryOptions.redisFactor;
    const redisData: IRedisData = {
        data: result,
        expired: redisExpired,
    };
    Redis.set(sql, JSON.stringify(redisData), queryOptions.redisExpire);
}
```

The payload shape is `IRedisData = { data: any, expired: number }`
([src/types/RedisInterfaces.ts:23-26](../../src/types/RedisInterfaces.ts#L23)).
There are **two independent expiries** on every cache entry:

1. **Redis-level TTL.** `Redis.set` uses `expireMode` (`EX` by default)
   and `expire` seconds
   ([src/Redis/Redis.ts:61-73](../../src/Redis/Redis.ts#L61)). The
   per-query `queryOptions.redisExpire` takes precedence; otherwise the
   schema default of **1 000 000 s** applies
   ([src/configs/schema.ts:168-173](../../src/configs/schema.ts#L168)).
   When the TTL fires, Redis evicts the key entirely.
2. **In-payload `expired` timestamp.** Stored as
   `now + queryTime * 1000 * redisFactor`, where `queryTime` is the
   measured query duration in seconds and `redisFactor` defaults to `1`
   ([src/configs/schema.ts:84-89](../../src/configs/schema.ts#L84)).
   The cluster-side read path uses this timestamp to decide whether the
   entry is fresh enough to return without re-querying MySQL.

Worked example: a query that takes `1 s` with `redisFactor = 100`
produces `expired = now + 100 000 ms`, i.e. the entry is treated as
"fresh" for 100 seconds. A query that takes `10 ms` with the default
`redisFactor = 1` is fresh for only 10 ms. The factor is therefore a
"how much slower than the query is it worth waiting?" knob: large
factors keep slow queries cached aggressively, small factors keep cheap
queries cached barely at all.

## Read path

[src/cluster/GaleraCluster.ts:186-210](../../src/cluster/GaleraCluster.ts#L186).

Before entering the pool retry loop, `GaleraCluster.query` performs:

1. Skip the cache entirely when `queryOptions.redisRefreshCache` is
   set, even if `queryOptions.redis` is true
   ([src/cluster/GaleraCluster.ts:190](../../src/cluster/GaleraCluster.ts#L190)).
2. Otherwise time-box a `Redis.get(sql)` call (recorded against
   `MetricNames.redis.latency`,
   [src/cluster/GaleraCluster.ts:191-198](../../src/cluster/GaleraCluster.ts#L191))
   and increment `MetricNames.redis.uses`.
3. If `Redis.get` returns a JSON string, parse it into `redisData` and
   compare `redisData.expired` to `Date.now()`
   ([src/cluster/GaleraCluster.ts:200-209](../../src/cluster/GaleraCluster.ts#L200)).
   - **Fresh** (`expired > Date.now()`): bump
     `MetricNames.cluster.successfulQueries` and return
     `redisData.data` immediately. MySQL is not touched.
   - **Stale** (`expired <= Date.now()`): bump
     `MetricNames.redis.expired` and **keep `redisData` in scope** while
     falling through to the pool retry loop.

A Redis miss (`get` returns `null`) is treated the same as the cache
being disabled: the pool loop runs and any successful result is written
back by the write path above.

## Stale-while-down fallback

[src/cluster/GaleraCluster.ts:240-245](../../src/cluster/GaleraCluster.ts#L240).

After every pool in the retry loop has failed, `GaleraCluster.query`
checks whether it has a stashed `redisData` from the earlier read
attempt. If so, it logs a warning, increments
`MetricNames.cluster.successfulQueries`, and returns the **expired**
cached `data` rather than throwing. The behaviour:

- Only triggers when the entry was found in Redis but was older than
  `expired`; a clean cache miss does not provide a fallback.
- Returns potentially stale data without surfacing it to the caller as
  "stale" — there is no flag on the return value. Callers that need to
  distinguish must either set `redisRefreshCache` (which skips the
  read path and therefore the fallback) or check the cluster's emitted
  metrics.
- Bypasses the throw at
  [src/cluster/GaleraCluster.ts:248](../../src/cluster/GaleraCluster.ts#L248)
  entirely.

## Key prefix override

Because `init()` rewrites
`redisSettings.keyPrefix → ${clusterName}_${redisSettings.keyPrefix}`
([src/Redis/Redis.ts:19](../../src/Redis/Redis.ts#L19)), two
`GaleraCluster` instances pointed at the same Redis server with
different `clusterName` values cannot collide on keys, even if their
SQL hashes happen to match. The combined prefix is also what
`clearAll()` matches against (see below), so each cluster's clear is
scoped to its own keys.

The downside is that `keyPrefix` is mutated in place on the **shared**
settings object: re-initialising the singleton (e.g. in tests) without
recreating the settings would double-prefix it. Tests that call
`init()` repeatedly should rebuild `redisSettings` each time.

## `clearOnStart`

[src/Redis/Redis.ts:24-34, 36-43](../../src/Redis/Redis.ts#L24).

When `redis.clearOnStart` is `true`
([src/configs/schema.ts:192-197](../../src/configs/schema.ts#L192) —
default `false`), the `'ready'` handler invokes `clearAll()`:

1. `this.redis.keys(keyPrefix + "*")` — scans for every key under the
   combined `${clusterName}_${prefix}` namespace.
2. Pipelines a `DEL` for each match and executes the pipeline.

Only keys matching the prefix are deleted; the rest of the Redis
database (other clusters, other applications) is untouched. The
operation runs once per `'ready'` event, so a reconnect that re-fires
`'ready'` would also re-clear — relevant if you treat
`clearOnStart` as a one-shot.
