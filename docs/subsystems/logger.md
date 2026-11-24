# Subsystem: Logger

The `Logger` singleton is the one place the library logs through. It writes
to the console, or to a logger the app passes to `createPoolCluster`. Since
4.2.0-rc.3 each cluster logs through a logger of its own, see
[One logger per cluster](#one-logger-per-cluster). The library owns no log
transport and has no logging dependency.

Before 4.0.0 the logger was built on winston with an optional AMQP transport
from `@voicenter-team/failover-amqp-pool`. Both are gone, see
[Migrating from the winston logger](#migrating-from-the-winston-logger).

Source:
[src/utils/Logger.ts](../../src/utils/Logger.ts),
[src/types/LoggerInterfaces.ts](../../src/types/LoggerInterfaces.ts).

## Settings

| key | type | default |
|---|---|---|
| `logs.level` | `'debug'`, `'info'`, `'warn'`, `'error'` or `'silent'` | `'info'` |
| `logger` | object with `debug`, `info`, `warn` and `error` methods | the console logger |

`LOGLEVEL` is exported from the package for the level values.

## Passing your own logger

Any object with the four methods works. Each is called as
`logger.<level>(message, meta?)`, where `meta` is a plain object and is left
out when the library has none.

```js
const winston = require('winston');
const galeraCluster = require('@voicenter-team/mysql-dynamic-cluster');

const logger = winston.createLogger({
    level: 'debug',
    transports: [new winston.transports.Console()]
});

const cluster = galeraCluster.createPoolCluster({
    clusterName: 'demo',
    logs: { level: 'debug' },
    logger,
    hosts: [/* ... */]
});
```

`console` itself is a valid logger: `logger: console`.

Rules:

- `logs.level` is applied before the call, to your logger too. To get the
  library's debug messages set `logs.level` to `'debug'`, whatever level your
  own logger has.
- `'silent'` stops every call.
- An exception thrown by your logger is swallowed, and so is a rejected
  promise it returns. A failing logger never fails a query.
- A `logger` that lacks one of the four methods makes `createPoolCluster`
  throw `Invalid logger`.
- The logger is used as passed. It is not copied, so a logger that keeps
  state on itself works.
- `message` is a string in most calls. A few error paths pass the `Error`
  object itself.

## Default console logger

Without a `logger`, each message is one entry on stdout:

```
[2026-11-15 13:20:41] [info] Pool is connected
[2026-11-15 13:20:41] [debug] formatSQL {"sql":"SELECT 1"}
```

The timestamp is local time. `meta` is appended as JSON when it has keys, or
as `String(meta)` when it cannot be turned into JSON. An `Error` is printed
with its stack, so that entry spans several lines.

## Initialisation

`createPoolCluster` takes `logger` off the settings object, then calls
`Logger.init(level, logger)` ([index.ts](../../index.ts)) on the module
logger, and gives the new cluster a logger of its own with the same level
and logger. Before that call, for example in a unit test that builds a
`Pool` directly, the logger is the console at level `info`.

## One logger per cluster

Since 4.2.0-rc.3 (#86) every cluster logs through the `logger` and the
`logs.level` of its own settings: the cluster, its pools, their health
checks, validators and load factors, the connections they take and give
back, the check connection, cluster hashing and the service names. A
second `createPoolCluster` leaves the logger and the level of the first
cluster as they are. With one cluster nothing changes: the same lines go
to the same logger. Calling `Logger.init` or `Metrics.init` directly
after `createPoolCluster` changes only the shared parts: a cluster that
exists keeps its logger, its level and its metrics cluster name.

The logger of a cluster is a view of the module logger, made by
`clusterContext` in [index.ts](../../index.ts): it has the methods of the
module logger, looked up at each call, and only the level and the logger
of the app are its own. A part built without a cluster, such as a `Pool`
a unit test makes directly, logs through the module logger.

The module logger is still one per process, with the level and the logger
of the last `createPoolCluster`. It logs what no cluster owns:

- `Initialized app`, and the lines of the Redis cache, which every
  cluster shares, see [redis-cache.md](./redis-cache.md).
- The warning that `createPoolCluster` was called again. It is logged
  before the module logger takes the new settings, so it goes to the
  logger of the call before.
- A listener of an event that threw after another one of the same event
  had thrown, see [../events.md](../events.md).
- The first metric that failed to record, see [metrics.md](./metrics.md).

## Migrating from the winston logger

| Before 4.0.0 | Now |
|---|---|
| `logs.output: 'console'` | Default, nothing to set |
| `logs.output: 'amqp'` plus the `amqp_logs` block | Build a winston logger with the AMQP transport in your app and pass it as `logger` |
| `LOGGER_LOG_OUTPUT` and the `LOG_AMQP_*` env vars | Removed |

To keep AMQP log shipping, install winston and
`@voicenter-team/failover-amqp-pool` in the app. Version 4 of that package no
longer depends on `@pm2/io`. Version 2, which this library used, loaded its
own `@pm2/io` copy, and that copy added process listeners for unhandled
rejections and exceptions.
