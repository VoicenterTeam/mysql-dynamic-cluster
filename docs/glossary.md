# Glossary

Shared terminology for `@voicenter-team/mysql-dynamic-cluster`. Other docs assume these definitions; cross-reference here when a term is unclear.

## Galera & MySQL

### Galera cluster

A synchronous, multi-master replication cluster for MySQL/MariaDB built on the Galera library and `wsrep` API. Every node accepts writes and applies them on all other nodes via certification-based replication, so any healthy node holds the same data. This library treats each cluster member as an independent connection target and routes queries to the best-scoring healthy node.

### `wsrep_*` variables

Server-status variables exposed by a Galera-enabled MySQL/MariaDB instance under `SHOW GLOBAL STATUS`, prefixed `wsrep_` (write-set replication). In this library they are read alongside other status keys by [src/pool/Validator.ts:45](../src/pool/Validator.ts#L45) and used both for health checks and load scoring. Common ones referenced by default config: `wsrep_ready` (node accepts queries), `wsrep_local_state_comment` (e.g. `Synced`, `Joining`, `Donor`), and `wsrep_local_recv_queue_avg` (mean inbound replication queue length).

### MariaDB / Percona context

MariaDB Galera Cluster and Percona XtraDB Cluster are the two production-grade distributions that ship Galera replication; both expose the same `wsrep_*` status surface this library relies on. Defaults in [src/configs/schema.ts:42](../src/configs/schema.ts#L42) target that surface, so either distribution works without extra configuration. Vanilla Oracle MySQL is not supported because it does not expose `wsrep_*` variables.

## This library's concepts

### Pool

A single backing node, wrapped as one `mysql2.Pool` instance plus its health state, validators, load factor, and metrics. Each `Pool` corresponds to exactly one host:port in the cluster config; the cluster (`GaleraCluster`) holds an ordered list of them and picks one per query. References: `src/pool/Pool.ts` and `src/pool/PoolStatus.ts`.

### Validator

A boolean health check applied to a pool's most recent `SHOW GLOBAL STATUS` snapshot (or to a few synthetic keys like `available_connection_count`, `query_time`, `active`). A pool is considered usable only when every configured validator passes; the comparison is done by `key`/`operator`/`value` in [src/pool/Validator.ts:29](../src/pool/Validator.ts#L29). Defaults at [src/configs/schema.ts:45](../src/configs/schema.ts#L45) require `wsrep_ready = ON`, `wsrep_local_state_comment = Synced`, and `Threads_running < 50`.

### Load factor

A `{ key, multiplier }` pair telling the cluster how to weight one status variable when ranking healthy pools. Each load factor reads its `key` from the latest `SHOW GLOBAL STATUS` result and contributes `value * multiplier` to the pool's load score; see [src/pool/LoadFactor.ts:25](../src/pool/LoadFactor.ts#L25). Defaults at [src/configs/schema.ts:54](../src/configs/schema.ts#L54) weight `Connections` by 2 and `wsrep_local_recv_queue_avg` by 10.

### Pool score / load score

The numeric output of summing every load factor on a pool, used to sort healthy pools so the cluster picks the least-loaded one for the next query. Lower is better; the score is recomputed each time a pool refreshes its status (see `Pool.ts` and `LoadFactor.check`). A pool that fails validators is excluded entirely, regardless of score.

### Service ID / service name

A caller-supplied identifier used to pin a unit of work to a specific node. The numeric `service.id` is the key in the cluster's service-to-node map (see `_serviceNodeMap` in `ClusterHashing.ts`), while `service.name` is a human label surfaced in metric prefixes (see `Metrics._generatePrefixes`). Both are optional per-query options; without them, queries fall back to load-score routing.

### Cluster hashing

This library's sticky-routing feature that pins a given service ID to a single node so queries from the same caller hit the same pool until the mapping changes. The map is kept in a helper schema named `${clusterName}_${dbName}` (default `demo_mysql_dynamic_cluster`) and refreshed on a timer, see [src/cluster/ClusterHashing.ts:30](../src/cluster/ClusterHashing.ts#L30). When enabled (`useClusterHashing = true`), `getNodeByService(serviceId)` overrides the normal load-score selection.

### Slow query

A query whose execution time exceeds the `slowQueryTime` threshold from [src/configs/schema.ts:78](../src/configs/schema.ts#L78) (default `1` second). Slow queries are logged and counted via metrics but are not aborted; `queryTimeout` (default 2 minutes) is the separate hard limit that does abort.

## Caching (Redis)

### Expiry mode (`EX`)

The Redis flag passed alongside `SET` to attach a TTL in seconds; the library only supports `EX` (see the `format: ['EX']` constraint at [src/configs/schema.ts:174](../src/configs/schema.ts#L174)). Combined with the `expire` setting (default `1000000` seconds), every cached query result expires that many seconds after it is written.

### Key prefix

A string prepended to every Redis key the library writes, configured by `redis.keyPrefix` (default `"mdc:"`, see [src/configs/schema.ts:162](../src/configs/schema.ts#L162)). It namespaces this library's cache entries so they coexist with other consumers of the same Redis instance and can be wiped wholesale on start via `clearOnStart`.

## Logging (AMQP)

### Exchange

An AMQP routing component that receives published messages and forwards them to queues based on a routing key and exchange type. The library declares one exchange named `Logs` of type `topic` by default ([src/configs/schema.ts:264](../src/configs/schema.ts#L264)) and publishes every log record to it.

### Queue

A named AMQP buffer that holds messages until a consumer reads them. The logger declares a queue named `MYSQL_CLUSTER_LOGS` by default ([src/configs/schema.ts:278](../src/configs/schema.ts#L278)); downstream services subscribe to it to ship logs onward.

### Binding

The rule that connects a queue to an exchange via a routing-key pattern; without a binding, messages published to the exchange never reach the queue. The library binds its queue to its exchange using the pattern `mysql_logs` when `bindings.enabled` is true ([src/configs/schema.ts:286](../src/configs/schema.ts#L286)).

## Metrics (pm2.io)

### Counter

A monotonic integer pm2.io exposes via `pm2io.counter`, incremented or decremented one step at a time. The library uses `Metrics.inc`/`Metrics.dec` for things like active-connection counts; see [src/metrics/Metrics.ts:51](../src/metrics/Metrics.ts#L51).

### Meter

A pm2.io primitive that measures the rate (frequency per second) at which an event is marked. The library calls `Metrics.mark` on each occurrence, e.g. queries-per-second, through `pm2io.meter`; see [src/metrics/Metrics.ts:77](../src/metrics/Metrics.ts#L77).

### Histogram

A pm2.io primitive that records a distribution of numeric samples and reports a summary statistic (mean, by default). The library feeds samples via `Metrics.update` for things like query latency, see [src/metrics/Metrics.ts:85](../src/metrics/Metrics.ts#L85) and the `MetricMeasurements.mean` setting in `_createMetric`.

### Metric (gauge)

A pm2.io gauge holding a single current value that can be set arbitrarily, used for snapshot-style readings such as a pool's current load score. The library calls `Metrics.set` to update it, see [src/metrics/Metrics.ts:38](../src/metrics/Metrics.ts#L38). Note the type is named `METRIC` in [src/types/MetricsInterfaces.ts](../src/types/MetricsInterfaces.ts) even though it maps to pm2.io's gauge primitive.
