# Configuration

`@voicenter-team/mysql-dynamic-cluster` builds its runtime configuration from a [convict](https://www.npmjs.com/package/convict) schema declared in [src/configs/schema.ts](../src/configs/schema.ts), with environment-variable overlay (via `dotenv`), optional JSON file overlays, and finally a deepmerge against the `userSettings` object you pass to `createPoolCluster`. This page documents every key in the schema, the merge precedence, the `redisInstant` seam, and validation behavior.

## Top-level keys

These keys live at the root of the config object. See [schema.ts:91-153](../src/configs/schema.ts#L91).

| key | type | default | env var |
|---|---|---|---|
| `showMetricKeys` | `boolean` | `false` | `MYSQL_SHOW_METRIC_KEYS` |
| `redisInstant` | `any` (`*`) | `false` | `MYSQL_REDIS_INSTANT` |
| `hosts` | `array` | `[]` | `MYSQL_HOSTS` |
| `useClusterHashing` | `boolean` | `true` | `MYSQL_USE_CLUSTER_HASHING` |
| `clusterName` | `string` | `'demo'` | `MYSQL_CLUSTER_NAME` |
| `errorRetryCount` | `number` | `2` | `MYSQL_RETRY_COUNT` |

`hosts` is an array of per-host pool overrides; each entry is deepmerged onto `defaultPoolSettings` at load time (see step 5 of the merge order).

## `defaultPoolSettings`

Base configuration applied to every host in `hosts`. See [schema.ts:11-90](../src/configs/schema.ts#L11).

| key | type | default | env var |
|---|---|---|---|
| `user` | `string` | `''` | `MYSQL_DEFAULT_USER` |
| `password` | `string` | `''` | `MYSQL_DEFAULT_PASSWORD` |
| `database` | `string` | `''` | `MYSQL_DEFAULT_DATABASE` |
| `port` | `number` | `3306` | `MYSQL_DEFAULT_PORT` |
| `connectionLimit` | `number` | `100` | `MYSQL_DEFAULT_CONNECTION_LIMIT` |
| `validators` | `array` | see below | _(none)_ |
| `loadFactors` | `array` | see below | _(none)_ |
| `timerCheckRange` | `object` | `{ start: 5000, end: 15000 }` | _(none)_ |
| `timerCheckMultiplier` | `number` | `1.3` | _(none)_ |
| `queryTimeout` | `number` | `120000` (`2 * 60 * 1000`) | `MYSQL_DEFAULT_QUERY_TIMEOUT` |
| `slowQueryTime` | `number` | `1` | `MYSQL_DEFAULT_QUERY_SLOW` |
| `redisFactor` | `number` | `1` | `MYSQL_DEFAULT_REDIS_FACTOR` |

Default `validators`:

```js
[
  { key: 'wsrep_ready',                operator: '=', value: 'ON' },
  { key: 'wsrep_local_state_comment',  operator: '=', value: 'Synced' },
  { key: 'Threads_running',            operator: '<', value: 50 }
]
```

Default `loadFactors`:

```js
[
  { key: 'Connections',                  multiplier: 2 },
  { key: 'wsrep_local_recv_queue_avg',   multiplier: 10 }
]
```

## `serviceMetrics`

Identifies the metrics table consulted by the cluster. See [schema.ts:97-110](../src/configs/schema.ts#L97).

| key | type | default | env var |
|---|---|---|---|
| `database` | `string` | `'swagger_realtime'` | `MYSQL_SERVICE_METRICS_DATABASE` |
| `table` | `string` | `'Service'` | `MYSQL_SERVICE_METRICS_TABLE` |

## `clusterHashing`

Cluster-hashing watchdog settings. See [schema.ts:111-124](../src/configs/schema.ts#L111).

| key | type | default | env var |
|---|---|---|---|
| `nextCheckTime` | `number` | `5000` | `MYSQL_CLUSTER_CHECK_TIME` |
| `dbName` | `string` | `'mysql_dynamic_cluster'` | `MYSQL_CLUSTER_DB_NAME` |

## `redis`

Redis cache configuration. See [schema.ts:155-198](../src/configs/schema.ts#L155).

| key | type | default | env var |
|---|---|---|---|
| `enabled` | `boolean` | `false` | `MYSQL_REDIS_ENABLE` |
| `keyPrefix` | `string` | `'mdc:'` | `MYSQL_REDIS_PREFIX` |
| `expire` | `number` | `1000000` | `MYSQL_REDIS_EXPIRE` |
| `expiryMode` | enum `'EX'` | `'EX'` | `MYSQL_REDIS_EXPIRE_MODE` |
| `algorithm` | enum `'md5' \| 'sha256'` | `'md5'` | `MYSQL_REDIS_ALGORITHM` |
| `encoding` | enum `'base64' \| 'hex'` | `'base64'` | `MYSQL_REDIS_ENCODING` |
| `clearOnStart` | `boolean` | `false` | `MYSQL_REDIS_CLEAR_ON_START` |

## `logs`

Logger output options. See [schema.ts:199-212](../src/configs/schema.ts#L199).

| key | type | default | env var |
|---|---|---|---|
| `level` | enum (`LOGLEVEL`) | `LOGLEVEL.INFO` | `LOGGER_LOG_LEVEL` |
| `output` | `string` | `'console'` | `LOGGER_LOG_OUTPUT` |

`output` accepts a comma-separated list (e.g. `console,file`).

## `amqp_logs`

AMQP transport for log shipping. See [schema.ts:213-306](../src/configs/schema.ts#L213).

Top-level fields:

| key | type | default | env var |
|---|---|---|---|
| `topic` | `string` | `'MYSQL_CLUSTER_LOGS'` | `LOG_AMQP_TOPIC` |
| `prefetch` | `number` | `0` | `LOG_AMQP_prefetch` |

### `amqp_logs.connection_master`

See [schema.ts:220-263](../src/configs/schema.ts#L220).

| key | type | default | env var |
|---|---|---|---|
| `host` | `string` | `''` | `LOG_AMQP_HOST_MASTER` |
| `port` | `number` | `5672` | `LOG_AMQP_PORT_MASTER` |
| `username` | `string` | `''` | `LOG_AMQP_USERNAME_MASTER` |
| `password` | `string` | `''` | `LOG_AMQP_PASSWORD_MASTER` |
| `vhost` | `string` | `'/'` | `LOG_AMQP_VHOST_MASTER` |
| `ssl` | `boolean` | `false` | `LOG_AMQP_SSL_MASTER` |
| `heartbeat` | `number` | `5` | `LOG_AMQP_HEARTBEAT_MASTER` |

### `amqp_logs.exchage`

Note: the schema key is spelled `exchage` (typo preserved as-is for compatibility). See [schema.ts:264-277](../src/configs/schema.ts#L264).

| key | type | default | env var |
|---|---|---|---|
| `name` | `string` | `'Logs'` | `LOG_AMQP_EXCHANGE_NAME` |
| `type` | enum (`ExchangeType`) | `ExchangeType.TOPIC` | `LOG_AMQP_EXCHANGE_TYPE` |

### `amqp_logs.queue`

See [schema.ts:278-285](../src/configs/schema.ts#L278).

| key | type | default | env var |
|---|---|---|---|
| `name` | `string` | `'MYSQL_CLUSTER_LOGS'` | `LOG_AMQP_QUEUE_NAME` |

### `amqp_logs.bindings`

See [schema.ts:286-299](../src/configs/schema.ts#L286).

| key | type | default | env var |
|---|---|---|---|
| `enabled` | `boolean` | `true` | `LOG_AMQP_BINDINGS_ENABLED` |
| `pattern` | `string` | `'mysql_logs'` | `LOG_AMQP_BINDINGS_PATTERN` |

## Settings merge order

The final config seen at runtime is the result of seven steps, in order:

1. **Schema defaults.** `convict(schema)` initialises every key with the default from [schema.ts](../src/configs/schema.ts) ([configs/index.ts:9](../src/configs/index.ts#L9)).
2. **Environment variables.** convict reads the `env:` field on each key and overlays any present `process.env.*` value over the default. `dotenv.config()` runs first so `.env` is picked up automatically.
3. **JSON config files.** If `MYSQL_CONFIG_FILES` is set (comma-separated paths), each file is loaded with `config.loadFile(...)` ([configs/index.ts:14-21](../src/configs/index.ts#L14)). These overlay env vars.
4. **`Settings.mixSettings(userSettings)`.** Deepmerges the `userSettings` argument over `config.get()` using `arrayMerge: overwriteMerge` (incoming arrays replace existing ones) and `isMergeableObject: isPlainObject` ([Settings.ts:17-23](../src/utils/Settings.ts#L17)).
5. **Per-host pool rebuild.** `userSettings.hosts` is rewritten: each host = `deepmerge(userSettings.defaultPoolSettings, host)` ([Settings.ts:25-27](../src/utils/Settings.ts#L25)). So a host that omits e.g. `port` inherits the default-pool value.
6. **Write-back into convict.** `config.load(userSettings).validate` is called ([index.ts:15](../index.ts#L15)). Note that `.validate` here is a **property reference, not a call** — no validation runs at this point. The merged object is still loaded back into the singleton.
7. **Runtime reads.** Consumers read via `config.get('foo.bar')` against the convict singleton — e.g. [GaleraCluster.ts:49-53](../src/cluster/GaleraCluster.ts#L49).

## The `redisInstant` seam

`redisInstant` is declared in the schema with `format: '*'` and `default: false` ([schema.ts:125-130](../src/configs/schema.ts#L125)), but it is not stored in convict at the end. In [index.ts:13-14](../index.ts#L13) `createPoolCluster` extracts it from `userSettings` and `delete`s it before the write-back:

```ts
let redisInstant = userSettings.redisInstant;
delete userSettings.redisInstant;
config.load(userSettings).validate;
init(redisInstant);
```

`init(redisInstant)` passes it to `Redis.init(...)` **only** when `redisInstant instanceof Cluster` or `redisInstant?.constructor?.name === 'Redis'` ([index.ts:24-26](../index.ts#L24)). Any other value (the default `false`, plain config booleans, etc.) is silently ignored. In practice this means: pass a live `ioredis` `Redis` or `Cluster` instance via `userSettings.redisInstant` if you want Redis caching to be initialised.

## Environment-variable prefix conventions

Three prefixes are consumed by the schema:

- `MYSQL_*` — every default-pool, top-level, service-metrics, cluster-hashing, hosts, and redis key.
- `LOGGER_*` — `logs.level` and `logs.output`.
- `LOG_AMQP_*` — every `amqp_logs.*` key. Note the lowercase `prefetch` env name: `LOG_AMQP_prefetch` ([schema.ts:304](../src/configs/schema.ts#L304)).

The `MYSQL_CONFIG_FILES` env var is special — it is read in [configs/index.ts:14](../src/configs/index.ts#L14) and is not a schema key.

`.env.example` ([.env.example](../.env.example)) lists `DB_HOST1`, `DB_HOST2`, `DB_HOST3`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, `REDIS_HOST`, `REDIS_PORT`. **These are not consumed by the library.** They are demo-only env vars read by `demo/index.js` to construct a `userSettings` object before calling `createPoolCluster`.

## Validation

Convict validation runs exactly once, at module load, in [configs/index.ts:23](../src/configs/index.ts#L23):

```ts
config.validate({ allowed: 'strict' });
```

With `allowed: 'strict'`, convict throws on any property in the loaded config that is not declared in the schema. Two implications:

- Adding a new option requires extending [schema.ts](../src/configs/schema.ts) — you cannot just pass an extra key through `userSettings` and read it back via `config.get`.
- The merge step in `createPoolCluster` ([index.ts:15](../index.ts#L15)) does **not** re-validate (the missing call parens on `.validate`). Unknown keys introduced via `userSettings` will be deepmerged into the singleton but never policed; they may or may not be silently ignored downstream.

If you need user-settings validation at runtime, replace `config.load(userSettings).validate` with `config.load(userSettings).validate({ allowed: 'strict' })`.
