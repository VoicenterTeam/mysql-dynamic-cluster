# Subsystem: Metrics

The `Metrics` singleton records query and cache timings, and reports the
connection counts of the pools, through the
[OpenTelemetry API](https://opentelemetry.io/docs/languages/js/instrumentation/).
The package depends only on `@opentelemetry/api`, as a peer dependency. It
never starts an SDK or an exporter, and requiring it adds no process
listeners and starts no timer. Until the host app registers a
`MeterProvider`, every call is a no-op.

Before 4.0.0 the metrics went to `@pm2/io`. That dependency is gone, see
[Migrating from the pm2 metrics](#migrating-from-the-pm2-metrics).

Source:
[src/metrics/Metrics.ts](../../src/metrics/Metrics.ts),
[src/metrics/MetricNames.ts](../../src/metrics/MetricNames.ts),
[src/types/MetricsInterfaces.ts](../../src/types/MetricsInterfaces.ts).

## Enabling an exporter in your app

Install the API plus the SDK and exporter you want. The library needs only
the API, the rest is the app's choice:

```bash
npm i @opentelemetry/api @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

Register a `MeterProvider` once at startup:

```js
const { metrics } = require('@opentelemetry/api');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');

metrics.setGlobalMeterProvider(new MeterProvider({
    readers: [
        new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
            exportIntervalMillis: 60000
        })
    ]
}));

