# Subsystem: Metrics

The `Metrics` singleton publishes **real-time runtime numbers** to
`@pm2/io` so they can be inspected from pm2 dashboards (`pm2 monit`,
Keymetrics) without instrumenting the calling code beyond a single
method call. Every counter, rate, distribution, and gauge in the library
flows through this one wrapper.

Source:
[src/metrics/Metrics.ts](../../src/metrics/Metrics.ts),
[src/metrics/MetricNames.ts](../../src/metrics/MetricNames.ts),
[src/types/MetricsInterfaces.ts](../../src/types/MetricsInterfaces.ts).
See [../glossary.md](../glossary.md) for definitions of *counter*,
*meter*, *histogram*, and *metric (gauge)*.

## Metric types

The four supported primitives are enumerated in `MetricType`
([src/types/MetricsInterfaces.ts:11-16](../../src/types/MetricsInterfaces.ts#L11)):

| `MetricType` | pm2.io primitive | Library API | Use case |
|---|---|---|---|
| `METRIC` | gauge | `Metrics.set(metric, value, options?)` | Set a current value (snapshot) |
| `METER` | meter | `Metrics.mark(metric, options?)` | Mark an event for rate measurement |
| `COUNTER` | counter | `Metrics.inc` / `Metrics.dec` | Monotonic-ish integer increments/decrements |
| `HISTOGRAM` | histogram | `Metrics.update(metric, value, options?)` | Record a sample (mean is reported) |

The corresponding methods are defined at
[src/metrics/Metrics.ts:38](../../src/metrics/Metrics.ts#L38) (`set`),
[src/metrics/Metrics.ts:51](../../src/metrics/Metrics.ts#L51) (`inc`),
[src/metrics/Metrics.ts:64](../../src/metrics/Metrics.ts#L64) (`dec`),
[src/metrics/Metrics.ts:77](../../src/metrics/Metrics.ts#L77) (`mark`),
and
[src/metrics/Metrics.ts:85](../../src/metrics/Metrics.ts#L85) (`update`).
Each verifies the metric's declared `type` matches the call (`_isMetricTypeValid`,
[src/metrics/Metrics.ts:99-104](../../src/metrics/Metrics.ts#L99));
a mismatch logs an error and skips the write.

> Note: pm2.io calls its single-value primitive a *gauge*, but the
> library's enum names it `METRIC`. See
> [../glossary.md](../glossary.md#metric-gauge).

## Initialisation

[src/metrics/Metrics.ts:27-30](../../src/metrics/Metrics.ts#L27).

`Metrics.init(clusterName, showKeys)` is called once at cluster
construction. It stores:

- `clusterName` — used as the leading prefix in every metric's display
  name and internal key.
- `showKeys` — when `true`, the internal key is shown instead of the
  human-readable name in pm2 dashboards. Useful when keys must be
  matched programmatically.

No pm2 metrics are registered at init time; registration is lazy (see
[Repository](#repository-lazy-registry) below).

## Naming

`_generatePrefixes`
([src/metrics/Metrics.ts:113-131](../../src/metrics/Metrics.ts#L113))
builds two parallel strings for each write:

- **Display name** (shown in pm2 dashboards):
  ```
  [clusterName] [serviceName?] [poolName?] <metric.name>
  ```
- **Internal key** (used as the registry key and as a fallback display
  name when `showKeys` is on):
  ```
  ${clusterName}_${serviceId?}_${poolId?}_${metric.key}
  ```

The service segment is only included when `useService` is true (i.e.
when building the service-scoped variant — see
[Two-write rule](#two-write-rule)). The pool segment is included
whenever `options.pool` is set.

If `metric.name` is missing or `showMetricKeys` is true, the display
name collapses to the internal key
([src/metrics/Metrics.ts:128](../../src/metrics/Metrics.ts#L128)).

## Two-write rule

`_getMetricValues`
([src/metrics/Metrics.ts:139-156](../../src/metrics/Metrics.ts#L139))
implements a deliberate fan-out:

- If `options.service` is supplied, the metric is written to **two**
  pm2 metrics:
  1. A **service-scoped** variant whose key includes
     `options.service.id` and whose display name includes
     `options.service.name`.
  2. The **global** variant (no service segment).
- If no `service` is supplied, only the global variant is written.

This lets pm2 dashboards drill in by service while preserving the
overall numbers. The pool segment, when present, appears in **both**
variants — service-scoped writes also include the pool, so a service
that pins to a single pool gets a single per-pool counter plus the
global counter.

`IMetricOptions`
([src/types/MetricsInterfaces.ts:32-41](../../src/types/MetricsInterfaces.ts#L32))
carries both segments:

```ts
interface IMetricOptions {
    pool?:    { id: number, name: string },
    service?: { id: number, name: string }
}
```

## Repository (lazy registry)

`metricsRepository` is an in-memory map
([src/types/MetricsInterfaces.ts:28-30](../../src/types/MetricsInterfaces.ts#L28))
keyed by the fully-qualified internal key. `_getMetricValues` checks
the map on every call; if the key is missing, `_createMetric`
([src/metrics/Metrics.ts:163-192](../../src/metrics/Metrics.ts#L163))
constructs the matching pm2.io primitive on demand:

- `MetricType.METRIC`     -> `pm2io.metric({ name })`
- `MetricType.COUNTER`    -> `pm2io.counter({ name })`
- `MetricType.METER`      -> `pm2io.meter({ name })`
- `MetricType.HISTOGRAM`  -> `pm2io.histogram({ name, measurement: MetricMeasurements.mean })`

Histograms always report the **mean** (see
[src/metrics/Metrics.ts:186](../../src/metrics/Metrics.ts#L186)).

Because creation is lazy, a metric never appears in pm2 until it is
actually written at least once. This keeps dashboards tidy when, for
example, Redis is disabled (the `redis.*` metrics simply never
materialise).

## Available metric names

The full registry lives in
[src/metrics/MetricNames.ts](../../src/metrics/MetricNames.ts) and is
organised into three groups: `cluster`, `pool`, `redis`.

| Group | Property | Key | Type | Source |
|---|---|---|---|---|
| `cluster` | `allQueries`        | `cluster_all_queries`        | `COUNTER`   | [MetricNames.ts:25-29](../../src/metrics/MetricNames.ts#L25) |
| `cluster` | `successfulQueries` | `cluster_successful_queries` | `COUNTER`   | [MetricNames.ts:30-34](../../src/metrics/MetricNames.ts#L30) |
| `cluster` | `errorQueries`      | `cluster_error_queries`      | `COUNTER`   | [MetricNames.ts:35-39](../../src/metrics/MetricNames.ts#L35) |
| `cluster` | `queryTime`         | `cluster_query_time`         | `HISTOGRAM` | [MetricNames.ts:40-44](../../src/metrics/MetricNames.ts#L40) |
| `cluster` | `queryPerMinute`    | `cluster_query_per_minute`   | `METER`     | [MetricNames.ts:45-49](../../src/metrics/MetricNames.ts#L45) |
| `pool`    | `allQueries`        | `pool_all_queries`           | `COUNTER`   | [MetricNames.ts:52-56](../../src/metrics/MetricNames.ts#L52) |
| `pool`    | `successfulQueries` | `pool_successful_queries`    | `COUNTER`   | [MetricNames.ts:57-61](../../src/metrics/MetricNames.ts#L57) |
| `pool`    | `errorQueries`      | `pool_error_queries`         | `COUNTER`   | [MetricNames.ts:62-66](../../src/metrics/MetricNames.ts#L62) |
| `pool`    | `queryTime`         | `pool_query_time`            | `HISTOGRAM` | [MetricNames.ts:67-71](../../src/metrics/MetricNames.ts#L67) |
| `pool`    | `queryPerMinute`    | `pool_query_per_minute`      | `METER`     | [MetricNames.ts:72-76](../../src/metrics/MetricNames.ts#L72) |
| `redis`   | `uses`              | `redis_uses`                 | `COUNTER`   | [MetricNames.ts:79-83](../../src/metrics/MetricNames.ts#L79) |
| `redis`   | `expired`           | `redis_expired`              | `COUNTER`   | [MetricNames.ts:84-88](../../src/metrics/MetricNames.ts#L84) |
| `redis`   | `latency`           | `redis_latency`              | `HISTOGRAM` | [MetricNames.ts:89-93](../../src/metrics/MetricNames.ts#L89) |

Display names (the human-readable strings shown in pm2 dashboards) are
the values' `name` fields (e.g. `'Cluster all queries'`) prefixed as
described in [Naming](#naming).

## Adding a new metric

Three steps.

**1. Declare the metric.** Add an entry under the appropriate group in
[src/metrics/MetricNames.ts](../../src/metrics/MetricNames.ts) with
`key`, `name`, and `type` (one of `MetricType.COUNTER`, `.METER`,
`.HISTOGRAM`, `.METRIC`):

```ts
// inside MetricNames.cluster
mySample: {
    key: 'cluster_my_sample',
    name: 'Cluster my sample',
    type: MetricType.HISTOGRAM
}
```

The `key` becomes part of the internal map key (and the dashboard label
when `showMetricKeys` is on); the `name` is the human-readable label.

**2. Write to it from the call site.** Pick the method matching the
type:

| Type | Method |
|---|---|
| `COUNTER` | `Metrics.inc(metric)` / `Metrics.dec(metric)` |
| `METER` | `Metrics.mark(metric)` |
| `HISTOGRAM` | `Metrics.update(metric, value)` |
| `METRIC` | `Metrics.set(metric, value)` |

The method validates the metric's declared type
([src/metrics/Metrics.ts:99-104](../../src/metrics/Metrics.ts#L99)) and
logs an error if it does not match.

**3. (Optional) Pass `IMetricOptions` for scoped variants.** Supply
`pool` to get a per-pool variant, `service` to fan out into a global +
service-scoped pair (see [Two-write rule](#two-write-rule)):

```ts
Metrics.update(MetricNames.cluster.queryTime, durationMs, {
    pool:    { id: pool.id, name: pool.name },
    service: { id: service.id, name: service.name }
});
```

No extra registration step is needed — the new pm2.io primitive is
created lazily the first time the key is written.

## See also

- [../glossary.md](../glossary.md) — definitions of counter, meter,
  histogram, and gauge.
- [./pool.md](./pool.md) — call sites for the `pool.*` metrics.
- [./cluster.md](./cluster.md) — call sites for the `cluster.*`
  metrics.
- [./redis-cache.md](./redis-cache.md) — call sites for the `redis.*`
  metrics.
