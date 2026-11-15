# Subsystem: Metrics

The `Metrics` singleton records query and cache timings through the
[OpenTelemetry API](https://opentelemetry.io/docs/languages/js/instrumentation/).
The package depends only on `@opentelemetry/api`, as a peer dependency. It
never starts an SDK or an exporter, and requiring it adds no process
listeners. Until the host app registers a `MeterProvider`, every call is a
no-op.

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
before that are dropped.

An app without OpenTelemetry does nothing. npm 7 and later install the peer
dependency on their own, and the calls stay no-ops. npm 6 and Yarn 1 do not
install peers: there the app must add `@opentelemetry/api` itself, or
requiring the library fails.

## Instrumentation scope

Instruments come from `getMeter('@voicenter-team/mysql-dynamic-cluster', <package version>)`.
The version is read from the package's own `package.json`.

## Metrics

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

## Attributes

| Attribute | Value | On |
|---|---|---|
| `db.system.name` | `mysql` | operation, query |
| `db.namespace` | Database of the query. On the cluster metric only when the caller passed `database`. | operation, query |
| `db.operation.name` | First SQL keyword, see below | operation, query |
| `error.type` | mysql2 error `code` such as `ER_ACCESS_DENIED_ERROR` or `ECONNREFUSED`, or `_OTHER`. Set only on failure. | operation, query |
| `db.response.status_code` | mysql `errno` as a string, when the error has one | operation, query |
| `server.address`, `server.port` | Host and port of the pool | operation |
| `db.client.connection.pool.name` | Pool `name` setting, `host:port` by default | operation |
| `mysql_dynamic_cluster.cluster.name` | `clusterName` setting | all three |
| `mysql_dynamic_cluster.service.name` | `serviceName` of the query, or the `serviceId` as text. Left out for queries without a service. | operation, query |
| `mysql_dynamic_cluster.result.source` | `pool`, `cache` or `stale_cache`. Left out when the query failed. | query |
| `mysql_dynamic_cluster.cache.result` | `hit`, `expired` or `miss` | cache lookup |

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
- `db.client.connection.pool.name` comes from the connection pool part of the
  conventions, which is still marked Development.

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
- `showMetricKeys` is still accepted so existing configs validate, but it is
  ignored and deprecated.
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

## See also

- [./pool.md](./pool.md) for the call sites of the per-attempt metric.
- [./cluster.md](./cluster.md) for the call sites of the cluster metric.
- [./redis-cache.md](./redis-cache.md) for the cache lookup.