const galeraCluster = require('@voicenter-team/mysql-dynamic-cluster');
const cluster = galeraCluster.createPoolCluster(cfg);
```

`@opentelemetry/sdk-node` or the `--require @opentelemetry/auto-instrumentations-node/register`
flag work the same way, since both register the global provider.

The order does not matter. The library looks up the global provider on every
record and creates its instruments again when the provider changed, so an app
may register its SDK after the cluster already ran queries. Records made
before that are dropped. The pool connection metrics follow at the next
record, see [When they appear](#when-they-appear).

An app without OpenTelemetry does nothing. npm 7 and later install the peer
dependency on their own, and the calls stay no-ops. npm 6 and Yarn 1 do not
install peers: there the app must add `@opentelemetry/api` itself, or
requiring the library fails.

## Instrumentation scope

Instruments come from `getMeter('@voicenter-team/mysql-dynamic-cluster', <package version>)`.
The version is read from the package's own `package.json`.

## Metrics

There are six: three duration histograms, which the library records as
queries run, and three pool connection metrics, which the SDK reads from the
pools at each collection.

### Duration metrics

All three are histograms in seconds with the bucket boundaries the database
conventions recommend: `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`.
A histogram carries its own count, so there are no separate counters. Totals
and rates come from the count, errors from the `error.type` attribute.

| Metric | One record per | Recorded in |
|---|---|---|
| `mysql_dynamic_cluster.operation.duration` | Query attempt in one pool. A transaction (`multiStatementQuery`) is one record. Health checks count too, since they run through `Pool.query`. | [src/pool/Pool.ts](../../src/pool/Pool.ts) |
| `mysql_dynamic_cluster.query.duration` | `GaleraCluster.query` call, including the cache lookup and every retry. | [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts) |
| `mysql_dynamic_cluster.cache.lookup.duration` | Redis cache lookup on the normal query path. | [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts) |

All three names live in the package's own namespace. The per-attempt metric
has the shape of `db.client.operation.duration` from the
[database client semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-metrics/):
seconds, the same buckets and the same attribute keys. It does not take that
name on purpose. A wrapper or app that already records the convention metric
for the same calls would otherwise show two series under one name, and a
dashboard that sums by metric name would count MySQL time twice.

### Pool connection metrics

All three are observable up-down counters. Nothing records them. The SDK
calls the library at each collection, and the library reads every pool then.
There is no timer.

| Metric | Unit | Value |
|---|---|---|
| `mysql_dynamic_cluster.connection.count` | `{connection}` | Open connections of a node. Two points per node, one with `db.client.connection.state` = `idle` and one with `used`. |
| `mysql_dynamic_cluster.connection.pending_requests` | `{request}` | Requests that wait for a connection of a node. |
| `mysql_dynamic_cluster.connection.limit` | `{connection}` | `connectionLimit` of the node. No point for a node whose limit is `0`, which means no limit. |

The values are the ones `cluster.getPoolStats()` returns, read from the same
place, `Pool.stats()`. See [../node-api.md](../node-api.md#getpoolstats) for
what each count holds:

- `used` is every connection of the pool minus the idle ones. A connection
  that still logs in counts as used. So does a connection the app took with
  `cluster.getConnection()` and has not given back.
- `idle` is the open connections nobody uses.
- The sum of the two points is the number of connections the node has open.

A cluster's pools are reported from its `connect()` call until its
`disconnect()` call:

- `connect()` registers the pools before they connect. A pool that has no
  mysql2 pool yet reports `0` for `idle`, `used` and the waiting requests,
  and its limit. A node that failed to connect keeps reporting.
- A second `connect()` does not report a pool twice.
- After `disconnect()` the library reports no point for those pools and does
  not read them. `getPoolStats()` differs here. It keeps the counts of the
  closed pool.
- A `Pool` that no cluster connected is not reported.

What a reader does with a series that stopped is up to the SDK. With delta
temporality it exports no point. With cumulative temporality, the usual one
for up-down counters, `@opentelemetry/sdk-metrics` 2.12 keeps exporting the
last value of the series. A dashboard may then show the last counts of a
cluster that was disconnected while the app kept running.

The library leaves a pool it cannot read out of that collection and still
reports the others. It logs the first failure at `warn` and not the later
ones, as it does for the records.

The three have the shape of `db.client.connection.count`,
`db.client.connection.pending_requests` and `db.client.connection.limit`
from the same conventions: up-down counters with these units and attribute
keys. As with the durations, they keep the package's own names.

#### When they appear

The instruments belong to the provider that was the global one when they
were created. The library creates them when a cluster connects and, like
the histograms, creates them again on the first record after the provider
changed. It cannot see `setGlobalMeterProvider` itself, and it runs no timer
to look.

- An app that registers its SDK before `connect()` gets the metrics from the
  first collection.
- An app that registers its SDK later gets them from the next record of any
  metric. Every health check is a query through `Pool.query` and so a record.
  That makes it the next health check of any node at the latest, and no
  query of the app is needed. The time between two checks of a node is
  within `timerCheckRange`, 5 to 15 seconds by default.
- When the app replaces a provider, the same record takes the callback off
  the old one. From then on the pools are not read for it.

## Attributes

| Attribute | Value | On |
|---|---|---|
| `db.system.name` | `mysql` | operation, query |
| `db.namespace` | Database of the query. On the cluster metric only when the caller passed `database`. | operation, query |
| `db.operation.name` | First SQL keyword, see below | operation, query |
| `error.type` | mysql2 error `code` such as `ER_ACCESS_DENIED_ERROR` or `ECONNREFUSED`, or `_OTHER`. Set only on failure. | operation, query |
| `db.response.status_code` | mysql `errno` as a string, when the error has one | operation, query |
| `server.address`, `server.port` | Host and port of the pool | operation, connection |
| `db.client.connection.pool.name` | Pool `name` setting, `host:port` by default | operation, connection |
| `db.client.connection.state` | `idle` or `used` | connection count |
| `mysql_dynamic_cluster.cluster.name` | `clusterName` setting | all six |
| `mysql_dynamic_cluster.service.name` | `serviceName` of the query, or the `serviceId` as text. Left out for queries without a service. | operation, query |
| `mysql_dynamic_cluster.result.source` | `pool`, `cache` or `stale_cache`. Left out when the query failed. | query |
| `mysql_dynamic_cluster.cache.result` | `hit`, `expired` or `miss` | cache lookup |

In the last column, connection stands for the three pool connection metrics.
They carry the attributes named for them and no other.

Notes on cardinality and content:

- **SQL text is never recorded.** `db.operation.name` is the first keyword of
  the statement, and only when it is in a fixed list (`SELECT`, `INSERT`,
  `UPDATE`, `DELETE`, `REPLACE`, `CALL`, `SHOW`, `SET`, `CREATE`, `ALTER`,
  `DROP`, `TRUNCATE`, `USE`, `START`, `BEGIN`, `COMMIT`, `ROLLBACK`). It is
  left out for other keywords, for text with anything but whitespace after a
  `;` that stands outside quotes, and for transactions. The text is scanned
  once, with no regular expression.
- **The cluster metric's `error.type` is `_OTHER` for now.** The cluster wraps
  pool errors in a plain `Error` without a code. The per-attempt
  `mysql_dynamic_cluster.operation.duration` carries the real code.
- **`stale_cache` shows outages hidden by the cache.** Those queries succeed
  for the caller although no pool answered, either because no pool was valid
  or because every pool failed.
- **Two values come from the caller.** `mysql_dynamic_cluster.service.name`
  and `db.namespace` are whatever the query passes as `serviceName` (or
  `serviceId`) and `database`. Passing per-tenant or per-request values there
  grows the number of series with them.
- **A query that throws while its SQL is formatted or while Redis is read is
  not recorded.** A cached value that does not parse is recorded as a failed
  query.
- Recording is best effort: an error thrown by the registered SDK never fails
  a query. The first one is logged at `warn`, later ones are not.
- `db.client.connection.pool.name` and `db.client.connection.state` come from
  the connection pool part of the conventions, which is still marked
  Development.
- The pool connection metrics add series per node only: two for the count,
  one for the waiting requests and one for the limit.

## Migrating from the pm2 metrics

The pm2 metrics had the cluster, service and pool baked into each name, and a
write with a service was recorded twice. Those are attributes now.

| Old pm2 key | Now |
|---|---|
| `pool_all_queries`, `pool_query_per_minute` | count of `mysql_dynamic_cluster.operation.duration` |
| `pool_successful_queries` | same, where `error.type` is not set |
| `pool_error_queries` | same, where `error.type` is set |
| `pool_query_time`, `cluster_query_time` | `mysql_dynamic_cluster.operation.duration` |
| `cluster_all_queries`, `cluster_query_per_minute` | count of `mysql_dynamic_cluster.query.duration` |
| `cluster_successful_queries` | same, where `error.type` is not set |
| `cluster_error_queries` | same, where `error.type` is set |
| `redis_stale_served` | same, where `mysql_dynamic_cluster.result.source` is `stale_cache` |
| `redis_uses` | count of `mysql_dynamic_cluster.cache.lookup.duration` |
| `redis_expired` | same, where `mysql_dynamic_cluster.cache.result` is `expired` |
| `redis_latency` | `mysql_dynamic_cluster.cache.lookup.duration` |

Other changes:

- There are no aliases for the old names.
- `showMetricKeys` is removed. `createPoolCluster` rejects a settings object
  that still has it, see
  [Migrating from 3.x](../configuration.md#migrating-from-3x).
- `serviceMetrics` is unchanged. It names the table that maps a service name
  to an id, which cluster hashing needs for routing.
- Transactions get a duration, which the pm2 metrics did not record.

## Adding a new metric

1. Add the name and description to
   [src/metrics/MetricNames.ts](../../src/metrics/MetricNames.ts), and any
   new attribute key to `MetricAttributes`. Metric names go in the
   `mysql_dynamic_cluster.` namespace. Attribute keys use a convention key
   when one fits.
2. Create the instrument in `_getInstruments` in
   [src/metrics/Metrics.ts](../../src/metrics/Metrics.ts) and add a `record*`
   method. Never create an instrument at module load: it would be bound to
   the no-op provider.
3. Call the method from the call site. Keep attribute values to a small fixed
   set, never raw SQL, ids of rows or error messages.
4. Cover it in [tests/metrics/otel-metrics.test.ts](../../tests/metrics/otel-metrics.test.ts),
   which reads the metrics back through an in-memory exporter.

A metric whose value is read at collection, like the pool connection
metrics, takes other steps 2 to 4:

2. Create the observable instrument in `_movePoolInstruments` in
   [src/metrics/Metrics.ts](../../src/metrics/Metrics.ts) and add it to
   `_observables`, so the one batch callback covers it and leaves the old
   provider together with the others. Add no timer and no listener.
3. Observe it in `_observePools`, inside the per-pool `_safely`. Read the
   source there, at collection, and never keep a copy of the value.
4. Cover it in [tests/metrics/pool-metrics.test.ts](../../tests/metrics/pool-metrics.test.ts).
   A cumulative reader shows the values as they are. A delta reader shows
   that reporting stopped.

## See also

- [./pool.md](./pool.md) for the call sites of the per-attempt metric.
- [../node-api.md](../node-api.md#getpoolstats) for the counts behind the
  pool connection metrics.
- [./cluster.md](./cluster.md) for the call sites of the cluster metric.
- [./redis-cache.md](./redis-cache.md) for the cache lookup.
