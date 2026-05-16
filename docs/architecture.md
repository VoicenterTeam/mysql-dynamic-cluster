# Architecture

`@voicenter-team/mysql-dynamic-cluster` wraps `mysql2` to route queries
across a Galera cluster with health-aware pool selection, service-sticky
routing via cluster hashing, optional Redis caching, pm2.io metrics, and
a winston-based logger with an optional AMQP transport. The library
exposes a single factory, `createPoolCluster`, that assembles a process-
wide `GaleraCluster` instance backed by a shared configuration, metric
registry, logger, and Redis client.

Terms used here (Pool, Validator, Load factor, Cluster hashing, Pool
score) are defined in [glossary.md](./glossary.md).

## Boot flow

The factory in [index.ts:11](../index.ts#L11) wires the singletons before
constructing `GaleraCluster`:

1. `createPoolCluster(userSettings)` is called by the consumer —
   [index.ts:11](../index.ts#L11).
2. `Settings.mixSettings(userSettings)` deep-merges the defaults pulled
   from the convict singleton with the user input and then expands every
   host using `defaultPoolSettings` —
   [src/utils/Settings.ts:17](../src/utils/Settings.ts#L17).
3. `redisInstant` is stripped off the merged settings —
   [index.ts:13-14](../index.ts#L13). It is an injection seam for an
   externally constructed `ioredis` client, not a value that belongs in
   the convict schema.
4. `config.load(userSettings).validate` writes the merged user input
   back into the convict singleton and validates the schema —
   [index.ts:15](../index.ts#L15). The convict instance itself is
   created and validated once at module load in
   [src/configs/index.ts:9](../src/configs/index.ts#L9) and exported as
   a singleton via [src/configs/index.ts:27](../src/configs/index.ts#L27).
5. `init(redisInstant)` runs the per-process bootstrap —
   [index.ts:20-28](../index.ts#L20):
   - `Logger.init()` ([index.ts:21](../index.ts#L21)) builds the winston
     transports, including the optional AMQP transport.
   - `Metrics.init(clusterName, showMetricKeys)`
     ([index.ts:22](../index.ts#L22)) registers the pm2.io metric set.
   - `Redis.init(...)` is called only when `redisInstant` is an
     `ioredis` `Cluster` or `Redis` instance
     ([index.ts:24-26](../index.ts#L24)).
6. `new GaleraCluster()` is returned — [index.ts:17](../index.ts#L17).
   The constructor reads `useClusterHashing`, `clusterName`,
   `errorRetryCount`, `redis.enabled`, and the host list from the
   convict singleton, then constructs one `Pool` per host
   ([src/cluster/GaleraCluster.ts:46-72](../src/cluster/GaleraCluster.ts#L46)).
   Hosts without a numeric `id` get one auto-assigned from the sorted
   set of existing ids
   ([src/cluster/GaleraCluster.ts:55-66](../src/cluster/GaleraCluster.ts#L55)).
   `ServiceNames` and `ClusterHashing` helpers are also instantiated
   here
   ([src/cluster/GaleraCluster.ts:68-69](../src/cluster/GaleraCluster.ts#L68)).

`connect()` ([src/cluster/GaleraCluster.ts:91](../src/cluster/GaleraCluster.ts#L91))
is invoked by the consumer after construction and brings each `Pool`
online; when the first pool resolves, `_enableHashing()` is fired if
`useClusterHashing` is true
([src/cluster/GaleraCluster.ts:99](../src/cluster/GaleraCluster.ts#L99)).

## Runtime query flow

`query()` lives at
[src/cluster/GaleraCluster.ts:155](../src/cluster/GaleraCluster.ts#L155).
Each call walks the following steps:

1. **Resolve `serviceId`**
   ([src/cluster/GaleraCluster.ts:171-178](../src/cluster/GaleraCluster.ts#L171)).
   If the caller supplies `serviceName` but no `serviceId`, the id is
   looked up through `ServiceNames`. If neither is supplied,
   `serviceId` is set to `0` and a synthetic name
   `${clusterName}_mdc` is recorded so metrics can still bucket the
   call.
2. **Pick active pools** via `_getActivePools(serviceId)` —
   [src/cluster/GaleraCluster.ts:180](../src/cluster/GaleraCluster.ts#L180),
   implemented at
   [src/cluster/GaleraCluster.ts:321](../src/cluster/GaleraCluster.ts#L321).
   It filters out invalid pools, sorts the remainder by `loadScore`
   ascending, and, when cluster hashing has pinned a node for the
   service id, prepends that pool to the head of the list
   ([src/cluster/GaleraCluster.ts:329-337](../src/cluster/GaleraCluster.ts#L329)).
   If nothing survives the filter, an error is thrown
   ([src/cluster/GaleraCluster.ts:339-341](../src/cluster/GaleraCluster.ts#L339)).
3. **Format SQL** — `_formatSQL(sql, values)` applies `mysql2`'s array
   or string escaping, or a `:name` substitution for object values —
   [src/cluster/GaleraCluster.ts:187](../src/cluster/GaleraCluster.ts#L187)
   and
   [src/cluster/GaleraCluster.ts:300-314](../src/cluster/GaleraCluster.ts#L300).
4. **Redis read** — when `queryOptions.redis` is true and
   `redisRefreshCache` is false, the formatted SQL is looked up in
   Redis. If a payload is returned and its `expired` timestamp is
   still in the future, the cached value is returned immediately and
   the query is short-circuited
   ([src/cluster/GaleraCluster.ts:190-210](../src/cluster/GaleraCluster.ts#L190)).
5. **Retry loop** — up to `retryCount` (capped by
   `_maxRetryCount(maxRetry, activePools.length)` at
   [src/cluster/GaleraCluster.ts:285](../src/cluster/GaleraCluster.ts#L285))
   pools are tried in order; the first success returns the result —
   [src/cluster/GaleraCluster.ts:217-233](../src/cluster/GaleraCluster.ts#L217).
   On success, `_queryRequest`
   ([src/cluster/GaleraCluster.ts:258](../src/cluster/GaleraCluster.ts#L258))
   also updates the hashing map so a follow-up request for the same
   `serviceId` lands on the same node
   ([src/cluster/GaleraCluster.ts:268-270](../src/cluster/GaleraCluster.ts#L268)).
6. **Stale fallback** — if every pool failed but a Redis payload was
   read earlier (even if expired), it is returned with a warning;
   otherwise the accumulated per-pool error messages are thrown —
   [src/cluster/GaleraCluster.ts:241-248](../src/cluster/GaleraCluster.ts#L241).
7. **Metrics on every branch** — counters and meters are nudged at each
   decision point: `queryPerMinute` and `allQueries` on entry
   ([src/cluster/GaleraCluster.ts:167-168](../src/cluster/GaleraCluster.ts#L167)),
   `errorQueries` on setup or final failure
   ([src/cluster/GaleraCluster.ts:183](../src/cluster/GaleraCluster.ts#L183),
   [src/cluster/GaleraCluster.ts:247](../src/cluster/GaleraCluster.ts#L247)),
   `redis.uses` / `redis.expired` / `redis.latency` around the cache
   read
   ([src/cluster/GaleraCluster.ts:191-209](../src/cluster/GaleraCluster.ts#L191)),
   and `successfulQueries` on each return path
   ([src/cluster/GaleraCluster.ts:204](../src/cluster/GaleraCluster.ts#L204),
   [src/cluster/GaleraCluster.ts:221](../src/cluster/GaleraCluster.ts#L221),
   [src/cluster/GaleraCluster.ts:243](../src/cluster/GaleraCluster.ts#L243)).

## Disconnect flow

`disconnect()` —
[src/cluster/GaleraCluster.ts:129-138](../src/cluster/GaleraCluster.ts#L129)
— performs three actions in order:

1. Stops the cluster-hashing refresh timer
   ([src/cluster/GaleraCluster.ts:132](../src/cluster/GaleraCluster.ts#L132)).
2. Calls `Redis.disconnect()` to close the shared client
   ([src/cluster/GaleraCluster.ts:133](../src/cluster/GaleraCluster.ts#L133)).
3. Iterates over every pool and calls `pool.disconnect()`, which in
   turn calls the underlying `mysql2` `pool.end`
   ([src/cluster/GaleraCluster.ts:134-136](../src/cluster/GaleraCluster.ts#L134)).
   It finishes by emitting the `disconnected` cluster event.

## Singletons

Every collaborator below is exported as a module-level singleton. There
is exactly one instance per Node process, regardless of how many times
`createPoolCluster` is called.

| Singleton | Source | Consequence if duplicated |
| --- | --- | --- |
| `Logger` | [src/utils/Logger.ts:85](../src/utils/Logger.ts#L85) | A second logger would overwrite winston transports and AMQP credentials configured by the first cluster. |
| `Redis` | [src/Redis/Redis.ts:93](../src/Redis/Redis.ts#L93) | A second Redis singleton would overwrite the `clusterName` prefix and the injected `ioredis` client, mixing cache keys between clusters. |
| `Metrics` | [src/metrics/Metrics.ts:195](../src/metrics/Metrics.ts#L195) | The pm2.io metric registry is shared; the second `init()` would clobber names emitted by the first. |
| `config` | [src/configs/index.ts:27](../src/configs/index.ts#L27) | Convict is loaded once and validated at import; calling `config.load(...)` again overwrites the first cluster's hosts, validators, and Redis settings. |
| `Events` | [src/utils/Events.ts:4](../src/utils/Events.ts#L4) | The single `EventEmitter` would fan out `connected` / `disconnected` / `hashing_created` events from both clusters into every subscriber. |

**Net effect:** the library supports effectively one `GaleraCluster`
per process. Constructing a second cluster against a different host
set would silently corrupt the first one's configuration, metrics
registry, and Redis prefix. If multi-cluster routing is needed, isolate
each cluster in its own process.
