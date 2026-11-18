# Configuration

`@voicenter-team/mysql-dynamic-cluster` takes its settings from one place: the object you pass to `createPoolCluster`. A [zod](https://zod.dev/) schema in [src/configs/schema.ts](../src/configs/schema.ts) validates that object and fills in the defaults. The library reads no environment variable, no `.env` file and no config file.

Before 4.0.0 the schema was convict, with an environment overlay. See [Migrating from 3.x](#migrating-from-3x).

## Top-level keys

| key | type | default |
|---|---|---|
| `clusterName` | `string` | `'demo'` |
| `hosts` | array of [hosts](#hosts) | `[]` |
| `defaultPoolSettings` | object | see [below](#defaultpoolsettings) |
| `errorRetryCount` | `number` | `2` |
| `escapeNamedValues` | `boolean` | `false`, see [below](#escapenamedvalues) |
| `useClusterHashing` | `boolean` | `true` |
| `clusterHashing` | object | see [below](#clusterhashing) |
| `serviceMetrics` | object | see [below](#servicemetrics) |
| `redis` | object | see [below](#redis) |
| `logs` | object | see [below](#logs) |
| `redisInstant` | `ioredis` `Redis` or `Cluster` instance | none |
| `logger` | object with `debug`, `info`, `warn`, `error` | console logger |

`redisInstant` and `logger` are live objects, not settings. `createPoolCluster` takes them off the object before validation, see [Live objects](#live-objects-redisinstant-and-logger).

## `defaultPoolSettings`

Base configuration applied to every host in `hosts`.

| key | type | default |
|---|---|---|
| `user` | `string` | `''` |
| `password` | `string` | `''` |
| `database` | `string` | `''` |
| `port` | `number` | `3306` |
| `connectionLimit` | `number` | `10` |
| `minConnections` | `number` | `1` |
| `idleTimeout` | `number` (ms) | `30000` |
| `idleCheckInterval` | `number` (ms) | `10000` |
| `validators` | array | see below |
| `loadFactors` | array | see below |
| `timerCheckRange` | `{ start, end }` (ms), either half may be left out | `{ start: 5000, end: 15000 }` |
| `timerCheckMultiplier` | `number` | `1.3` |
| `queryTimeout` | `number` (ms) | `120000` |
| `slowQueryTime` | `number` (s) | `1` |
| `redisFactor` | `number` | `1` |
| `flags` | `string` or `string[]` | not set: picked per node, see [below](#flags) |

Default `validators`:

```js
[
  { key: 'wsrep_ready',                operator: '=', value: 'ON' },
  { key: 'wsrep_local_state_comment',  operator: '=', value: 'Synced' },
  { key: 'Threads_running',            operator: '<', value: 50 }
]
```

A validator is `{ key: string, operator: '>' | '<' | '=' | 'Like', value: string | number }`.

Default `loadFactors`:

```js
[
  { key: 'Connections',                  multiplier: 2 },
  { key: 'wsrep_local_recv_queue_avg',   multiplier: 10 }
]
```

A load factor is `{ key: string, multiplier: number }`.

### `flags`

Added in 4.1.0. The `flags` connection option of mysql2, passed to `mysql.createPool` as they are. A name adds a flag, a name with a leading `-` turns a default one off. mysql2 takes an array or one comma-separated string. Left out, the library picks them per node, see below.

Nobody checks the names. mysql2 ignores a name it does not know, without an error, and matches array entries exactly: upper case, no spaces. An array entry such as `'-client_query_attributes'` changes nothing, and neither does a misspelt name. mysql2 upper-cases only the string form. Leave `MULTI_STATEMENTS` off: it lets one query carry several statements, which makes SQL injection worse.

The case it exists for: mysql2 3.21.0 and later turn on `CLIENT_QUERY_ATTRIBUTES` without looking at the server version. A server that announces the capability but is older than 8.0.26, such as Percona XtraDB Cluster 8.0.25, does not parse the prepared-statement packet that comes with it, so every `connection.execute()` hangs. The library's own queries are plain `query()` calls and are not affected, but code that runs `execute()` on the library's pools is.

#### Picked per node when `flags` is left out

Added in 4.2.0. A pool without `flags` asks its server first. Before it creates the mysql2 pool it logs in once, reads the version and the capabilities from the server's greeting, and logs out. Then:

| the server | flags of the pool |
|---|---|
| announces query attributes and reports a version below 8.0.26 | `['-CLIENT_QUERY_ATTRIBUTES']` |
| announces them and reports 8.0.26 or later | mysql2's defaults |
| does not announce them, or is MariaDB | mysql2's defaults |
| announces them with a version that does not start with three numbers | `['-CLIENT_QUERY_ATTRIBUTES']` |
| could not be reached, or refused the login | `['-CLIENT_QUERY_ATTRIBUTES']`, and the pool is created anyway |

Every host entry decides for itself, so a cluster with mixed versions works as long as one host entry reaches one server. An entry that points at a balancer in front of servers of different versions gets the answer of whichever server took the login: set `flags` yourself there. The decision is made once per `connect()`. A node upgraded while the app runs, or one that was down at start, keeps the flag off until the app restarts, which costs nothing but query attributes.

What to know:

- It costs one extra login per node at start. A node that does not answer is waited for twice: once by this login, once by the pool's own first check. mysql2 gives up after its `connectTimeout`, 10 seconds by default. A wrong password is refused twice per node for the same reason, which counts double where the server locks an account after failed logins.
- Until that login has answered, the pool has no connections. A query that reaches it then is rejected with the code `POOL_NOT_CONNECTED`. The cluster tries the next node, as for any failed query.
- The rule trusts the version the server reports. A proxy that reports another version than the server behind it can get the wrong answer. Set `flags` yourself for such a node.
- `flags` in the settings always wins, also `flags: []` and `flags: ''`: no extra login, and the value goes to mysql2 as it is. To get mysql2's defaults on every node whatever the server says, set `flags: []` in `defaultPoolSettings`.
- The decision is logged once per pool, with `pool`, `serverVersion`, `reason` and `flags` as meta: at `info` when the flag is turned off for an old server, at `debug` when nothing changes, at `warn` when the version was not readable or the login failed. A failed login adds `error` to the meta: the error code, the error number when mysql2 gives no code, or `unknown`. The error message is not in this line and no line carries the password. The pool's own first check fails on the same node right after and logs its error as before.

Setting it by hand still works and skips the extra login:

```js
defaultPoolSettings: {
    flags: ['-CLIENT_QUERY_ATTRIBUTES']
}
```

`flags` on a host replaces the default ones for that node, it is not added to them: `flags: []` on a host on a newer server gives that node mysql2's defaults again. This differs from `validators` and `loadFactors`, which are added.

## `escapeNamedValues`

Added in 4.3.0. It decides what `cluster.query(sql, values)` does with an object of values.

```js
await cluster.query('SELECT * FROM users WHERE email = :email', { email });
```

| `escapeNamedValues` | SQL sent for `email = "o'neil@example.com"` |
|---|---|
| `true` | `... WHERE email = 'o\'neil@example.com'` |
| `false` (default) | `... WHERE email = o'neil@example.com` |

**On.** Each named value goes through mysql2's `escape`. A string arrives quoted and escaped, a number as a number, `null` and `undefined` as `NULL`, an array as a comma-separated list, a `Date` as a quoted date. A plain object arrives as the string `'[object Object]'`, never as SQL. To send SQL through a value on purpose, wrap it: `require('mysql2').raw('NOW()')`. Any object with a `toSqlString` function is sent as SQL the same way. JSON cannot carry a function, so a parsed request body cannot hold one.

**Escaping protects a placeholder that stands where a value stands, and nowhere else.** A placeholder inside quotes, backticks or a `/* */` comment stays open to injection with the setting on: for `name = ':n'` the value ` OR 1=1 -- ` gives `name = '' OR 1=1 -- ''`. See [Turning it on in an existing service](#turning-it-on-in-an-existing-service).

**Check the type of a value that comes from a request.** An array becomes a list, so `LIMIT :n` with `[0, 100000]` gives `LIMIT 0, 100000`, a nested array gives `(1, 2), (3, 4)`, and an empty array gives `IN ()`. Where the SQL expects one number or one string, make sure the value is one.

**Off.** Each `:name` is replaced by the value as text, as in every version before. Nothing is quoted or escaped. A value that comes from a user can then change the statement, which is SQL injection, unless the caller escapes or validates it first. The first value of a cluster that goes in this way logs one `warn` line that names this setting. The line holds neither the SQL nor the values.

The default is off because turning it on changes the SQL of existing callers. It becomes on in the next major version. Turn it on now in new code.

Array and string values are escaped in both modes. Only the object form depends on the setting.

### Per query

`escapeNamedValues` is also a query option, and the option wins over the setting. An option of `undefined` or `null` counts as not passed. A service can move one query at a time:

```js
await cluster.query(sql, { email }, { escapeNamedValues: true });
```

### Turning it on in an existing service

- **Remove the quotes around placeholders.** `name = ':name'` becomes `name = :name`. This step is not optional. With the quotes left in, the value's own quotes close the literal early, and a value written for it changes the statement without a single quote character in it. The same holds for a placeholder inside backticks or a block comment.
- **Move SQL fragments out of the values.** A value such as `NOW()`, a column name or `ASC` is sent as a quoted string once the setting is on. Write those into the SQL text, from a fixed list the code owns, or wrap them in mysql2's `raw()`.
- **`LIKE` patterns.** Put the wildcards in the value: `name LIKE :pattern` with `{ pattern: '%' + text + '%' }`, not `'%:text%'`, which is a placeholder inside quotes.
- **A `:name` inside a string literal is still replaced** when the object has that key, now with quotes, which breaks out of the literal as above. Rename the key or the text.
- **Redis cache keys change.** The formatted SQL is the cache key, so each query misses the cache once after the switch.

The escaping is mysql2's. It assumes the server does not run with `NO_BACKSLASH_ESCAPES` in its `sql_mode`, the same as for array values.

## `hosts`

One entry per Galera node. `host` is required. Every key of `defaultPoolSettings` may be repeated here to override it for that node.

| key | type | notes |
|---|---|---|
| `host` | `string` | required, not empty |
| `id` | `number` | assigned by the cluster when left out or `0`. A `0` stays `0` only on the first host without an id of its own, and only when no host has another id. When it is replaced, the cluster logs a `warn` with the host, the port and the id the node got |
| `name` | `string` | `host:port` when left out |
| `redisExpire` | `number` (s) | cache TTL for queries served by this node |
| any `defaultPoolSettings` key | as above | overrides the default for this node |

## `serviceMetrics`

Identifies the table that maps a service name to its id. The id drives cluster hashing; the name is a metric attribute.

| key | type | default |
|---|---|---|
| `database` | `string` | `'swagger_realtime'` |
| `table` | `string` | `'Service'` |

## `clusterHashing`

Cluster-hashing watchdog settings.

| key | type | default |
|---|---|---|
| `nextCheckTime` | `number` (ms) | `5000` |
| `dbName` | `string` | `'mysql_dynamic_cluster'` |

## `redis`

Redis cache configuration. The cache also needs a live client in `redisInstant`.

| key | type | default |
|---|---|---|
| `enabled` | `boolean` | `false` |
| `keyPrefix` | `string` | `'mdc:'` |
| `expire` | `number` (s) | `1000000` |
| `expiryMode` | `'EX'` | `'EX'` |
| `algorithm` | `'md5'` or `'sha256'` | `'md5'` |
| `encoding` | `'base64'` or `'hex'` | `'base64'` |
| `clearOnStart` | `boolean` | `false` |

## `logs`

| key | type | default |
|---|---|---|
| `level` | `'debug'`, `'info'`, `'warn'`, `'error'` or `'silent'` | `'info'` |

The values are lowercase. `LOGLEVEL` is exported from the package for them. Where the log lines go is decided by the `logger` object, see [subsystems/logger.md](subsystems/logger.md).

## How settings are built

`createPoolCluster(userSettings)` does this, in order ([index.ts](../index.ts), [src/utils/Settings.ts](../src/utils/Settings.ts)):

1. **Take the live objects off.** `redisInstant` and `logger` are removed from a copy of the object. The caller's object is not changed.
2. **Validate and fill defaults.** `parseSettings` runs the zod schema. Keys you left out get their default, also inside nested objects: `redis: { enabled: true }` keeps every other `redis` default. An array you pass replaces the default array.
3. **Mix every host with the default pool settings.** Each host becomes the default pool settings with its own keys on top, merged in `Settings._mix`. A host that omits `port`, or sets it to `undefined`, inherits it. Arrays are concatenated in this step: `validators` on a host are added to the default ones, not swapped for them. `flags` is the exception, a host's value replaces the default one.
4. **Store.** The result is loaded into the `config` singleton ([src/configs/index.ts](../src/configs/index.ts)). The rest of the library reads `config.current`, a plain typed object.

Before `createPoolCluster` runs, `config.current` holds the defaults. A second `createPoolCluster` call in one process replaces the settings of the first and logs a warning to the first cluster's logger.

## Validation

Validation runs on every `createPoolCluster` call and is strict:

- Anything but a plain settings object is an error, including an array and a call with no argument.
- A key the schema does not know is an error, at any depth. A typo such as `defualtPoolSettings` no longer passes silently.
- A value of the wrong type is an error. `port: '3306'` is rejected, strings are not converted to numbers. That includes values read from `process.env`, which are always strings: wrap them in `Number(...)`. `null`, `NaN` and `Infinity` are rejected for a number too.
- An enum value outside its list is an error, such as `logs.level: 'DEBUG'` or `redis.algorithm: 'sha1'`.

All problems are reported in one `Error`, each with its path:

```
Invalid mysql-dynamic-cluster settings:
✖ Unrecognized key: "bogusKey"
✖ Invalid input: expected number, received string
  → at errorRetryCount
```

The message names keys and types. It does not print the values you passed, so a password does not end up in a log.

Adding an option means adding it to the schema in [src/configs/schema.ts](../src/configs/schema.ts) and to the matching interface in [src/types/](../src/types/). The hand-written `I*` interfaces are the public types. They are kept apart from the schema on purpose, so the shipped declarations never import zod and still compile for apps on an older TypeScript. `parseSettings` assigns the schema output to `IParsedSettings`. That fails the build when the interface has a required key the schema lacks, or types a key differently. It does not notice an optional key the schema lacks, nor a key that only the schema has, so add new keys to both.

## Live objects: `redisInstant` and `logger`

- `redisInstant` is passed to `Redis.init(...)` only when it is an `ioredis` `Cluster`, or an object whose constructor is named `Redis`. Anything else is ignored. Pass a live client here if you want the Redis cache.
- `logger` is passed to `Logger.init(...)`. See [subsystems/logger.md](subsystems/logger.md).

Neither is validated by the schema.

## Environment variables

The library reads none. `.env.example` lists `DB_HOST1`, `DB_HOST2`, `DB_HOST3`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, `REDIS_HOST` and `REDIS_PORT`. Those are read by `demo/index.js` and the integration tests, which call `dotenv` themselves to build a settings object.

To configure from the environment, read the variables in your app and pass the values:

```js
const cluster = galeraCluster.createPoolCluster({
    clusterName: process.env.MYSQL_CLUSTER_NAME,
    hosts: process.env.MYSQL_HOSTS.split(',').map(host => ({ host })),
    defaultPoolSettings: {
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        port: Number(process.env.MYSQL_PORT || 3306)
    }
});
```

## Migrating from 3.x

| 3.x | 4.0.0 |
|---|---|
| `.env` in the app's working directory was loaded by the library | Not loaded. Call `dotenv` in the app if you want it |
| `MYSQL_*`, `LOGGER_*` and `LOG_AMQP_*` variables changed settings | Ignored. Pass the values in the settings object |
| `MYSQL_CONFIG_FILES` loaded JSON overrides | Removed. Load the file in the app and pass its content |
| Unknown keys and wrong types passed silently | `createPoolCluster` throws and names each one |
| `showMetricKeys` | Removed, was a pm2 display option |
| `logs.output` and the `amqp_logs` block | Removed, pass a `logger` |
| `redisSettings` in the TypeScript interface | The key is `redis`. It always was at runtime: `redisSettings` was ignored |
| `logs.level` accepted any string | Must be one of the lowercase level names |
| `port: process.env.DB_PORT` and other numeric strings worked | Rejected. Convert first: `Number(process.env.DB_PORT)` |
| A host with a missing or empty `host` was logged and skipped | `createPoolCluster` throws |

Check your settings object once before upgrading: a key that was ignored in 3.x stops the app at startup in 4.0.0.
