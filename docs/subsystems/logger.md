# Subsystem: Logger

The `Logger` singleton is the one place the library logs through. It writes
to the console, or to a logger the app passes to `createPoolCluster`. The
library owns no log transport and has no logging dependency.

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
`Logger.init(level, logger)` ([index.ts](../../index.ts)). Before that call,
for example in a unit test that builds a `Pool` directly, the logger is the
console at level `info`.

Like the other singletons there is one logger per process: a second
`createPoolCluster` replaces the logger and level of the first.

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
