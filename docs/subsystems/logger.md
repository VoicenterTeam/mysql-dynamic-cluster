# Subsystem: Logger

The `Logger` singleton is a thin wrapper around
[winston](https://www.npmjs.com/package/winston) that ships log records
to one or more transports — a custom-formatted console transport for
local dev, and an **optional** AMQP transport (the
`WinstonAMQPPoolTransport` from
[`@voicenter-team/failover-amqp-pool`](https://www.npmjs.com/package/@voicenter-team/failover-amqp-pool))
for centralised log shipping. Every other subsystem in the library logs
through this one wrapper rather than constructing its own winston
instance, so the `logs.*` schema block is the single switchboard for
verbosity and destinations.

Source: [src/utils/Logger.ts](../../src/utils/Logger.ts),
[src/types/LoggerInterfaces.ts](../../src/types/LoggerInterfaces.ts).
See [../configuration.md](../configuration.md) for the `logs` and
`amqp_logs` schema keys, and
[../branch-divergence.md](../branch-divergence.md) for how this differs
from the `dev` branch — winston (and this wrapper shape) is **new in
V3**; the legacy line used a custom console logger plus
`@voicenter-team/amqp-logger`.

## Initialisation

[src/utils/Logger.ts:19-55](../../src/utils/Logger.ts#L19).

`Logger.init()` is called once at app start, from the root entry point
during `createPoolCluster` ([index.ts:21](../../index.ts#L21)) — before
any pool, metrics, or Redis wiring runs, so every other subsystem can
safely call `Logger.info`/`debug`/`error` from its constructor.

The method does three things:

1. **Reads `logs.level`**
   ([src/utils/Logger.ts:20](../../src/utils/Logger.ts#L20)). The
   schema validates this against the `LOGLEVEL` enum and defaults to
   `'info'`
   ([src/configs/schema.ts:200-205](../../src/configs/schema.ts#L200)).
2. **Reads and splits `logs.output`** on commas, trimming each entry
   ([src/utils/Logger.ts:21-23](../../src/utils/Logger.ts#L21)). The
   schema default is the string `'console'`
   ([src/configs/schema.ts:206-211](../../src/configs/schema.ts#L206)),
   so by default only the console transport is added. Setting
   `LOGGER_LOG_OUTPUT=console,amqp` activates both.
3. **Builds the winston logger** with a timestamp format
   (`'YYYY-MM-DD HH:mm:ss'`) and the resolved level
   ([src/utils/Logger.ts:25-31](../../src/utils/Logger.ts#L25)).
   `silent: logLevel === LOGLEVEL.SILENT` short-circuits all output —
   winston drops every record regardless of level — so a deployment can
   fully mute the library by setting `LOGGER_LOG_LEVEL=silent` without
   touching call sites.

Then it conditionally adds transports:

- If `output` includes `'console'`
  ([src/utils/Logger.ts:32-38](../../src/utils/Logger.ts#L32)), it adds
  `winston.transports.Console` configured with the custom `consoleFormat`
  printer (see below).
- If `output` includes `'amqp'`
  ([src/utils/Logger.ts:39-54](../../src/utils/Logger.ts#L39)), it
  assembles an `IDefaultAmqpConfig` object from the `amqp_logs.*` block
  and adds `WinstonAMQPPoolTransport` from the failover-amqp-pool
  package
  ([src/utils/Logger.ts:2](../../src/utils/Logger.ts#L2)).

Both checks use `Array.prototype.includes` against the split output, so
order is irrelevant and unknown tokens are silently ignored.

## Console format

[src/utils/Logger.ts:10-14](../../src/utils/Logger.ts#L10).

The console transport uses a `winston.format.printf` callback that
flattens every record into a single line:

```
[timestamp][req:requestID?] [level] message {extraJSON?}
```

- `timestamp` is injected by the top-level `winston.format.timestamp`
  combinator
  ([src/utils/Logger.ts:27-28](../../src/utils/Logger.ts#L27)).
- `requestID` is **opt-in** and only appears when callers pass it in
  the metadata object: e.g. `Logger.info('done', { requestID })`. When
  absent the bracketed segment is omitted entirely
  ([src/utils/Logger.ts:13](../../src/utils/Logger.ts#L13)).
- Any remaining keys on the metadata object (after `level`,
  `timestamp`, `requestID`, `message` are pulled out) are spread into
  `extra` and JSON-stringified at the end of the line. If there are no
  extra keys, the trailing `{...}` is suppressed.

The AMQP transport does **not** use this printer; it receives the raw
winston `info` object and is responsible for its own wire format.

## Levels

Two enums live in
[src/types/LoggerInterfaces.ts](../../src/types/LoggerInterfaces.ts):

- **`LOGLEVEL`**
  ([src/types/LoggerInterfaces.ts:3-9](../../src/types/LoggerInterfaces.ts#L3))
  — the values accepted for `logs.level`: `'info'`, `'error'`,
  `'debug'`, `'warn'`, `'silent'`. The schema constrains `logs.level`
  to exactly this set via `[...Object.values(LOGLEVEL)] as const`
  ([src/configs/schema.ts:202](../../src/configs/schema.ts#L202)).
- **`LOGTYPES`**
  ([src/types/LoggerInterfaces.ts:14-20](../../src/types/LoggerInterfaces.ts#L14))
  — the values valid as the `type` argument to `log()`: `'debug'`,
  `'info'`, `'error'`, `'verbose'`, `'warn'`. This set includes
  `verbose` (which is **not** a valid `LOGLEVEL`) and excludes
  `silent` (which would never make sense per record).

Implication: a caller can emit `Logger.verbose(...)` but cannot
configure `logs.level: 'verbose'`. Verbose records are still subject to
winston's per-level filtering, so they only surface when `logs.level`
is set to a level at or below `verbose` in winston's default
npm-levels order (`debug` or finer).

A third enum `OUTPUT`
([src/types/LoggerInterfaces.ts:10-13](../../src/types/LoggerInterfaces.ts#L10))
mirrors the two valid `logs.output` tokens (`'console'`, `'amqp'`) but
is not actually referenced by `Logger.ts` — the checks are plain string
literals.

## Convenience methods

[src/utils/Logger.ts:56-79](../../src/utils/Logger.ts#L56).

The class exposes one generic entry point plus five thin wrappers, all
of which delegate to `this.logger.log(type, message, meta)`:

| Method | `LOGTYPES` | Line |
|---|---|---|
| `log(type, message, meta?)` | caller-supplied | [src/utils/Logger.ts:56](../../src/utils/Logger.ts#L56) |
| `debug(message, meta?)` | `DEBUG` | [src/utils/Logger.ts:60](../../src/utils/Logger.ts#L60) |
| `info(message, meta?)` | `INFO` | [src/utils/Logger.ts:64](../../src/utils/Logger.ts#L64) |
| `error(message, meta?)` | `ERROR` | [src/utils/Logger.ts:68](../../src/utils/Logger.ts#L68) |
| `verbose(message, meta?)` | `VERBOSE` | [src/utils/Logger.ts:72](../../src/utils/Logger.ts#L72) |
| `warn(message, meta?)` | `WARN` | [src/utils/Logger.ts:76](../../src/utils/Logger.ts#L76) |

`meta` defaults to `{}` on every wrapper, so call sites can either drop
the second argument entirely (`Logger.info("connected")`) or pass a
structured object (`Logger.error(err.message, { host, port })`).
Whatever lands in `meta` is what the console formatter prints as the
trailing JSON blob and what the AMQP transport ships as the per-record
metadata.

## AMQP config block

When `logs.output` includes `amqp`, `Logger.init` assembles
`IDefaultAmqpConfig` inline from the flat `amqp_logs.*` schema block
and pushes exactly one pool entry
([src/utils/Logger.ts:40-53](../../src/utils/Logger.ts#L40)). The full
mapping:

| `amqp_logs.*` schema key | `IDefaultAmqpConfig` field | Source |
|---|---|---|
| `amqp_logs.topic` | `topic` (top-level) | [schema.ts:214-219](../../src/configs/schema.ts#L214), [Logger.ts:41](../../src/utils/Logger.ts#L41) |
| `amqp_logs.connection_master` | `pool[0].connection` | [schema.ts:220-263](../../src/configs/schema.ts#L220), [Logger.ts:45](../../src/utils/Logger.ts#L45) |
| `amqp_logs.exchage` | `pool[0].channel.exchange` | [schema.ts:264-277](../../src/configs/schema.ts#L264), [Logger.ts:47](../../src/utils/Logger.ts#L47) |
| `amqp_logs.queue` | `pool[0].channel.queue` | [schema.ts:278-285](../../src/configs/schema.ts#L278), [Logger.ts:48](../../src/utils/Logger.ts#L48) |
| `amqp_logs.bindings` | `pool[0].channel.binding` | [schema.ts:286-299](../../src/configs/schema.ts#L286), [Logger.ts:49](../../src/utils/Logger.ts#L49) |
| `amqp_logs.prefetch` | `pool[0].channel.prefetch` | [schema.ts:300-305](../../src/configs/schema.ts#L300), [Logger.ts:50](../../src/utils/Logger.ts#L50) |

Notable shape quirks worth flagging once when reading this code:

- The schema key is misspelt **`exchage`** (and so is the env var
  family `LOG_AMQP_EXCHANGE_*` — at least *those* read correctly).
  Both the schema and the Logger reader use the same typo, so the
  config round-trips fine, but the typo will look like a bug to
  first-time readers.
- The schema key is plural **`bindings`** but the transport expects
  singular `binding` — `Logger.ts:49` performs that rename inline.
- `pool` is an array but only ever holds **one** entry. The V3 wrapper
  does not expose the failover-amqp-pool's multi-connection model
  through this schema; if you need a secondary AMQP broker for log
  shipping, that would be a wrapper-level extension, not a config
  change.
- Every `amqp_logs.connection_master.*` leaf has a `LOG_AMQP_*_MASTER`
  env binding
  ([schema.ts:225-262](../../src/configs/schema.ts#L225)); see
  [../configuration.md](../configuration.md) for the full per-key
  table.

The constructed object is passed verbatim to `new winstonTransport(...)`
([src/utils/Logger.ts:53](../../src/utils/Logger.ts#L53)); the transport
opens the AMQP connection lazily on first publish.

## Singleton

[src/utils/Logger.ts:85](../../src/utils/Logger.ts#L85).

The module's default export is `new Logger()` — a pre-constructed
instance. Every consumer simply does `import Logger from
"../utils/Logger"` and uses it as a static-looking object; there is no
factory and no per-cluster instance.

Critically, the constructor does **not** run `init()`. `this.logger`
stays `undefined` until `Logger.init()` is called, so any call to
`Logger.info()` (or any wrapper) before that point throws a
`TypeError: Cannot read properties of undefined`. The library handles
this by calling `Logger.init()` first thing inside `init()` in the root
entry point ([index.ts:21](../../index.ts#L21)), which is invoked by
`createPoolCluster` ([index.ts:11-18](../../index.ts#L11)) before
`new GaleraCluster()` is constructed. As long as callers go through
`createPoolCluster`, this is invisible. Calling subsystem classes
directly (e.g. instantiating `GaleraCluster` in a test) requires
calling `Logger.init()` manually first.
