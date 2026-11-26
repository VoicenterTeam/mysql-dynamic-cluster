# Architecture

`@voicenter-team/mysql-dynamic-cluster` wraps `mysql2` to route queries
across a Galera cluster with health-aware pool selection, service-sticky
routing via cluster hashing, optional Redis caching, OpenTelemetry metrics, and
a console logger that the app can replace with its own. The library
exposes a single factory, `createPoolCluster`, that assembles a
`GaleraCluster` instance with a logger and a metrics cluster name of its
own, backed by a configuration, metric instruments, an event emitter and
a Redis client that every cluster of the process shares, see
[Singletons](#singletons).

Terms used here (Pool, Validator, Load factor, Cluster hashing, Pool
score) are defined in [glossary.md](./glossary.md).

## Boot flow

The factory in [index.ts](../index.ts) wires the singletons before
constructing `GaleraCluster`:

1. `createPoolCluster(userSettings)` is called by the consumer —
   [index.ts](../index.ts).
2. `redisInstant` and `logger` are stripped off the user settings
   ([index.ts](../index.ts)). They are live objects of the app (an
   externally constructed `ioredis` client and a logger), not values
   that belong in the settings schema.
3. `Settings.mixSettings(settings)` validates the rest with
   `parseSettings`, the zod schema in
   [src/configs/schema.ts](../src/configs/schema.ts), which also fills in
   the defaults. Every object in the schema is strict. On an unknown key
   or a wrong type it throws one `Error`
   (`Invalid mysql-dynamic-cluster settings: ...`) that lists every
   problem by its path. It then deep-merges every host with
   `defaultPoolSettings`
   ([src/utils/Settings.ts](../src/utils/Settings.ts), `Settings.mixSettings`).
4. `config.load(...)` stores the validated settings in the `config`
   singleton ([index.ts](../index.ts)). The rest of the library
   reads them from `config.current`. The singleton is exported at
   [src/configs/index.ts](../src/configs/index.ts). The library
   reads no environment variable, no `.env` file and no config file.
5. `init(redisInstant, logger)` runs the per-process bootstrap —
   [index.ts](../index.ts):
   - `Logger.init(level, logger)` ([index.ts](../index.ts)) sets
     the log level and the logger of the module logger: the app-supplied
     `logger` if given, otherwise the console. The module logger logs for
     the parts every cluster shares. See [subsystems/logger.md](subsystems/logger.md).
   - `Metrics.init(clusterName)`
     ([index.ts](../index.ts)) stores the cluster name a metric carries
     when the part that records it has no cluster of its own. Instruments
     are created on first use.
   - `Redis.init(...)` is called only when `redisInstant` is an
     `ioredis` `Cluster` or `Redis` instance
     ([index.ts](../index.ts)).
6. `new GaleraCluster(clusterContext(logger))` is returned —
   [index.ts](../index.ts). Since 4.2.0-rc.3 (#86) `clusterContext`
   builds the context of the new cluster, `IClusterContext` in
   [src/types/ClusterContextInterfaces.ts](../src/types/ClusterContextInterfaces.ts):
   a logger with the `logs.level` and the `logger` of these settings,
   and their `clusterName` for its metrics.
   The constructor reads `useClusterHashing`, `clusterName`,
   `errorRetryCount`, `redis.enabled`, and the host list from
   `config.current`, then constructs one `Pool` per host
   (the constructor in [src/cluster/GaleraCluster.ts](../src/cluster/GaleraCluster.ts)).
   Hosts without a numeric `id` get one auto-assigned from the sorted
   set of existing ids
   (`_sortPoolIds` and the loop over the hosts).
   `ServiceNames` and `ClusterHashing` helpers are also instantiated
   here, at the end of the constructor.

`connect()` (in [src/cluster/GaleraCluster.ts](../src/cluster/GaleraCluster.ts))
is invoked by the consumer after construction and brings each `Pool`
online; when the first pool resolves, `_enableHashing()` is fired if
`useClusterHashing` is true.

## Runtime query flow

`query()` lives in
[src/cluster/GaleraCluster.ts](../src/cluster/GaleraCluster.ts).
The references below name the function to look in, not a line.
Each call walks the following steps:

1. **Resolve `serviceId`**
   (the first lines of the `try` block in `query`).
   If the caller supplies `serviceName` but no `serviceId`, the id is
   looked up through `ServiceNames`. If neither is supplied,
   `serviceId` is set to `0` and a synthetic name
   `${clusterName}_mdc` is recorded so metrics can still bucket the
   call.
2. **Pick active pools** via `_getActivePools(serviceId)`.
   It filters out invalid pools, sorts the remainder by `loadScore`
   ascending, and, when cluster hashing has pinned a node for the
   service id, prepends that pool to the head of the list.
   If nothing survives the filter, an error is thrown.
3. **Format SQL** — `_formatSQL(sql, values)` applies `mysql2`'s array
   or string escaping, or an escaped `:name` substitution for object values.
   `query` calls it right after the `try`/`catch`. A call with the option
   `execute` (`cluster.execute()`) skips it: mysql2 sends the values bound
   by the server, and Redis is not used.
4. **Redis read** — when `queryOptions.redis` is true and
   `redisRefreshCache` is false, the formatted SQL is looked up in
   Redis. If a payload is returned and its `expired` timestamp is
   still in the future, the cached value is returned immediately and
   the query is short-circuited
   (the `if` block after the SQL is formatted).
5. **Retry loop** — up to `retryCount` (capped by
   `_maxRetryCount(maxRetry, activePools.length)`)
   pools are tried in order, skipping a pool that is no longer valid at
   its turn (#151); the first success returns the result
   (the `for` loop in `query`). The next pool is tried only when the
   statement cannot have run on the one before: it was never sent, or
   the node answered 1047. Never after an error reply, a timeout or a
   lost connection, see
   [subsystems/cluster.md](subsystems/cluster.md#8-retry-loop).
   On success, `_queryRequest`
   also updates the hashing map so a follow-up request for the same
   `serviceId` lands on the same node.
6. **Stale fallback** — if the loop ends without a result, because
   every pool it tried failed or it stopped early, but a Redis payload
   was read earlier (even if expired), it is returned with a warning;
   otherwise the error of the node tried last is thrown, with the
   earlier ones in its `errors`
   (the end of `query`, after the loop).
7. **Metrics on every exit.** The call is timed from entry, and each
   way out records one `mysql_dynamic_cluster.query.duration` sample with
   its result source (`pool`, `cache`, `stale_cache`) or an `error.type`.
   The cache read records `mysql_dynamic_cluster.cache.lookup.duration`,
   and every pool attempt records `mysql_dynamic_cluster.operation.duration`. See
   [subsystems/metrics.md](subsystems/metrics.md).

## Disconnect flow

`disconnect()` in
[src/cluster/GaleraCluster.ts](../src/cluster/GaleraCluster.ts)
performs four actions in order:

1. Calls `Metrics.unregisterPools`, which ends the pool connection metrics
   of its pools.
2. Stops the cluster-hashing refresh timer.
3. Calls `Redis.disconnect()` to close the shared client, only when this
   cluster's own `redis.enabled` is true. A cluster without redis leaves
   the client alone, and logs no `Redis disconnected`.
4. Iterates over every pool and calls `pool.disconnect()`, which in
   turn calls the underlying `mysql2` `pool.end`.
   It finishes by emitting the `disconnected` cluster event.

## Singletons

Since 4.2.0-rc.3 (#86) each `GaleraCluster` has two things of its own,
held in the context `createPoolCluster` builds for it. The cluster
hands the context to its pools, its hashing and its service names, and
each pool hands it on to its health check, its validator and load
factor, its `Borrow`, its `SessionState` and its check connection.

| Per cluster | What it is | A later `createPoolCluster` |
| --- | --- | --- |
| Its logger | A view of the module `Logger` with the `logs.level` and the `logger` of the cluster's own settings. Every part of the cluster logs through it. | Leaves it as it is. |
| Its metrics cluster name | The `clusterName` of its settings, on every point the cluster and its pools record, and on the pool connection metrics and node gauges read at collection. | Leaves it as it is. |

The pools, and what the constructor read off `config.current`, are the
cluster's own as well.

Every collaborator below is still exported as a module-level singleton.
There is exactly one instance per Node process, regardless of how many
times `createPoolCluster` is called.

| Singleton | Source | What the clusters of one process share |
| --- | --- | --- |
| `Logger` | [src/utils/Logger.ts](../src/utils/Logger.ts) | The module logger, with the level and the logger of the last `createPoolCluster`. It logs what no cluster owns: `Initialized app`, the warning that `createPoolCluster` was called again, the lines of `Events` and `Redis`, and the first metric that failed to record. The logger of a cluster is a view of it: the methods are the module logger's, and only the level and the app's logger are the cluster's. |
| `Metrics` | [src/metrics/Metrics.ts](../src/metrics/Metrics.ts) | One set of instruments on the meter of the app's provider, and one registry of the pools of every connected cluster, each kept with the name of its cluster. `init()` sets the name of a record that brings none: one of a part built without a cluster. Two pools with the same name, address, port and cluster name report on one series: at each collection the point of one overwrites the point of the other. |
| `config` | [src/configs/index.ts](../src/configs/index.ts) | `config.current` holds the settings of the last `createPoolCluster`. A cluster reads it only in its constructor, so an earlier cluster keeps its hosts, validators and Redis switch. |
| `Redis` | [src/Redis/Redis.ts:93](../src/Redis/Redis.ts#L93) | One `ioredis` client and one key prefix: those of the last `createPoolCluster` that passed a `redisInstant`. The cache keys of two clusters mix under that prefix, and `disconnect()` of a cluster that enabled redis disconnects the shared client (with two Redis-enabled clusters, either one closes it); `disconnect()` of a cluster without redis leaves it alone. |
| `Events` | [src/utils/Events.ts:4](../src/utils/Events.ts#L4) | One `EventEmitter`: a listener added with `cluster.on()` of one cluster hears the `connected`, `disconnected`, `hashing_created` and pool events of every cluster. |

**Net effect:** two clusters in one process keep their logs and their
metrics apart. They share the event emitter and the Redis cache. If
their listeners must not hear each other, or each needs a Redis cache of
its own, isolate each cluster in its own process.
