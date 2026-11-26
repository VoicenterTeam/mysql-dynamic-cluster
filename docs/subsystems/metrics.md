# Subsystem: Metrics

The `Metrics` singleton records query, cache and health-check timings, and
reports the connection counts and the state of the nodes, through the
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
before that are dropped. The pool connection metrics and the node gauges
follow at the next record, see [When they appear](#when-they-appear).

An app without OpenTelemetry does nothing. npm 7 and later install the peer
dependency on their own, and the calls stay no-ops. npm 6 and Yarn 1 do not
install peers: there the app must add `@opentelemetry/api` itself, or
requiring the library fails.

## Instrumentation scope

Instruments come from `getMeter('@voicenter-team/mysql-dynamic-cluster', <package version>)`.
The version is read from the package's own `package.json`.

## Metrics

There are ten. The library records five duration histograms as queries and
health checks run. The SDK reads the other five from the pools at each
collection: three pool connection metrics and two node gauges.

### Duration metrics

All five are histograms in seconds with the bucket boundaries the database
conventions recommend: `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`.
A histogram carries its own count, so there are no separate counters. Totals
and rates come from the count, errors from the `error.type` attribute.

| Metric | One record per | Recorded in |
|---|---|---|
| `mysql_dynamic_cluster.operation.duration` | Query attempt in one pool. A transaction (`multiStatementQuery`) is one record. Health checks count too: the legacy check runs through `Pool.query`, and `Pool.checkQuery` records the attempt of a check on the check connection the same way. The ping of an idle pooled connection is no query attempt and no record. | [src/pool/Pool.ts](../../src/pool/Pool.ts) |
| `mysql_dynamic_cluster.connection.wait_time` | Query attempt of `Pool.query`: the time it waited for a connection, see [The step and the wait of an attempt](#the-step-and-the-wait-of-an-attempt). | [src/pool/Pool.ts](../../src/pool/Pool.ts) |
| `mysql_dynamic_cluster.query.duration` | `GaleraCluster.query` call, including the cache lookup and every retry. | [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts) |
| `mysql_dynamic_cluster.cache.lookup.duration` | Redis cache lookup on the normal query path. | [src/cluster/GaleraCluster.ts](../../src/cluster/GaleraCluster.ts) |
| `mysql_dynamic_cluster.health_check.duration` | Finished health check of one node, see [Health-check metric](#health-check-metric). | [src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts) |

All five names live in the package's own namespace. The per-attempt metric
has the shape of `db.client.operation.duration` from the
[database client semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-metrics/):
seconds, the same buckets and the same attribute keys. It does not take that
name on purpose. A wrapper or app that already records the convention metric
for the same calls would otherwise show two series under one name, and a
dashboard that sums by metric name would count MySQL time twice. The wait has
the shape of `db.client.connection.wait_time` from the same conventions, and
keeps the package's own name for the same reason.

### The step and the wait of an attempt

Since 4.1.0 (#122). Each attempt of `Pool.query` tells where it ended and
how long it waited for a connection. These are the values the `onTiming`
option of a query gets, per attempt, see
[cluster.md](./cluster.md#the-ontiming-option).

- `mysql_dynamic_cluster.attempt.step` on
  `mysql_dynamic_cluster.operation.duration` is the step the attempt ended
  in: `queue`, `probe`, `prepare` or `statement`. A failed attempt has
  it next to `error.type`, and a successful one has `statement`.
- `mysql_dynamic_cluster.connection.wait_time` has one record per attempt:
  the time in seconds it waited for a connection, in mysql2's queue or while
  a new connection opened. An attempt that got an idle connection at once
  records about `0`. It has the attributes that name the node, as the pool
  connection metrics do. It has no step, no `error.type` and no database.

Both cover every attempt of `Pool.query`: those of `query()` and
`execute()`, and the status query of the legacy health check. They do not
cover `Pool.checkQuery`, the check on the check connection of a node with a
`healthCheck` block, or `multiStatementQuery()`. Their operation records
have no step, and they record no wait. `getConnection()` records neither.

`recordOperation` records both, from the fields `step` and `waitSeconds`
of `IOperationMetricOptions`, see [Adding a new metric](#adding-a-new-metric).

### Health-check metric

`mysql_dynamic_cluster.health_check.duration` has one record per finished
health check of a node, made in `PoolStatus.checkStatus`. The duration is
the whole check as the status times it. For the legacy check it includes
the wait for a free connection. For a node with a `healthCheck` block it
includes opening the check connection, and a second attempt on a new
connection when the one the node held was lost. It ends at the timeout of
the check when the node does not answer. It is the value the status keeps as `queryTime`.

`mysql_dynamic_cluster.health_check.result` says how that one check ended:

| Result | Meaning |
|---|---|
| `valid` | The status query ran and the validators passed. |
| `invalid` | The status query ran and a validator said no. A status key the validator did not find counts as no. |
| `error` | The check failed. It got no answer, or the package failed after the answer came. |

A record with `error` also has `error.type`. It has
`db.response.status_code` when the error came from mysql2, the socket or the
server and its `errno` is a whole number above 0: the error number of the
server, as text. A socket `errno` such as `-111` is no answer of the server
and gives none (#106). Both follow the rule of
`checkError`, see
[health-and-scoring.md](./health-and-scoring.md#the-error-of-the-last-check).
`error.type` is the `code` of the error when mysql2, the socket or the server
made it, such as `ECONNREFUSED` or `ER_ACCESS_DENIED_ERROR`. It is `_OTHER`
for every failure the package made itself: the timeout of the check, a pool
with no mysql2 pool yet, the error an app passed to `failWaiting()`, and
anything thrown after the answer came. Those have no status code either.

The result is about one check and not about the node. A node stays valid
after one failed check, and the second failed check in a row takes it out.
`mysql_dynamic_cluster.node.valid` shows that state, see
[Node gauges](#node-gauges).

For a node with a `healthCheck` block the two differ in one more case. A
node that is down and passes a check records `valid` for that check, and
stays down until it passed `rise` checks in a row. Until then
`mysql_dynamic_cluster.node.valid` is `0` while the last record says
`valid`. See
[health-and-scoring.md](./health-and-scoring.md#the-rules-of-a-healthcheck-block).

Two kinds of check record nothing:

- A check that was still running when its pool was stopped, by
  `disconnect()` or `stopTimerCheck()`. The status drops its result too.
- A check that did not run because the status was not active.

The ping of an idle pooled connection of a node with a `healthCheck` block
is no health check. It records nothing, also when it fails, see
[pool.md](./pool.md#the-idle-connections-of-the-pool).

A health check shows in two metrics. Its status query is also one record
of `mysql_dynamic_cluster.operation.duration`, as it was before this metric
existed. There it has `db.operation.name` = `SHOW`. The legacy check runs
through `Pool.query`, which records it. The check of a node with a
`healthCheck` block asks on the check connection, and `Pool.checkQuery`
records that attempt with the same attributes.

- For the checks alone, read `mysql_dynamic_cluster.health_check.duration`.
- For the queries without the checks, leave `SHOW` out of
  `mysql_dynamic_cluster.operation.duration`. That also leaves out a `SHOW`
  statement the app sent to a pool itself.
- The two durations of one check differ. The operation times the query
  attempt. The health check times the whole check, and its record carries
  the result of the validators.
- The two can name one failed check differently. The operation record takes
  `error.type` and the status code from the error as it is. So an error the
  package made, or one the app passed to `failWaiting()`, shows its own code
  there, such as `POOL_NOT_CONNECTED`, and its `errno` when it has one. The
  health-check record has `_OTHER` and no status code for the same check.
- A check that hits its timeout is recorded as a health check at that
  moment. Its operation record is made when the query attempt itself ends.
  That is later, and never for an attempt that keeps waiting for a
  connection. A check of a node with a `healthCheck` block that hits its
  timeout drops its connection, so that attempt never ends and has no
  operation record.
- A check of a node with a `healthCheck` block that finds its connection
  lost asks again on a new one. That is one health check and two operation
  records, the first with the `error.type` of the loss.

A check that cannot be recorded still ends as it would have. The first
failure is logged at `warn`, as for the other records.

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
places. They are those of the mysql2 pool. The connection a node with a
`healthCheck` block keeps for its health checks is not in them: such a node
holds one connection of the server more than `idle` plus `used` shows, and
its checks are never among the pending requests. The counts come from `Pool.stats()` and the limit from the
`connectionLimit` of the pool. See
[../node-api.md](../node-api.md#getpoolstats) for what each count holds:

- `used` is every connection of the pool minus the idle ones. A connection
  that still logs in counts as used. So does a connection the app took with
  `cluster.getConnection()` and has not given back.
- `idle` is the open connections nobody uses. A connection whose ping is
  out counts as `idle`: the ping takes it out of no list, see
  [pool.md](./pool.md#the-idle-connections-of-the-pool).
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

### Node gauges

Two observable gauges, read at each collection from the status of every
registered pool. They are the `isValid` and `loadScore` that
`cluster.nodes()` returns.

| Metric | Value |
|---|---|
| `mysql_dynamic_cluster.node.valid` | `1` when the node is valid, so queries may go to it. `0` when not. |
| `mysql_dynamic_cluster.node.load_score` | Load score of the node from its last answered health check. Lower is better. |

- A node turns `0` when a validator says no, or with the second failed
  check in a row. It turns `1` again with the next check that passes. A node
  with a `healthCheck` block turns `0` at the `fall`th failed check in a row,
  or with one check the server refused the login of, and `1` again at the
  `rise`th pass in a row.
- A node that was never checked reports `0` and a load score of `100000`.
  That is the score a status starts with, and it puts an unchecked node
  last. Both points are reported as the status holds them, so a node that
  has not connected yet shows as not valid. Read the load score together
  with `mysql_dynamic_cluster.node.valid`.
- A failed check leaves the load score of the last answered check in place.
- Neither gauge has a unit. One is a state and the other a weighted sum of
  status values, set by `loadFactors`.

The gauges use the registry of the pool connection metrics. A cluster's
nodes are reported from its `connect()` call until its `disconnect()` call,
and the gauges reach a late provider as described under
[When they appear](#when-they-appear). After `disconnect()` a cumulative
reader keeps the last value of a gauge too.

The gauges and the connection metrics do not depend on each other. A node
whose status cannot be read still reports its connection metrics, and a
provider that cannot make one kind of instrument still gets the other and
the histograms.

### When they appear

This holds for the pool connection metrics and for the node gauges.

The instruments belong to the provider that was the global one when they
were created. The library creates them when a cluster connects and, like
the histograms, creates them again on the first record after the provider
changed. It cannot see `setGlobalMeterProvider` itself, and it runs no timer
to look.

- An app that registers its SDK before `connect()` gets the metrics from the
  first collection.
- An app that registers its SDK later gets them from the next record of any
  metric. Every health check is a query that is recorded, and so a record.
  That makes it the next health check of any node at the latest, and no
  query of the app is needed. The time between two checks of a node is
  within `timerCheckRange`, 5 to 15 seconds by default, or
  `healthCheck.interval` for a node with a `healthCheck` block. After a
  check the server refused the login of, such a node waits
  `healthCheck.authRetryInterval`, one minute with an empty block, until a
  check is answered.
- When the app replaces a provider, the same record takes the callback off
  the old one. From then on the pools are not read for it.

## Attributes

| Attribute | Value | On |
|---|---|---|
| `db.system.name` | `mysql` | operation, query, connection, wait, health check, node |
| `db.namespace` | Database of the query. On the cluster metric only when the caller passed `database`. Left out with `metrics.serverAttributes: false`. | operation, query |
| `db.operation.name` | First SQL keyword, see below | operation, query |
| `error.type` | mysql2 error `code` such as `ER_ACCESS_DENIED_ERROR` or `ECONNREFUSED`, or `_OTHER`. Set only on failure. Since 4.1.1 a `code` that throws when it is read counts as none on the operation and query metrics, and the point is still written. | operation, query, health check |
| `db.response.status_code` | `errno` of the error as a string, when it is a whole number above 0: the error number of the server. The negative `errno` of a socket, such as `-111`, gives none (#106). On the health check only for an error of mysql2, the socket or the server. Since 4.1.1 an `errno` that throws when it is read counts as none. | operation, query, health check |
| `server.address`, `server.port` | Host and port of the pool. Left out with `metrics.serverAttributes: false`. | operation, connection, wait, health check, node |
| `db.client.connection.pool.name` | Pool `name` setting, `host:port` by default. With `metrics.serverAttributes: false` the `id` of a host without a `name`. | operation, connection, wait, health check, node |
| `db.client.connection.state` | `idle` or `used` | connection count |
| `mysql_dynamic_cluster.cluster.name` | `clusterName` setting of the cluster that records, see [Two clusters in one process](#two-clusters-in-one-process) | all ten |
| `mysql_dynamic_cluster.attempt.step` | `queue`, `probe`, `prepare` or `statement`: where an attempt of `Pool.query` ended. Left out for the other attempts. | operation |
| `mysql_dynamic_cluster.health_check.result` | `valid`, `invalid` or `error` | health check |
| `mysql_dynamic_cluster.service.name` | `serviceName` of the query, or the `serviceId` as text. Left out for queries without a service. | operation, query |
| `mysql_dynamic_cluster.result.source` | `pool`, `cache` or `stale_cache`. Left out when the query failed. | query |
| `mysql_dynamic_cluster.cache.result` | `hit`, `expired` or `miss` | cache lookup |

In the last column, connection stands for the three pool connection metrics,
wait for `mysql_dynamic_cluster.connection.wait_time` and node for the two
node gauges. They carry the attributes named for them
and no other. They leave out `db.namespace`, since a connection of the pool
changes its database with every query. The health-check metric leaves it out
as well, since a check is about the node.

Notes on cardinality and content:

- **SQL text is never recorded.** `db.operation.name` is the first keyword of
  the statement, and only when it is in a fixed list (`SELECT`, `INSERT`,
  `UPDATE`, `DELETE`, `REPLACE`, `CALL`, `SHOW`, `SET`, `CREATE`, `ALTER`,
  `DROP`, `TRUNCATE`, `USE`, `START`, `BEGIN`, `COMMIT`, `ROLLBACK`). It is
  left out for other keywords, for text with anything but whitespace after a
  `;` that stands outside quotes, and for transactions. The text is scanned
  once, with no regular expression.
- **The cluster metric carries the code of the node tried last.** Since
  4.0.0 a failed `query()` rejects with the mysql2 error itself, so
  `error.type` is its code and `db.response.status_code` its errno, for
  an error the server answered with.
  `MDC_NO_NODE_AVAILABLE` when no node was valid, and
  `MDC_QUOTED_PLACEHOLDER` when a `:name` of the object stood inside
  quotes or backticks, and `MDC_UNSAFE_COMMENT_VALUE` when values
  could change how the server reads a comment it skips, such as `/*+ */`
  or `/*!NNNNN */`, before any node. `MDC_NODE_DOWN` when the node tried
  last went down while the call waited for one of its connections, since
  4.2.0. The per-attempt
  `mysql_dynamic_cluster.operation.duration` carries the code of each
  attempt.
- **`stale_cache` shows outages hidden by the cache.** Those queries succeed
  for the caller although no pool answered, either because no pool was valid
  or because the query failed on the nodes it tried.
- **Two values come from the caller.** `mysql_dynamic_cluster.service.name`
  and `db.namespace` are whatever the query passes as `serviceName` (or
  `serviceId`) and `database`. Passing per-tenant or per-request values there
  grows the number of series with them.
- **A query that throws while its SQL is formatted or while Redis is read is
  not recorded.** A cached value that does not parse is recorded as a failed
  query.
- Recording is best effort: an error thrown by the registered SDK never fails
  a query. The first one in the process is logged at `warn`, later ones are
  not, whichever cluster they come from. The line goes through the module
  logger, with the logger and level of the last `createPoolCluster`, see
  [../architecture.md](../architecture.md#singletons).
- `db.client.connection.pool.name` and `db.client.connection.state` come from
  the connection pool part of the conventions, which is still marked
  Development.
- **The step splits the operation metric.** The new attribute splits each
  existing `mysql_dynamic_cluster.operation.duration` series by step, into
  at most four. Sums over the other attributes are unchanged.
  `mysql_dynamic_cluster.connection.wait_time` adds one series per node.
- The pool connection metrics add series per node only: two for the count,
  one for the waiting requests and one for the limit.
- The node gauges add two series per node. The health-check metric adds,
  per node, one series for `valid`, one for `invalid`, and one for every
  distinct pair of `error.type` and status code among its failed checks.

### Keeping server attributes off a cluster

Since 4.2.1 (#160) `metrics: { serverAttributes: false }` in the settings of
a cluster removes `server.address`, `server.port` and `db.namespace` from
every point that cluster records or observes, and a host without `name`
reports `String(id)` as its pool name. See
[configuration](../configuration.md#metrics). It is for clusters made from
app data at run time. The pool computes its metric name once
(`Pool.metricName`) and hands it to each record;
`IPoolMetricSource.metricName` is optional, and the collection callbacks
fall back to `name`. The flag travels as `IClusterContext.serverAttributes`.
A pool carries it as `IPoolMetricSource.serverAttributes`, which the
collection callbacks read beside `metricName`. The cache lookup metric never
had these attributes.

With the flag `false` only the pool name and `clusterName` tell pools apart.
Give each such cluster its own `clusterName`, and give hosts distinct ids,
or names that are not ids: two unnamed hosts with one id, or a host named
`"1"` beside an unnamed host with id 1, share a series.

### Two clusters in one process

Since 4.2.0-rc.3 (#86) every point carries the `clusterName` of the cluster
that records it. The cluster passes its name with each record, from the
context `createPoolCluster` built for it, and so do its pools and their
health checks. `registerPools` keeps the name of the cluster of each pool,
for the connection metrics and the node gauges read at collection. So a
second `createPoolCluster` no longer relabels the metrics of the first.
With one cluster the points are the same as before. The same holds for
`serverAttributes`: a cluster with it `false` and one without share a
process, and only the points of the first lose the attributes, in either
order of creation. A cluster with the flag `false` is told apart by its pool
name and `clusterName` alone, so give it a `clusterName` no other cluster
has.

The instruments stay one set on the meter of the app's provider, for every
cluster. `Metrics.init(clusterName)` still runs at each `createPoolCluster`:
its name goes on a record that brings none, one of a part built without a
cluster, such as a `Pool` a unit test makes directly. It is read at each
record. Two pools whose attributes are all the same, name, address, port
and `clusterName`, report on one series: at each collection the point of
one overwrites the point of the other.

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
   the no-op provider. Create it after the first three histograms and inside
   its own `_safely`, as the health-check histogram is, so a provider that
   cannot make it still gets the others.
3. Call the method from the call site, with the `clusterName` of the context
   of the cluster, and add it to the attributes with `_addClusterName`, as
   the other records do. Leave `server.*` and `db.namespace` out when
   `serverAttributes` of the context is `false`. Keep attribute values to a
   small fixed set, never raw SQL, ids of rows or error messages. A value of
   the query path goes through `recordOperation` instead, as a new field of
   `IOperationMetricOptions`: about 20 test suites mock `Metrics` with a
   fixed set of methods, and a new method would be missing there.
4. Cover it in
   [tests/metrics/otel-metrics.test.ts](../../tests/metrics/otel-metrics.test.ts),
   which reads the metrics back through an in-memory exporter. Also see
   [tests/metrics/server-attributes.test.ts](../../tests/metrics/server-attributes.test.ts):
   it fails when an instrument of `MetricNames` makes no point, and when a
   point of a cluster with `serverAttributes` `false` has `server.*` or
   `db.namespace`.

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

A value read from the status of a node goes with the node gauges instead:
`_moveNodeInstruments` and `_observeNodes`, covered in
[tests/metrics/health-metrics.test.ts](../../tests/metrics/health-metrics.test.ts).
The two groups have a callback each, so one that fails leaves the other
reporting.

## See also

- [./pool.md](./pool.md) for the call sites of the per-attempt metric.
- [../node-api.md](../node-api.md#getpoolstats) for the counts behind the
  pool connection metrics.
- [./cluster.md](./cluster.md) for the call sites of the cluster metric.
- [./health-and-scoring.md](./health-and-scoring.md) for the health check
  behind the health-check metric and the node gauges.
- [./redis-cache.md](./redis-cache.md) for the cache lookup.
