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
| `idleCheckInterval` | `number` (ms). A node with a `healthCheck` block also pings its idle connections at this pace, but never more often than every 100 ms and never less often than every 2147483647 ms, whatever the value. A value below 100 or above 2147483647 is still valid, see [subsystems/pool.md](subsystems/pool.md#the-pace-of-the-ping) | `10000` |
| `validators` | array | see below |
| `loadFactors` | array | see below |
| `timerCheckRange` | `{ start, end }` (ms), either half may be left out | `{ start: 5000, end: 15000 }` |
| `timerCheckMultiplier` | `number` | `1.3` |
| `healthCheck` | object | not set: the node keeps the legacy check, see [below](#healthcheck) |
| `queryTimeout` | `number` (ms), 0 to 2147483647. The time limit of each statement and of the commands before it, by a timer of the pool, see [subsystems/pool.md](subsystems/pool.md#the-session-of-a-connection). 0 means none. The query option `timeout` overrides it per call. A negative one is refused, here and as the query option | `120000` |
| `resetTimeout` | `number` (ms), 1 or more. How long the reset of a dirty connection may take. One that fails or takes longer ends with the connection destroyed with its socket. See [subsystems/pool.md](subsystems/pool.md#the-session-of-a-connection). | `1000` |
| `maxPreparedStatements` | `number`, a whole number, 1 or more. How many statements of `execute()` mysql2 keeps prepared per connection; past it the one used longest ago is closed. The server counts every one against `max_prepared_stmt_count` (16382 by default), for all its clients: keep `processes × connectionLimit × maxPreparedStatements` per node below it, with room for the other clients. See [subsystems/cluster.md](subsystems/cluster.md#execute-and-bound-values). | `100` |
| `probeIdle` | `number` (ms), 0 or more. A pooled connection idle longer than this answers a ping before a statement or the app gets it. An answered ping of the idle timer counts as use. See [subsystems/pool.md](subsystems/pool.md#borrow-taking-and-giving-back-a-connection). | `1000` |
| `probeTimeout` | `number` (ms), 1 or more. How long that ping may take. One that fails or takes longer ends with the connection destroyed with its socket, and the next connection of the node is taken, until health gives the node up. | `1000` |
| `resetAfterStatements` | `number`, a whole number, 1 or more. A connection is reset when it goes back to the pool after this many replies since its last reset, so prepared statements a procedure left behind cannot pile up. | `1000` |
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

The `flags` connection option of mysql2, passed to `mysql.createPool` as they are. A name adds a flag, a name with a leading `-` turns a default one off. mysql2 takes an array or one comma-separated string. Left out, the library picks them per node, see below.

Nobody checks the names. mysql2 ignores a name it does not know, without an error, and matches array entries exactly: upper case, no spaces. An array entry such as `'-client_query_attributes'` changes nothing, and neither does a misspelt name. mysql2 upper-cases only the string form. Leave `MULTI_STATEMENTS` off: it lets one query carry several statements, which makes SQL injection worse.

The case it exists for: mysql2 3.21.0 and later turn on `CLIENT_QUERY_ATTRIBUTES` without looking at the server version. A server that announces the capability but is older than 8.0.26, such as Percona XtraDB Cluster 8.0.25, does not parse the prepared-statement packet that comes with it, so every `connection.execute()` hangs. The library's own queries are plain `query()` calls and are not affected, but code that runs `execute()` on the library's pools is.

#### Picked per node when `flags` is left out

A pool without `flags` asks its server first. Before it creates the mysql2 pool it logs in once, reads the version and the capabilities from the server's greeting, and logs out. Then:

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
- Until that login has answered, the pool has no connections. A query that reaches it then is rejected with the code `POOL_NOT_CONNECTED`. The cluster tries the next node, since the statement was never sent, see [subsystems/cluster.md](subsystems/cluster.md#8-retry-loop).
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

### `healthCheck`

A node that has this block is checked by new rules: a fixed wait between two checks, down after `fall` failed checks in a row, back after `rise` passed ones. A node without it keeps the legacy check, which is every node of an app that does not set the block. The rules of both are in [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#two-modes).

| key | type | default | meaning |
|---|---|---|---|
| `interval` | `number` (ms), 100 or more | `5000` | The wait between two checks of a node, counted from the end of the check before. It is the same after a passed and after a failed check |
| `timeout` | `number` (ms), 1 or more | the `interval` of the node | The limit of one check: opening the check connection when the node holds none, the change of user and the status query. The check does not wait for a connection of the pool. It is also the limit of one ping of an idle pooled connection, see item 12 of [What changes for the app](#what-changes-for-the-app) |
| `fall` | integer, 1 or more | `2` | Failed checks in a row before a node goes down |
| `rise` | integer, 1 or more | `2` | Passed checks in a row before a node that is down comes back |
| `authRetryInterval` | `number` (ms), 100 or more | the longer of `60000` and the `interval` of the node | The wait before the next check after a check whose login or account the server refused, and after the checks that follow it without an answer. A refused check also takes the node down at once |
| `passive` | `boolean` | `true` | Passive health: the connection errors of the queries of the app move the node between two checks. A connection the node refuses takes the node down at once. A connection that was lost, was not there within the connect timeout or that no route led to starts a check at once, and that check takes the node down when it fails, unless it finds no route itself: then it counts toward `fall` |

An empty block is enough to switch a node, and gives it the defaults:

```js
defaultPoolSettings: {
    healthCheck: {}
}
```

What to know:

- **The block switches the node, not single keys.** There is no default block. With no `healthCheck` in `defaultPoolSettings` and none on a host, that host keeps the legacy check.
- **`timerCheckRange` and `timerCheckMultiplier` are ignored for a node that has the block.** When the app wrote one of them for such a node, on the host or in `defaultPoolSettings`, the node logs one `warn` when the cluster is created. The line has the meta `pool`, the name of the pool, and `ignored`, the keys. A default the schema filled in is not something the app wrote and logs nothing.
- **`queryTimeout` has no part in the check of such a node.** Its check ends at `healthCheck.timeout`. The legacy check ends at `min(queryTimeout, timerCheckRange.end)`.
- **`timeout` may be longer than `interval`.** The interval is counted from the end of a check, so two checks of the timer do not run at the same time. A check that has to open a connection also ends with the connect timeout of mysql2, 10 seconds, when `timeout` is longer than that: the login ends with `ETIMEDOUT` and the check fails with that error.
- **A node with the block holds one more connection.** Its check asks on a connection of its own, next to the pool, so a pool at its limit no longer fails the checks of a healthy node. That is one connection per node in every process, on top of `connectionLimit`, and it counts against `max_connections` of the server. The pool itself holds no connection after `connect()`, so the first query of the app to each node pays for a login. No check uses a connection of the pool, so the timer that closes idle connections pings the idle ones of such a node every `idleCheckInterval`. Behind a balancer or firewall with an idle timeout keep `idleCheckInterval` below that timeout, see item 12 of the list below. See [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#the-check-connection).
- **A check that times out is not waited for.** When the timer of a check fires, the check waits one turn of the event loop, so an answer that is already in the socket of a process that stood still wins, and then it drops the connection it asked on. The next check opens a new one.
- **A node that was down needs `rise` passes, the first pass after `connect()` only one.** So a start is not slowed, and neither is a node that was down when the app started. Set `rise: 1` to bring every node back with one pass, as the legacy check does.
- **A validator that says no takes the node down with one check**, whatever `fall` is. `fall` counts the checks that got no answer.
- **A refused login takes the node down with one check too, and the next check waits `authRetryInterval`.** A wrong password, a locked account or a blocked host does not pass by asking again, and each login can count against the account at the server. With the defaults a node that refuses the login is asked once a minute, 60 times an hour, where `interval` alone would ask 720 times. The slow pace holds while the checks after the refusal get no answer, as when the server holds its refusal back for longer than `timeout`. It ends with the first check that is answered and is no refusal: a pass, a validator that says no, or a clear error such as a refused connection. Which errors count as a refusal, and why, is in [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#a-login-or-account-refusal).
- **Left out, `authRetryInterval` is the longer of 60000 and the `interval` of that node.** So a node that refuses the login is not asked more often than one that answers. The default is worked out per host, after the block of `defaultPoolSettings` was mixed in: a host with an `interval` of its own gets a default of its own.
- **A written `authRetryInterval` is used as it is written**, also when it is shorter than `interval`. The floor of 100 ms allows ten logins a second at a node that refuses, 36000 in an hour. Where the server locks an account after a number of wrong passwords, such a value spends that number within a second. Keep it at a minute or more unless the server has no such policy.
- **`passive` is on unless the app turns it off.** A query, a transaction or a `getConnection()` of the app whose connection the node refuses takes that node down at once: the error is `fatal` and its `code` is `ECONNREFUSED`. One that loses the connection it was handed, with `PROTOCOL_CONNECTION_LOST`, `ECONNRESET` or `EPIPE`, gets none within the connect timeout, `ETIMEDOUT`, or finds no route, `EHOSTUNREACH` or `ENETUNREACH`, leaves the node up and starts a check at once, and one failed check then takes the node down, whatever `fall` is. A check whose own connection was lost, as behind a balancer that forgot its idle flows, opens a new one and asks again, once, and what it gets there is its result. After a call that found no route or got no connection in time the check asks on a new connection from the start, since the one the node holds says nothing about a new one. The one the node holds stays until the new one logged in, and it stays when the new one finds no route. A check that finds no route itself, `EHOSTUNREACH` or `ENETUNREACH`, does not decide alone either: it counts toward `fall` as any failed check, so with a `fall` of 2 or more a route that is gone for a moment takes no node down. Only a check brings the node back, by `rise`. An answer of the server never counts: not a deadlock (1213), not a lock wait timeout, not a refused login, not a syntax error. Neither does a query timeout, nor a name that does not resolve (`ENOTFOUND`, `EAI_AGAIN`). The rules, the codes and the reasons are in [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#passive-health).
- **`passive: false` leaves the node to its checks.** No error of a query of the app moves it, and a dead node stays in rotation until `fall` checks failed.
- **A change of state is logged.** A node that goes down logs one `warn`, a node that comes back one `info`, each with the meta `pool`, `valid` and `reason`. The reason is `fall`, `refusal`, `validator`, `passive_connect`, `passive_lost`, `passive_timeout` or `passive_unreachable` for a node that went down, `first_pass` or `rise` for one that came up. The line of a `refusal` also has the `errno` the server refused with and `retryIn`, the ms until the next check. The four lines of passive health have the `code` of the error of the app. A check that had to decide and found no route itself changes no state and logs one `warn` without a `reason`, with `pool`, `passive`, `code`, `checkCode`, `failedChecks` and `fall`. A node of the legacy check logs none of these.

#### On `defaultPoolSettings` and on a host

The block may be set in `defaultPoolSettings`, on a host, or both. It is mixed key by key: a host takes each key it left out from the block of `defaultPoolSettings`, and each key left out in both places gets its default.

```js
defaultPoolSettings: {
    healthCheck: { interval: 2000, fall: 3 }
},
hosts: [
    { host: 'db1.example' },                              // interval 2000, timeout 2000, fall 3, rise 2
    { host: 'db2.example', healthCheck: { rise: 1 } },    // interval 2000, timeout 2000, fall 3, rise 1
    { host: 'db3.example', healthCheck: { interval: 10000 } } // interval 10000, timeout 10000, fall 3, rise 2
]
```

`authRetryInterval` is 60000 on all three: nobody wrote it, and each `interval` is shorter than that. With `interval: 300000` on a host it would be 300000 there. `passive` is `true` on all three, as nobody wrote it. A host can turn passive health off for itself with `healthCheck: { passive: false }`.

- A `timeout` nobody wrote is the `interval` of that node, as for `db3.example` above. A `timeout` written in `defaultPoolSettings` reaches every host that does not write its own, whatever its `interval`.
- A block on one host alone switches that host alone. The other hosts keep the legacy check.
- A block in `defaultPoolSettings` switches every host. A host cannot go back to the legacy check then. To run both kinds in one cluster, leave the block out of `defaultPoolSettings` and set it on the hosts that should have it.
- `healthCheck: undefined`, and a key of the block set to `undefined`, count as left out.
- After `createPoolCluster`, each host in `config.current.hosts` holds its block with every key. The block in `config.current.defaultPoolSettings` stays as the app wrote it.

#### Validation

The block is strict like every other object of the settings, and every problem is named by its path, such as `defaultPoolSettings.healthCheck.fall` or `hosts[0].healthCheck.interval`:

- A key the block does not have is an error.
- `interval` and `authRetryInterval` are numbers of 100 or more, `timeout` a number of 1 or more. Node turns a wait below 1 ms into 1 ms, and an interval of a few ms would ask a node hundreds of times a second, each time with a login. All three are at most 2147483647, the longest wait a timer of Node takes. A fraction is allowed.
- `authRetryInterval` is not compared with `interval`: either may be the longer one.
- `fall` and `rise` are integers, 1 or more.
- `passive` is `true` or `false`. A string or a number is an error.
- Anything but an object is an error for the block itself, `null` included.

#### Moving from `timerCheckRange` and `timerCheckMultiplier`

This part is for an app that runs on the legacy check and wants the block. Nothing forces the move. A node without the block keeps the legacy check: the same waits, the same timeout, down at the second failed check and back with one pass. [tests/pool/health-check-legacy.test.ts](../tests/pool/health-check-legacy.test.ts) holds that, with the default settings and with the settings of the example below.

The steps:

1. Upgrade the package first. 3.2.2 ignores the key `healthCheck`, so the block does nothing until the app runs 4.0.0.
2. Add `healthCheck: {}` to `defaultPoolSettings`. To try it on one node first, add it to that host instead. A block on one host switches that host alone, see [On `defaultPoolSettings` and on a host](#on-defaultpoolsettings-and-on-a-host).
3. Remove `timerCheckRange` and `timerCheckMultiplier` once every host they reach has the block. A node with the block ignores them. While they are there it logs one `warn` that names them, whether the app wrote them on that host or in `defaultPoolSettings`, and the settings stay valid. With the block on some hosts only, the hosts without it still take the two keys from `defaultPoolSettings`. Removing them there would put those hosts on the default range and multiplier, and nothing would say so. Leave the keys there and expect the `warn`, or move them to the hosts that keep the legacy check.
4. Keep `queryTimeout`. It still limits the queries of the app. It no longer limits the check.
5. Go through [What changes for the app](#what-changes-for-the-app) and set the keys of the block the app needs.

To go back, remove the block and put the two keys back. The node is on the legacy check again.

##### Before and after

The legacy check waits longer after each answered check and shorter after each failed one, between the two ends of `timerCheckRange`. An app that wanted few checks set a long range, and paid for it when a node died. Take this app:

```js
defaultPoolSettings: {
    timerCheckRange: { start: 15000, end: 60000 },
    timerCheckMultiplier: 0.1,
    queryTimeout: 15000
}
```

With these values a node that passes is checked every 15 s, and one that fails every 60 s. One check may take 15 s, and the second failed check in a row takes the node down. The same app with the block:

```js
defaultPoolSettings: {
    queryTimeout: 15000,
    healthCheck: {}
}
```

| | before | after |
|---|---|---|
| Wait after a passed check | 15 s | 5 s |
| Wait after a failed check | 60 s | 5 s |
| Limit of one check | 15 s | 5 s |
| A node that refuses connections is out after, at most | 75 s | 10 s |
| A node whose checks hang is out after, at most | 105 s | 20 s |
| A node that refuses connections, once a query of the app runs into it | still in rotation | out at once |
| A node that answers again is back after, at most | 60 s | 10 s |
| The same when a check was hanging as the node returned | 75 s | 15 s |
| Wait after a check whose login the server refused | 60 s | 60 s |
| Logins in one hour at a node that refuses the login | 60 | 60 |

Every number is measured, see [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#time-to-leave-rotation-and-to-come-back), for the row of the query [Time to leave rotation once a call of the app fails](subsystems/health-and-scoring.md#time-to-leave-rotation-once-a-call-of-the-app-fails) and, for the last two rows, [Logins in one hour](subsystems/health-and-scoring.md#logins-in-one-hour).

##### What each legacy setting becomes

| Legacy check | With the block | Default with the block |
|---|---|---|
| `timerCheckRange.start`, 5000 by default. The shortest wait, reached after failed checks | `interval`. One wait after every check, passed or failed | `5000` |
| `timerCheckRange.end`, 15000 by default. The longest wait, reached after answered checks | `interval` as well | `5000` |
| `min(queryTimeout, timerCheckRange.end)`, 15000 with the defaults. The limit of one check | `timeout` | the `interval` of the node |
| `timerCheckMultiplier`, 1.3 by default. How far the wait moves after each check | Nothing. The wait does not move, so no key takes its place | |
| A multiplier below 1 with a wide range, to ask a node that refuses the login less often | `authRetryInterval`, for a refused login alone | the longer of `60000` and the `interval` of the node |
| Down at the second failed check in a row. Fixed, not a setting | `fall` | `2` |
| Back with one check that passes. Fixed, not a setting | `rise`. The first pass after `connect()` is enough by itself | `2` |
| No error of a query of the app moves a node | `passive` | `true` |

The defaults of the block are in the table of [`healthCheck`](#healthcheck). With an empty block a node is checked every 5 s, one check may take 5 s, and two failed checks in a row take the node down, as with the legacy check. Two passes bring it back, where the legacy check needs one.

##### An app that raised `timerCheckMultiplier`

A multiplier above the default moves the legacy wait to the ends of the range in fewer checks. With a multiplier of 3 and the default range, one failed check sets the wait to 5000 and one answered check sets it back to 15000. With the default of 1.3 the first failed check sets a wait of 15000 to 11538. A healthy node has that wait from its second answered check after `connect()` on. So with the raised key the second check comes 5 s after the first failure, not 11.5 s, and a dead node leaves rotation that much sooner.

Such an app can drop the key once it uses the block. The wait after a failed check is then `interval`, 5000 by default, and no multiplier has a part in it. A dead node is out after 10 s at most, or 20 s when its checks hang. With `passive` on, a node that refuses connections is out with the first call of the app that fails, and no check is waited for.

One thing changes the other way. A healthy node is checked every 5 s, where the raised multiplier checked it every 15 s. Set `interval` to keep that pace, see item 2 of [What changes for the app](#what-changes-for-the-app).

##### An app that set a multiplier below 1

A multiplier below 1 turns the legacy rule around: the wait shrinks after an answered check and grows after a failed one. An app that set it, with a wide range, to keep a node with a wrong password from being asked every 5 seconds can drop both keys. With the legacy defaults such a node gets 718 logins in an hour. The wide range brought that down to 60, and made every other failure wait a minute as well, so a dead node took 75 s to leave rotation. The block keeps the 60 for a refused login alone, through `authRetryInterval`, and checks a node that fails any other way every `interval`.

##### What changes for the app

1. **Remove `timerCheckRange` and `timerCheckMultiplier`.** They are ignored next to the block, and each node logs one `warn` while they are there. The slow retry they gave a refused login comes from `authRetryInterval` now, with no key to set.
2. **A node is checked more often.** Each check is one `SHOW GLOBAL STATUS` on the check connection of the node. With the defaults that is one every 5 s per node, where the legacy defaults settle at one every 15 s. Set `interval` to keep the old pace: `healthCheck: { interval: 15000 }` checks every 15 s and takes a dead node out after 30 s, or after 60 s when its checks hang.
3. **The check no longer follows `queryTimeout`.** Set `timeout` when a healthy node can take longer than `interval` to answer the status query.
4. **A node that was down comes back after two passes, not one.** Set `rise: 1` to keep the old rule.
5. **`pool_check_failed` comes every `interval` while a node fails**, not at the pace of the legacy range, and every `authRetryInterval` while it refuses the login.
6. **A refused login takes the node down with the first check**, not with the second. The legacy check counts it like any other failure.
7. **A query of the app can take a node down.** With the block passive health is on. A node that refuses the connection of a query leaves rotation with that query, and the queries after it go to the other nodes. The query that found it still fails on that node: `cluster.query()` sends it to the next node as before, and `getConnection()` rejects as before. With the legacy check the node stayed in rotation until its second failed check. Set `passive: false` to keep that.
8. **Checks can come sooner than `interval`.** A connection error of a query starts a check at once, one at most between two checks of the timer. So `pool_check_failed` can come twice per `interval`. A node that refuses the login is down, so no query starts a check there, and its checks stay `authRetryInterval` apart.
9. **Each node takes one more connection of the server.** The check has a connection of its own, in every process, next to the `connectionLimit` connections of the pool. Count it when `max_connections` of the server or `MAX_USER_CONNECTIONS` of the account is tight.
10. **A full pool no longer takes a healthy node down.** With the legacy check a pool whose connections are all in use makes the check wait and time out, and the node leaves rotation. With the block the check does not wait for the pool.
11. **The pool events and counts no longer show the checks.** `connection`, `acquire` and `release` fire for the queries of the app only, and `getPoolStats()` and the connection metrics leave the check connection out. `idle` is `0` after `connect()` until a query ran. The warn of a slow query does not come for a slow status query.
12. **The check no longer uses a connection of the pool, and the idle ones get a ping instead.** The legacy check draws an idle connection of the pool each time it runs, so a balancer or firewall with an idle timeout does not forget the one connection that `minConnections: 1` keeps. With the block the check asks on its own connection. So the timer that closes idle connections also sends a ping on every idle connection of such a node, once every `idleCheckInterval`, 10 s by default. Keep `idleCheckInterval` below the idle timeout of the path. Behind a path that forgets a flow sooner than that, a quiet app on the defaults still loses its first query after a pause: it fails with `ECONNRESET` on each node it tries, and the node stays up. A ping that fails, or has no answer within `timeout`, closes that connection, and the next query opens a new one. A ping is no check and no query of the app: it moves no node, emits no event and is no record of a metric. Measured in [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#a-quiet-app-behind-a-path-with-an-idle-timeout). Idle connections the path forgot while others were in use fail one query each, unless a ping finds them first.
13. **A call that can open no connection makes the next check open one.** After a call of the app found no route or ran into the connect timeout, the check that starts asks on a new connection, opened beside the one the node holds, so a node that takes no new connection does not pass on the old one. A new one that logs in replaces the old one. A new one that finds no route leaves the old one, and the check counts toward `fall`: a node goes down by `fall` only while calls go on failing, and it comes back by `rise` on the old connection once no call is sent to it. A new one that fails any other way takes the node down and the old connection with it. With `passive: false` the node is told of no call: its checks ask on the connection the node holds, and the node stays up for as long as that one answers. See [A check after a call that could open no connection](subsystems/health-and-scoring.md#a-check-after-a-call-that-could-open-no-connection).

## Named values

`cluster.query(sql, values)` takes an object of values for `:name` placeholders.

```js
await cluster.query('SELECT * FROM users WHERE email = :email', { email });
```

Each named value is always escaped, as array and string values are. For `email = "o'neil@example.com"` the SQL sent is `... WHERE email = 'o\'neil@example.com'`. 3.2.2 put the value in as text: `... WHERE email = o'neil@example.com`. There is no setting to turn the escaping off: strict validation refuses an `escapeNamedValues` setting with `Unrecognized key: "escapeNamedValues"`, and a query option of that name is ignored.

Each named value goes through sql-escaper's `escape` (the function mysql2 exports). A string arrives quoted and escaped, a number as a number, `null` and `undefined` as `NULL`, an array as a comma-separated list, a `Date` as a quoted date. A plain object arrives as the string `'[object Object]'`, never as SQL. To send SQL through a value on purpose, wrap it: `require('mysql2').raw('NOW()')`. Any object with a `toSqlString` function is sent as SQL the same way. JSON cannot carry a function, so a parsed request body cannot hold one.

**Escaping protects a placeholder that stands where a value stands, and nowhere else.** Inside quotes the value's own quotes would close the literal: for `name = ':n'` the value ` OR 1=1 -- ` would give `name = '' OR 1=1 -- ''`. So a placeholder inside quotes or backticks makes `query()` reject with the code `MDC_QUOTED_PLACEHOLDER` before any node is asked, when the object has that key. Write `name = :n`. A placeholder inside a comment stays text. One inside `/*! */` or `/*+ */` is replaced: it is treated as code, as sql-escaper treats a `?` there. MySQL reads `/*+ */` as a hint only right after the first keyword of `SELECT`, `INSERT`, `REPLACE`, `UPDATE` or `DELETE`, and skips `/*!NNNNN */` when `NNNNN` is above its version. Read as a plain comment, it ends at a `*/`, also one inside a value, and a skipped `/*!NNNNN */` can take a `/*`, also one of a value, as the start of a nested comment. On MySQL 8.0.42 a value holding `*/` ended the comment and the rest of the value ran as SQL inside `/*+ */`, in a hint position or not, and inside `/*!99999 */`, but not inside `/*! */` or `/*!80000 */`, which the server runs. So since 4.1.1 `query()` rejects with the code `MDC_UNSAFE_COMMENT_VALUE` before any node is asked when the statement holds `/*+` or a `/*!` with a version anywhere and its values add a `/*` or a `*/` to the text, wherever the value stands. A value without them, such as the number for `MAX_EXECUTION_TIME(:ms)`, is written as before, and so is any value in a statement without such a comment. Keep values out of comments anyway. See [Upgrading from 3.2.2](#upgrading-from-322).

**Check the type of a value that comes from a request.** An array becomes a list, so `LIMIT :n` with `[0, 100000]` gives `LIMIT 0, 100000`, a nested array gives `(1, 2), (3, 4)`, and an empty array gives `IN ()`. Where the SQL expects one number or one string, make sure the value is one.

**The escaping needs a server without `NO_BACKSLASH_ESCAPES`**, as for array values. On a connection whose server reports that mode, `query()` refuses values in the text with `MDC_UNSAFE_SQL_MODE`. `cluster.execute()` sends them bound by the server instead, with no escaping, see [subsystems/cluster.md](subsystems/cluster.md#execute-and-bound-values).

### Upgrading from 3.2.2

3.2.2 sent named values as text. Before a service moves to 4.0.0:

- **Remove `escapeNamedValues` from the settings**, if they have it. Strict validation refuses it.
- **Remove the quotes around placeholders.** `name = ':name'` becomes `name = :name`. This step is not optional. 4.0.0 replaced a placeholder inside quotes: the value's own quotes closed the literal early, and a value written for it changed the statement without a single quote character in it. 4.0.1 refuses such a call with `MDC_QUOTED_PLACEHOLDER` before any node is asked. The same holds for a placeholder inside backticks.
- **Move SQL fragments out of the values.** A value such as `NOW()`, a column name or `ASC` is now sent as a quoted string. Write those into the SQL text, from a fixed list the code owns, or wrap them in mysql2's `raw()`.
- **`LIKE` patterns.** Put the wildcards in the value: `name LIKE :pattern` with `{ pattern: '%' + text + '%' }`, not `'%:text%'`, which is a placeholder inside quotes.
- **A `:name` inside a string literal is refused** when the object has that key, such as `'10:30'` with a key `30`. Rename the key or the text.
- **Redis cache keys change.** The formatted SQL is the cache key, so each such query misses the cache once after the upgrade.

## `hosts`

One entry per Galera node. `host` is required. Every key of `defaultPoolSettings` may be repeated here to override it for that node.

| key | type | notes |
|---|---|---|
| `host` | `string` | required, not empty |
| `id` | `number` | assigned by the cluster when left out or `0`. A `0` stays `0` only on the first host without an id of its own, and only when no host has another id. When it is replaced, the cluster logs a `warn` with the host, the port and the id the node got. Use a whole number above `0` that no other host has, and at most 127 with `useClusterHashing`: the hashing database keeps the id in a signed `TINYINT`. Since 4.1.1 the cluster logs a `warn` for a host whose id is negative, not an integer, the id of another host too, or above 127 with `useClusterHashing`, and keeps the id as it is. That covers an id the cluster gave, which the line names as the id the host got. A host gets one `warn` at most: for a `0` it replaced with such an id, both are in one line |
| `name` | `string` | `host:port` when left out |
| `redisExpire` | `number` (s) | cache TTL for queries served by this node |
| any `defaultPoolSettings` key | as above | overrides the default for this node. `healthCheck` is mixed key by key, see [above](#on-defaultpoolsettings-and-on-a-host) |

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
3. **Mix every host with the default pool settings.** Each host becomes the default pool settings with its own keys on top, merged in `Settings._mix`. A host that omits `port`, or sets it to `undefined`, inherits it. Arrays are concatenated in this step: `validators` on a host are added to the default ones, not swapped for them. `flags` is the exception, a host's value replaces the default one. A `healthCheck` block is mixed key by key and then filled with its defaults, and only for a host that has one after the mix: this step is the one that fills them, not the schema.
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
