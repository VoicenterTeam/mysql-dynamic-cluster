# Subsystem: Health and Scoring

Each `Pool` carries a companion `PoolStatus` instance that decides, on a
timer, whether the underlying MySQL node is still
routable and how heavily loaded it is. The check is a single
`SHOW GLOBAL STATUS` query fed through two small evaluators —
`Validator` (boolean: is this pool still eligible?) and `LoadFactor`
(numeric: how loaded is it?). The output is consumed by
`GaleraCluster._getActivePools` when it picks a pool for the next
query; see [cluster.md](cluster.md) for the routing side.

Sources:
[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts),
[src/pool/CheckConnection.ts](../../src/pool/CheckConnection.ts),
[src/pool/Validator.ts](../../src/pool/Validator.ts),
[src/pool/LoadFactor.ts](../../src/pool/LoadFactor.ts),
[src/utils/Timer.ts](../../src/utils/Timer.ts).

Per-pool, single-threaded feedback: nothing in this subsystem talks to
other pools or shares state across the cluster. See [pool.md](pool.md)
for how `PoolStatus` is wired into a `Pool` and
[cluster.md](cluster.md) for how `_getActivePools` consumes
`isValid` and `loadScore`.

## Two modes

A node is checked in one of two ways. Its settings decide which, once, when
the cluster is created.

| | Legacy check | Check with a `healthCheck` block |
| --- | --- | --- |
| Which node | A node whose settings hold no `healthCheck` block. That is every node of an app that does not set the block | A node whose settings hold the block, from `defaultPoolSettings` or from its host. An empty block is enough. Not in 4.6.0 or earlier |
| Wait before the next check | Longer after an answered check, shorter after a failed one, inside `timerCheckRange`. See [Adaptive timer](#adaptive-timer) | `healthCheck.interval` after every check, but `healthCheck.authRetryInterval` after a check the server refused the login of, and after the checks that follow it without an answer |
| Where the check asks | Through the pool, like a query of the app. A pool at its limit makes it wait for a free connection | On one connection of its own, next to the pool. It never waits in the queue of the pool. See [The check connection](#the-check-connection) |
| Timeout of one check | `min(queryTimeout, timerCheckRange.end)`, the wait for a connection of the pool included | `healthCheck.timeout`: opening the check connection when the node holds none, the change of user and the status query |
| Down | At the second failed check in a row, or with one check a validator says no to | At the `fall`th failed check in a row, with one check a validator says no to, or with one check the server refuses the login of. By [passive health](#passive-health) also between two checks |
| A refused login | A failed check like any other | Down at once and a slower next check, see [A login or account refusal](#a-login-or-account-refusal) |
| A connection error of a query of the app | Changes nothing. Only a check moves the node | With `passive: true`, the default: a connection the node refuses takes the node down at once. One that was lost, was not there within the connect timeout or that no route led to starts a check at once, and that check decides. See [Passive health](#passive-health) |
| Back | With one check that passes | With `rise` passes in a row, or with the first pass since `connect()` |
| Over `disconnect()` and a new `connect()` | The count of failed checks and the wait are kept | Both runs start again |
| A check that throws after its answer came | The node is already set to what the validators said | A failed check. A pass it held does not count, a no does |
| `timerCheckRange` and `timerCheckMultiplier` | Used | Ignored. One `warn` per node when the app wrote one of them |

What a check asks and what it does with the answer is the same in both: a
change of user and one `SHOW GLOBAL STATUS`, the validators, the load
factors, `checkError`, the `pool_check_failed` event and the metrics. Where
it asks, the rule that moves `isValid` and the wait before the next check
differ. `PoolStatus` keeps the block as
`_healthCheck`. The constructor takes the timeout and `fall` from it,
`startTimerCheck()` resets the runs for it, `checkStatus()` applies its rules
and `nextCheckStatus()` waits its `interval`, or its `authRetryInterval`
while the slow pace of a refusal holds. `realFailure()` reads its `passive`.

The settings are in [../configuration.md](../configuration.md#healthcheck).
The legacy check is pinned by
[tests/pool/health-check-legacy.test.ts](../../tests/pool/health-check-legacy.test.ts),
the check with the block by
[tests/pool/health-check.test.ts](../../tests/pool/health-check.test.ts),
passive health by
[tests/pool/passive-health.test.ts](../../tests/pool/passive-health.test.ts),
and the check connection by
[tests/pool/check-connection.test.ts](../../tests/pool/check-connection.test.ts).
The sections below describe the legacy check unless they say otherwise.

## The rules of a `healthCheck` block

Next to `isValid` three values make the state of a node:

| Field | Meaning |
| --- | --- |
| `_failedChecks` | Failed checks in a row. The legacy check counts them too |
| `_passedChecks` | Passed checks in a row |
| `_passedSinceStart` | Whether a check passed since the last `startTimerCheck()`, which `Pool.connect()` calls |

`startTimerCheck()` sets all three back, so every `connect()` starts with no
run. It leaves `isValid` as it is. [Passive health](#passive-health) keeps
two more values, which `startTimerCheck()` sets back as well: whether the
app lost a connection, got none in time or found no route since the last
check that got its answer, and whether passive health may start a check.

A check ends in one of four ways:

1. **It passed.** The status query ran and every validator said yes. The run
   of failures is reset and the run of passes grows by one. A node that is up
   stays up. A node that is down comes back when this is the `rise`th pass in
   a row, or the first pass since `connect()`.
2. **A validator said no.** The status query ran. The node goes down at
   once, whatever `fall` is, and both runs are reset.
3. **It failed.** It got no answer: no connection, a lost connection, the
   timeout of the check, an error of the server that is no refusal, or an
   error the package made. The run of passes is reset and the run of
   failures grows by one. At `fall` in a row the node goes down. Every kind
   of failure counts the same, but for the next one. One failed check is
   enough when a query of the app lost its connection since the last check
   that got its answer, see [Passive health](#passive-health).
4. **The server refused the login or the account.** It is a failed check
   that takes the node down at once, whatever `fall` is. See
   [A login or account refusal](#a-login-or-account-refusal).

After a refusal the next check is set `authRetryInterval` ms later, and so
is the check after each failed check that follows it without an answer.
After every other check it is set `interval` ms later.

More on these rules:

- **Only a check brings a node back.** No timer and no query of the app
  brings a node up. A query of the app can take a node down, by
  [passive health](#passive-health).
- **The first pass since `connect()` is enough by itself.** The first check
  that passes after `startTimerCheck()` brings the node up, whenever it
  comes: as the check of `connect()`, or after any number of checks that
  failed or that a validator said no to. From then on the node needs `rise` passes
  each time it went down. A `disconnect()` and a new `connect()` start this
  again. So `connect()`, `ready` and `firstReady` end as they do with the
  legacy check: one passing check is a node that is ready, and a node that
  was down when the app started is not slowed.
- **A pass of a node that is still down** sets the load score, clears
  `checkError` and is recorded as a `valid` check, while `isValid` stays
  `false`. The result of a check says what that one check found. The state
  of the node is `isValid`, and the gauge `mysql_dynamic_cluster.node.valid`.
- **The interval starts when a check ends.** A check that hangs until its
  timeout is followed by the next one `timeout + interval` ms after it
  started, so two checks of the timer do not overlap. A second `connect()`
  without a `disconnect()` runs its own check beside the one of the timer, as
  with the legacy check.
- **A change of state is logged, one line each.** A node that goes down logs
  a `warn`, a node that comes back an `info`. The meta has `pool`, `valid`
  and `reason`: `fall`, `refusal`, `validator`, `passive_connect`,
  `passive_lost`, `passive_timeout` or `passive_unreachable` for a node
  that went down, `first_pass` or `rise` for one that came up. The line of
  a `refusal` also has the `errno` of the server and `retryIn`, the ms
  until the next check. `passive_connect` is a connection the node refused
  the app. The other three are a failed check after what the app ran into:
  `passive_lost` after a connection it lost, `passive_timeout` after a
  connect timeout, and `passive_unreachable` after a connection that no
  route led to. All four lines have the `code` of the error of the app. A lost
  connection whose check is the `fall`th failure in a row is logged as
  `fall`, one whose check the server refused as `refusal`. A check that
  passive health starts logs one `debug` line first, with the meta `pool`,
  `passive` as `connect`, `lost`, `timeout` or `unreachable`, and `code`. A check that
  opens a new connection for one it lost logs one `debug` line with `pool`
  and `code`. A check
  that had to decide and found no route itself logs one `warn` with no
  `reason`, see
  [A check that finds no route itself](#a-check-that-finds-no-route-itself).
  A check
  that leaves the node as it was logs no line about its state, so a dead node logs one `warn` and then only
  the error line of each failed check. A node that was never up logs no
  `warn`. The legacy check logs none of these lines.
- **The passes of a node that is up do not count later.** The check that
  takes a node down resets the run of passes, so the node always needs the
  full `rise` after it.
- **A failed check from before a `disconnect()` does not count after the new
  `connect()`.** `isValid` is kept over the two calls, as with the legacy
  check, so a node that was up stays up until `fall` checks of the new
  connect failed in a row. The legacy check keeps its count instead: one
  failed check before the `disconnect()` and one after take the node down.
- **A check that throws after its answer came is a failed check.** The
  answer was read, and then the package failed, for one in the load factors.
  Such a check has an empty `checkError`. It counts toward `fall`. A pass
  the validators gave it is dropped: it brings no node up, adds nothing to a
  run of passes and is not the first pass since `connect()`. A no the
  validators gave it holds: the node goes down at once. The legacy check
  sets the node to what the validators said before the rest of the check
  runs, so there such a check can leave a node valid.

### The check connection

Not in 4.6.0 or earlier. The check of a node with a `healthCheck` block asks
on one connection of its own, next to the pool of the app. The legacy check
asks through the pool, like a query of the app.

The reason is a pool at its limit. mysql2 queues the requests of such a
pool, first in and first out, with no timeout. A check that asks through
the pool waits there behind every request of the app and runs into its own
timeout. After `fall` such checks a node that is busy and healthy leaves
rotation, its traffic moves to the other nodes, and they can fill up and
leave the same way.

- **A check never waits in the queue of the pool** and takes no connection
  of it. `failWaiting()` fails the requests of the app and no check.
- **One connection per node, per process.** The first check of `connect()`
  opens it with the options and the flags of the pool. It is kept between
  the checks, and `disconnect()` logs out of it. It counts against
  `max_connections` of the server, next to the connections of the pool.
- **Every check is still a login.** The check sends a change of user ahead
  of its status query, as every query of the package does. A server that
  refuses the account refuses every check, on the connection the node
  holds as on a new one. So the refusal list, `authRetryInterval`, the slow
  pace and `checkError` mean what they meant.
- **`timeout` covers the whole check and nothing else:** opening a
  connection when the node holds none, the change of user and the status
  query. No wait for a connection of the pool is in it.
- **A check that times out drops its connection.** The status query has no
  timeout of mysql2. The timer of the check ends it, and the connection is
  destroyed with its socket. No late answer comes on it, and the next
  check opens a new one.
- **One turn of the event loop before a timeout counts.** Node runs a timer
  that is due before it reads its sockets. After a process stood still for
  longer than `timeout`, in a big JSON parse or a long GC pause, the timer
  of a check that was out fires although the answer of the node waits in
  the socket. So when its timer fires the check waits one `setImmediate`
  first, and an answer that is read in that turn wins. An answer that is
  not there by then does not: such a check fails as any check that timed
  out. The legacy check has no such turn.
- **A connection that was lost is opened again, once**, inside the same
  check. See
  [A check whose connection was lost](#a-check-whose-connection-was-lost).
- **A connection that is open says nothing about a new one.** The one the
  node holds answers while a missing route, or a firewall that drops new
  connections, lets no call of the app open one. So a check that has to
  decide after a call found no route or got no connection within the
  connect timeout logs out of the connection the node holds and asks on a
  new one, see
  [A check after a call that could open no connection](#a-check-after-a-call-that-could-open-no-connection).
  A check of the timer with nothing to decide asks on the connection the
  node holds, and so does every check of a node with `passive: false`.
- **mysql2 gives a login 10 s.** The check connection takes the
  `connectTimeout` of mysql2, as the pool does. With a `timeout` above
  10 s a login that hangs ends after those 10 s with `ETIMEDOUT`, and not
  at the timeout of the check.
- **A second `connect()` without a `disconnect()`** logs out of the
  connection and holds a new one. A check that was still out on the old
  one asks again on the new one.
- **What else an app sees.** The pool of a node holds no connection after
  `connect()`, so the first query of the app to each node pays for a
  login. A check emits no `connection`, `acquire` or `release`, and
  `getPoolStats()` and the connection gauges do not count the check
  connection. See [pool.md](pool.md#the-check-connection).

Measured with the real mysql2 against its own server class on the loopback
interface of one Linux host, by a probe that is not part of the suite: 3
runs of 10 s on each side. One node, `connectionLimit: 2`,
`healthCheck: { interval: 500, timeout: 500 }`, which is the default block
ten times faster, a server that takes 400 ms for a query of the app, and
one query every 50 ms.

| | Check through the pool | Check connection |
| --- | --- | --- |
| The node was down | 7532 to 7545 ms of the 10 s, from about 2 s on | Never |
| Queries rejected with `There is no pool that satisfies the parameters` | 151 of 199 | 0 |
| Failed checks | 8 | 0 |
| Checks the server answered | 11 | 19 |
| Connections open at the server, at most | 2 | 3 |

The queue is not shorter for it. The pool is full on both sides, and with
the check connection 155 of the 199 queries still waited when a run
ended. The package sets no queue limit and no timeout for a request that
waits, see [../node-api.md](../node-api.md#it-waits-without-limit).

The same case is a test with the real mysql2 on loopback, "a saturated
pool: the check still passes and the node stays up", in
[tests/cluster/passive-health-loopback.test.ts](../../tests/cluster/passive-health-loopback.test.ts).
A process that sleeps past the timer of a check with the answer in the
socket is a test there too.

### A login or account refusal

A check the server refused is a failed check with two rules of its own:

1. The node goes down with that one check, whatever `fall` is.
2. The next check waits `authRetryInterval`, where every other check is
   followed by `interval`. With an empty block that is 60000 ms. The slow
   pace holds until a check is answered, see
   [The slow pace holds until a check is answered](#the-slow-pace-holds-until-a-check-is-answered).

For the rest it is a failed check like any other. It ends a run of passes,
sets `checkError`, emits `pool_check_failed` and is recorded as an `error`
check. The node comes back by `rise` passes in a row, or by the first pass
since `connect()`. A pass ends the slow pace, so the passes that bring the
node back are `interval` apart.

A refusal is told by the `errno` of the reduced
[`checkError`](#the-error-of-the-last-check), and by nothing else. The list
is fixed:

| `errno` | `code` in mysql2 3.24.6 | Message of the server |
| --- | --- | --- |
| 1044 | `ER_DBACCESS_DENIED_ERROR` | Access denied for user '%s'@'%s' to database '%s' |
| 1045 | `ER_ACCESS_DENIED_ERROR` | Access denied for user '%s'@'%s' (using password: %s) |
| 1049 | `ER_BAD_DB_ERROR` | Unknown database '%s' |
| 1129 | `ER_HOST_IS_BLOCKED` | Host '%s' is blocked because of many connection errors; unblock with 'mysqladmin flush-hosts' |
| 1130 | `ER_HOST_NOT_PRIVILEGED` | Host '%s' is not allowed to connect to this MySQL server |
| 1862 | `ER_MUST_CHANGE_PASSWORD_LOGIN` | Your password has expired. To log in you must change it using a client that supports expired passwords. |
| 3118 | `ER_ACCOUNT_HAS_BEEN_LOCKED` | Access denied for user '%s'@'%s'. Account is locked. |
| 3159 | `ER_SECURE_TRANSPORT_REQUIRED` | Connections using insecure transport are prohibited while --require_secure_transport=ON. |
| 3955 | `ER_USER_ACCESS_DENIED_FOR_USER_ACCOUNT_BLOCKED_BY_PASSWORD_LOCK` | Access denied for user '%s'@'%s'. Account is blocked for %s day(s) (%s day(s) remaining) due to %u consecutive failed logins. |
| 4150, MariaDB | `ER_BULK_PARSER_UNEXPECTED_CHAR_AFTER_COLUMN_TERMINATOR` | User is blocked because of too many credential errors; unblock with 'FLUSH PRIVILEGES' |
| 4151, MariaDB | `ER_BULK_PARSER_INCOMPLETE_ESCAPE_SEQUENCE` | Access denied, this account is locked |

The messages of 1044 to 3955 are those of the
[MySQL 8.0 server error reference](https://dev.mysql.com/doc/mysql-errors/8.0/en/server-error-reference.html),
the last two those of the
[MariaDB error codes 4100 to 4199](https://mariadb.com/docs/server/reference/error-codes/mariadb-error-codes-4100-to-4199).

- **Go by `errno`, not by `code`, for 4150 and 4151.** mysql2 names an errno
  by the table of MySQL. In the
  [MySQL 8.4 reference](https://dev.mysql.com/doc/mysql-errors/8.4/en/server-error-reference.html)
  these two numbers are errors about a row of a data file, so a MariaDB node
  that blocked the user shows the `code` of the table above. A health check
  loads no data file, so a MySQL node does not answer a check with them.
- **Never by `fatal`.** The same refusal reaches a check in three shapes,
  and only one of them is fatal:

  | Where the server refused | What mysql2 3.24.6 hands out |
  | --- | --- |
  | At the login of a new connection, when the node held no check connection | The error packet with `errno`, `code` and `sqlState`, and no `fatal` |
  | At the change of user on the connection the node holds. Every query of the package sends one first, the check included | The same error with `fatal: true`. mysql2 marks every error of a change of user as fatal. The connection is dropped, so the next check logs in on a new one |
  | As the answer to the status query. The check does not ask where an errno came from | The error packet, and no `fatal` |

- **A failure the package made is never a refusal.** Its `checkError` is
  an empty object: the timeout of the check, an error thrown after the
  answer came, and an error the app passed to `failWaiting()`, whatever
  `errno` that error has.
- **Every other error counts toward `fall`** and is followed by `interval`:
  too many connections (1040), too many connections of the user (1203), a
  limit of the account (1226), a deadlock (1213), a lock wait timeout
  (1205), a node that is not ready (1047), a lost or a refused connection.
  They pass with time, or say nothing about the login.
- **1226 is not on the list.** `ER_USER_LIMIT_REACHED`, "User '%s' has
  exceeded the '%s' resource (current value: %ld)", is what a server answers
  when an account is over a limit per hour. It is also the answer while the
  account has more connections open than its own `MAX_USER_CONNECTIONS`
  allows: MySQL raises it for that limit in `sql/sql_connect.cc`, and 1203
  for the global variable only. That passes as soon as one connection
  closes, as 1040 and 1203 do. The errno does not say which of the limits
  it was, so 1226 counts toward `fall`. For a limit per hour the manual says
  "the server rejects further connections for the account until that hour
  is up", see
  [Setting account resource limits](https://dev.mysql.com/doc/refman/8.0/en/user-resources.html).
  Such a node is checked every `interval` and goes down at `fall`.
- **What a check on an open connection does not see.** An app reported from
  a real server that for 1040 and 1129 a new login is refused while the
  change of user on an open connection still passes. A pool that holds an
  open connection runs its check on that one. Such a check passes, and sees
  neither of the two until it has to open a new connection. This was not
  reproduced here and is not changed.
- **`connect()` checks at once.** `authRetryInterval` holds back the timer
  of the node, nothing else. A `disconnect()` and a new `connect()` log in
  right away, whatever the last check ended with. A refused check of that
  `connect()` is followed by `authRetryInterval` again.
- **`authRetryInterval` is the longer of 60000 and the `interval` of the
  node** when the app did not write it, so a node that refuses the login is
  not asked more often than one that answers. A value the app wrote is used
  as it is written, also when it is shorter than `interval`.
- **The change of state is logged like any other**, as one `warn` with the
  reason `refusal`, the `errno` and `retryIn`, the ms until the next check.
  A refusal of a node that is down already, or was never up, logs no such
  line, as no state changed.
- **The legacy check has no such rule.** There a refused login is a failed
  check like any other: the second in a row takes the node down, and the
  wait follows `timerCheckRange` and `timerCheckMultiplier`.
- **The list is not a setting.** An app cannot add or remove an errno.

#### The slow pace holds until a check is answered

A server can hold a refusal back. The connection control plugin of MySQL
answers a wrong password later with each attempt, and soon later than a
check waits. Such a check ends by its own timeout and not with the errno of
the server. So after a refusal the node keeps waiting `authRetryInterval`
before each next check, for as long as its checks get no answer.

| The check after a refusal ended with | `checkError` | The wait after it |
| --- | --- | --- |
| Another refusal | an errno of the list | `authRetryInterval`, the slow pace goes on |
| The timeout of the check | `{}` | `authRetryInterval`, the slow pace goes on |
| Another failure the package made, such as `POOL_NOT_CONNECTED` | `{}` | `authRetryInterval`, the slow pace goes on |
| An error of mysql2 that has no code: `Can't add new command when connection is in closed state` | `{}` | `authRetryInterval`, the slow pace goes on |
| A connect timeout, from mysql2 or from the socket | `code: 'ETIMEDOUT'`, with or without an `errno` | `authRetryInterval`, the slow pace goes on |
| A pass, or a validator that said no, also when the check then throws in the package | none, or `{}` when it threw | `interval`, the slow pace is over |
| Any other error of mysql2, the socket or the server: a refused or a lost connection, 1040, 1226, an errno mysql2 has no name for, the query timeout of mysql2 `PROTOCOL_SEQUENCE_TIMEOUT` | a `code`, an `errno` or both | `interval`, the slow pace is over |

- **A timeout is not an answer.** `ETIMEDOUT` is the one code that keeps the
  slow pace. mysql2 ends a login with it after 10 seconds, so with a
  `timeout` above 10 seconds a refusal that is held back shows up as
  `ETIMEDOUT` and not as the timeout of the check.
- **An answered check ends it at once**, whatever the validators say: the
  server took that login.
- **A clear error ends it too.** A refused connection or 1040 says the node
  has another problem now, and such a node is worth asking every `interval`.
- **A timeout with no refusal before it is followed by `interval`**, as
  before. Only a refusal starts the slow pace.
- **The refusal has to be one this process saw.** The slow pace is kept in
  memory, per node, from `connect()` on. An app that starts, or calls
  `connect()`, while the server already holds its refusals back for longer
  than `timeout` sees timeouts only. It checks at `interval` until one
  refusal comes through.
- **An empty `checkError` keeps the slow pace, whoever made the error.**
  The rule reads the reduced error, so the error of mysql2 in the
  table that has no code counts as no answer, like the timeout of the
  check.
- **The state of the node is not touched by this.** A check that timed out
  counts toward `fall` and ends a run of passes like any failed check. Only
  the wait after it differs.
- **`connect()` starts with no slow pace.** A refusal from before a
  `disconnect()` does not slow the checks of the new `connect()` down.
- **The legacy check has no slow pace.**

#### Why the next check waits

Every check is a login. A check of a node that holds no check connection
opens one, and a check on the connection the node holds sends a change of
user, which the server answers as it answers a login. A server counts refused logins, and what it
counts them toward does not pass by asking again:

- MySQL 8.0.19 and later lock an account after `FAILED_LOGIN_ATTEMPTS`
  wrong passwords in a row, for `PASSWORD_LOCK_TIME` days or until someone
  unlocks it. A locked account answers with 3955. See
  [Failed-login tracking and temporary account locking](https://dev.mysql.com/doc/refman/8.0/en/password-management.html#failed-login-tracking).
  The example on that page prints `ERROR 3957`, while the error reference
  gives 3955 for this message.
- The MySQL connection control plugin delays the answer once an account
  failed more often in a row than its threshold, 3 by default. The delay
  starts at one second and grows by a second with each attempt, until a
  login passes. See
  [Connection control plugin installation](https://dev.mysql.com/doc/refman/8.0/en/connection-control-plugin-installation.html).
- MariaDB blocks a user after `max_password_errors` logins with a wrong
  password, until `FLUSH PRIVILEGES`. The message of 4150 is the one of
  such a block. See
  [`max_password_errors`](https://mariadb.com/docs/server/server-management/variables-and-modes/server-system-variables#max_password_errors).
- A host the server blocked after `max_connect_errors` broken connection
  attempts answers with 1129 until the host cache is flushed. See
  [DNS lookups and the host cache](https://dev.mysql.com/doc/refman/8.0/en/host-cache.html).

So a refused login is not worth repeating every few seconds: it will be
refused again, and with a wrong password each repeat is one more toward a
lock. The slow retry does not prevent a lock. It gives more time to act: a
limit of `N` wrong passwords is reached after `N - 1` minutes with the
default, where an interval of 5000 reaches it after `N - 1` times 5 seconds,
as long as only the check logs in. That holds also when the server answers
later and later, as the slow pace is kept over the checks that time out.

#### Logins in one hour

Measured with a fake clock in
[tests/pool/health-check.test.ts](../../tests/pool/health-check.test.ts). A
node passes the check of `connect()`, and from then on the server refuses
every login with 1045. The table counts the checks in the hour after the
first refused one. Each is one login at the server, as the pool holds no
connection to use again.

| Settings | Wait after a refused login, ms | Logins in that hour |
| --- | --- | --- |
| `healthCheck: {}` | 60000 | 60 |
| `healthCheck: { authRetryInterval: 300000 }` | 300000 | 12 |
| `healthCheck: { authRetryInterval: 5000 }` | 5000 | 720 |
| `healthCheck: {}`, and every refusal after the first comes later than `timeout` | 60000, after the 5000 of the timeout | 55 |
| Legacy, default settings | 10000, 7692, 5917, then 5000 | 718 |
| Legacy, range 15000 to 60000, multiplier 0.1 | 60000 | 60 |

- A failure that is no refusal is checked again every `interval`. Too many
  connections (1040) with `healthCheck: {}` is 720 checks in that hour, and
  so is a limit of the account (1226).
- `authRetryInterval: 100`, the lowest value the settings take, is 600
  logins in a minute, measured, which makes 36000 in an hour.
- An `interval` below 60000 changes none of the first three rows:
  `interval: 1000` with the default `authRetryInterval` is 60 as well. A
  longer `interval` is also the default `authRetryInterval`: with
  `interval: 90000` alone a refused login is followed by 90000.
- Only the checks are counted. Without `flags` in the settings each
  `connect()` logs in once more to read the server version, and a query the
  app sends to that node logs in too.

### Passive health

Not in 4.6.0 or earlier. A check sees a node once every `interval`. The
queries of the app see it all the time. With `passive: true`, the default of
the block, four kinds of error move the node between two checks. They are
the errors of a query, a transaction or a `getConnection()` of the app,
never those of a check.

1. **A connection was refused.** The node answered and said no. The node
   goes down at once, and a check starts at once. This is the only kind
   that takes a node down without a check.
2. **A connection was lost.** The node stays up, and a check starts at once.
   When that check fails the node goes down, whatever `fall` is. A lost
   connection alone never takes a node down.
3. **A connection was not there in time.** The connect timeout ran out. The
   node stays up and a check starts at once, as after a lost connection:
   nobody said the node is gone. That check asks on a new connection.
4. **No route led to the node.** This host, or a router on the path, said
   so. The node stays up and a check starts at once, as after a connect
   timeout: nobody asked the node. That check asks on a new connection too.

With `passive: false` only a check moves the node, as in the sections above.
A node of the legacy check has no passive health.

An error counts when all four hold:

- `fatal` is `true` on the error mysql2 handed out.
- Its `code` is in the table below.
- It has no `errno` of a server. Node gives an error of a socket a negative
  `errno`, and a server sends a positive one.
- Neither the package nor the app made it. The timeout around the change of
  database, `POOL_NOT_CONNECTED` and an error passed to `failWaiting()` are
  marked with `PoolStatus.ownError()` and never count.

| Kind | `code` | What happened |
| --- | --- | --- |
| Refused | `ECONNREFUSED` | Nothing listens on the port |
| No route | `EHOSTUNREACH` | No route to the host |
| | `ENETUNREACH` | No route to its network |
| Not there in time | `ETIMEDOUT` | No answer within the connect timeout of mysql2, 10 s, or within the one of the socket |
| Lost | `PROTOCOL_CONNECTION_LOST` | The socket closed, as mysql2 reports it |
| | `ECONNRESET` | The other side reset the connection |
| | `EPIPE` | A write to a connection the other side had closed |

The codes are fixed. An app cannot add or remove one. A name that does not
resolve is not among them, see [What never counts](#what-never-counts).

**The connect timeout is no proof that the node is gone.** The timer of
mysql2 covers the whole login, and mysql2 clears it when the login ended. A
timer that is due fires before the socket is read. So a process that stalls
for 10 s while a login is out gets `ETIMEDOUT`, `fatal: true`, from a node
that answered in time. That is why this error starts a check and does not
take the node down by itself: after such a stall the check passes, and the
node stays up.

**No route is no proof either.** `ENETUNREACH` is this host saying it has
no route to the network of the node, and `EHOSTUNREACH` is this host or a
router saying the same of the host. No packet reached the node, and the
connections the pool holds go on working. A route that is gone for a moment
is gone for every node behind it, so taking a node down for it would take
all of them down at once. The check that starts decides instead. It opens
a new connection, since the one the node holds says nothing about the
route, and it takes the node down when it fails there in any way but with
a missing route of its own.

**A check that finds no route itself is no proof either.** The check after
such a call opens a connection, and so does a check whose own connection
was lost. While the route is still gone it finds none, as the call did.
Such a check does not decide alone. It
counts toward `fall`, see
[A check that finds no route itself](#a-check-that-finds-no-route-itself).

The code alone does not decide the kind. The place does too:

| Where the error came | `ECONNREFUSED` | `EHOSTUNREACH`, `ENETUNREACH` | `ETIMEDOUT` | A code of the lost kind |
| --- | --- | --- | --- | --- |
| In place of a connection, while mysql2 opened a new one for the call | Refused: the node goes down, and a check starts | No route: a check starts and decides | Not there in time: a check starts and decides | Lost: a check starts and decides |
| On a connection the pool had handed to the call: at the change of user, under a query, at `COMMIT` or at `ROLLBACK` | Lost: a check starts and decides | Lost: a check starts and decides | Lost: a check starts and decides | Lost: a check starts and decides |

So an `ETIMEDOUT` of a socket under a running query is a lost connection,
and so is a new connection that the server resets during its login. A node
goes down without a check only when the connection never came and the code
says the node refused it. `Pool` knows the place: `query()` and
`multiStatementQuery()` fail without a connection in the first case and
with one in the second, and tell `PoolStatus.realFailure(error, opening)`
which it was. `getConnection()` only ever opens.

#### The check that starts at once

- **It takes the place of the check the timer was waiting for.** The next
  check comes `interval` after it ended. When the server refused its login
  the next check comes `authRetryInterval` later, and the slow pace of
  [a refusal](#a-login-or-account-refusal) holds from there as after any
  refused check, also over a check that then times out.
- **It is a check like any other.** It follows the four ways a check ends,
  sets `checkError`, emits `pool_check_failed` when it fails and is recorded
  in the metric. Passive health itself sets no `checkError`, emits no event
  and records no metric. A node it took down shows `isValid: false` and the
  `checkError` of its last check until the new check ended, which can be
  none.
- **One at a time.** While a check is out, no second one starts. The check
  that is out decides. After a lost connection, a connect timeout or a
  missing route it takes the node down when it fails, but for a check that
  finds no route itself, which has a section of its own below. The status
  counts the checks that are
  out: after a `connect()` on a cluster that is connected two are, the one
  of the timer and the one of that `connect()`, and none starts until both
  ended.
- **One between two checks of the timer.** After passive health started a
  check, it starts no other until the timer ran one. A connection lost in
  that time, a connect timeout or a missing route is kept, and the check of
  the timer takes the node down when it fails. A connection that is refused
  in that time still takes the node down at once. So passive health adds one check per `interval` at
  most. A node whose connections keep breaking is not logged in to at the
  pace of the queries that fail.
- **Not for a node that is down.** Its checks run at their own pace, and
  nothing the app runs into changes that. A node that was never up since
  `connect()` is down in this sense.
- **Never during the slow pace of a refused login.** A node the server
  refused is down, and it stays down until a check got its answer, which is
  also what ends the slow pace. So no error of a query of the app starts a
  login at a node that refuses logins, and the checks of such a node stay
  `authRetryInterval` apart. The suite walks 600 steps of failing calls,
  waits and reconnects and finds no node that is up while the slow pace
  holds.
- **Not after `disconnect()`.** A check that was about to start does not
  start, the result of one that is out is dropped, and a call that fails
  later changes nothing. A new `connect()` forgets a lost connection from
  before.
- **A pool at its limit does not make this check wait.** It asks on
  [the check connection](#the-check-connection), as every check of a node
  with the block does.

#### A check whose connection was lost

A balancer, a NAT or a firewall with an idle timeout forgets a flow and
tells neither side. A node that came back after a hard stop has forgotten
its flows too. mysql2 learns of it at its next write on that connection,
which is answered with a reset. The check connection can be in that state
on a node that is healthy, as every idle connection of the pool can.

So a check that fails with `PROTOCOL_CONNECTION_LOST`, `ECONNRESET` or
`EPIPE` on a connection the node held from before says nothing about the
node yet:

- **The check opens a new connection and asks again, once**, inside the
  same check and inside its `timeout`. No timer runs in between.
- **What it gets on the new connection is the result of the check.** A
  pass is a pass, and no check failed. A failure counts as any failed
  check: toward `fall`, or alone after a lost connection, a connect
  timeout or a missing route of the app. A refused login follows
  [its own rule](#a-login-or-account-refusal), and a new connection that
  finds no route counts toward `fall` only, see
  [A check that finds no route itself](#a-check-that-finds-no-route-itself).
- **Only a connection held from before is opened again.** A connection the
  check opened itself, because the node held none, cannot be a flow the
  path forgot, so a loss there is the result of the check. A node that
  resets every new connection gets one connection attempt per check, and
  two from the one check that still held a connection.
- **Every check, not only one that has to decide.** A check of the timer
  with no failed call of the app before it opens a new connection the same
  way.
- **One check to the app.** It emits `pool_check_failed` once at most,
  with the error of the new connection, sets `checkError` once and is one
  record of the health check metric. The loss of the old connection is one
  `debug` line with `pool` and `code`. In
  `mysql_dynamic_cluster.operation.duration` the two attempts are two
  records, the first with the code of the loss.
- **One check to the rules above.** The two connections are one check to
  "one at a time" and to "one between two checks of the timer".
- **Not after `disconnect()`.** A check that learns of the loss after it
  opens nothing.
- **The legacy check opens nothing again.** It asks through the pool, and a
  lost connection there is a failed check, as in 4.6.0.

**The check does not use up the forgotten connections of the pool.** It
asks on its own connection, so what the path forgot in the pool waits for
the queries of the app. Each such connection fails one attempt with
`ECONNRESET`, as in 4.6.0 and as with `passive: false`. No node goes down
for it: the first loss starts a check, which passes, and the losses after
it in the same `interval` are kept for the check of the timer, which
passes too. `cluster.query()` sends a query that failed to the next node,
where it can meet one more of them. An app behind such a path sets
`idleTimeout` below the idle timeout of the path, so the pool closes its
idle connections first, see [../configuration.md](../configuration.md).

Measured with the real mysql2 on the loopback interface of one Linux host,
behind a TCP proxy that forgets its flows, by a probe that is not part of
the suite: 3 runs of 12 s on each side. Two healthy nodes,
`connectionLimit: 10`, six idle connections in each pool that the proxy
forgot, three queries at once and then one every 100 ms through
`cluster.query()`.

| | A check that drew from the pool and ran again | Check connection |
| --- | --- | --- |
| Queries rejected | 3 of 122 or 123 | 6 of 123 |
| Nodes down | None | None |
| Flows the proxy reset, per node | 6 | 7: the six of the pool and the check connection |

The first column is the code as it was before the check connection, where
a check that had to decide ran again and met one forgotten connection of
the pool per run. That code was never released. A node behind a proxy that
resets every connection, old and new, was down after 46 to 57 ms and 13 resets there, and
is down after 18 to 28 ms and 4 resets with the check connection: the check lost the
connection it held and the one it opened then (3 runs on each
side).

The same is in
[tests/cluster/passive-health-loopback.test.ts](../../tests/cluster/passive-health-loopback.test.ts),
with the real mysql2 behind the same kind of proxy. Three queries at once
per node are rejected with `ECONNRESET`, the check that starts opens a new
connection for its own forgotten one and passes, and no node goes down.
The three forgotten connections that are left in a pool fail one query
each, and the queries after those pass. A node behind a proxy that resets
every connection is down after one check.

#### A check after a call that could open no connection

Passive health starts a check after a call of the app found no route or
ran into the connect timeout. The connection the node holds for its checks
was opened before that. It answers although no new connection reaches the
node: with a route that is gone for new connections only, or behind a
firewall that drops them. A check that asked there would pass, and the
node would stay up while every call that needs a connection fails on it.

So that check asks on a new connection:

- **It logs out of the connection the node holds and opens one.** The node
  then holds the new one, so it still holds one connection for its checks.
  A check that is still out on the old one gets its answer first. A
  connection that is still logging in is new already and is left: two
  checks that have to decide at once, as after a `connect()` on a cluster
  that is connected, ask on the same new one.
- **Only a check that has to decide after such a call does this.** A check
  after a lost connection asks on the connection the node holds, and opens
  a new one only when that one was lost as well, see above. A check of the
  timer with nothing to decide asks on the connection the node holds. The
  check of the timer that has to decide, for a call passive health held
  back, opens a new one like the check that starts at once.
- **What the new connection fails with is the result of the check**, by
  the rules there are. A missing route counts toward `fall` and does not
  decide alone, see the next section. No connection within `timeout`, a
  refused or a lost connection and a validator that says no take the node
  down with this check, and a refused login takes it down as a
  [refusal](#a-login-or-account-refusal). The check opens no second
  connection: it opened this one itself.
- **After a check that found no route the node holds no connection.** The
  next check opens one. While the route stays gone it finds none either,
  and the node goes down by `fall`: with the defaults one `interval` after
  the call. Once the route is back it passes, the node stays up and holds
  that connection.
- **A node with `passive: false` is told of no call.** Its checks ask on
  the connection the node holds, and it stays up for as long as that
  connection answers.
- **Each such check is one more login**, two per `interval` and node at
  most: the check passive health starts, and the check of the timer.

Pinned with a fake clock in
[tests/pool/passive-health.test.ts](../../tests/pool/passive-health.test.ts),
against a mysql2 the test drives in
[tests/pool/check-connection.test.ts](../../tests/pool/check-connection.test.ts),
and with the real mysql2 on loopback in
[tests/cluster/passive-health-loopback.test.ts](../../tests/cluster/passive-health-loopback.test.ts):
a route that is gone for new connections with pools that hold none, and a
path that swallows new connections while the open flows go on.

#### A check that finds no route itself

A check has to open a connection after a call that found no route or ran
into the connect timeout, when the node holds none, and when the one it
held was lost. While the route is gone it finds none, as the call of the
app did. It repeats what the
call said and adds nothing about the node. Were it to decide, a route that
is gone for 100 ms could take every node behind it down, which is what the
check was started to prevent. With `fall: 1` it still does: there every
failed check takes its node down.

So a check that has to decide, after a lost connection, a connect timeout
or a missing route, and itself fails with `EHOSTUNREACH` or `ENETUNREACH`
does not decide alone:

- **The node stays up, and the check counts toward `fall`** as any failed
  check. It takes the node down when it is the `fall`th failed check in a
  row, and the reason is then `fall`. With `fall: 1` that is this check.
- **It opens no further connection.** The next check is the one of the
  timer, `interval` later. Passive health starts none before it, as after
  any check it started.
- **What the call ran into is over with it.** The checks after it count as
  any check: with `fall: 3` the failed check after it leaves the node up. A
  call that fails later is kept again, and the next check then has to
  decide again.
- **The place does not matter.** The code counts whether the check got it
  in place of a connection or on the connection it held.
- **Every other failed check still decides alone.** After a missing route
  the node goes down with `passive_unreachable` when its check is refused a
  connection, gets none in time, runs into its `timeout` or loses the
  connection it opened. A refused login and a validator that says no
  follow their own rules.
- **It logs one `warn`** with the meta `pool`, `passive`, `code`,
  `checkCode`, `failedChecks` and `fall`. It has no `reason`, since the
  state of the node did not change. `passive` and `code` are the kind and
  the code of what the call ran into, `checkCode` is what the check failed
  with, and `failedChecks` is the count with this check. When this check is
  the `fall`th, the line comes ahead of the line of the `fall`. A check
  with nothing to decide does not log it. Neither does the check of a node
  that a refused connection took down in the meantime, nor a node with
  `passive: false`.
- **To the app it is a failed check.** It sets `checkError`, emits
  `pool_check_failed`, is recorded in the metric as `error` and logs the
  `error` line of a failed check.
- **Calls that go on failing reach `fall` sooner than the timer alone.**
  Passive health starts one check between two checks of the timer, and each
  of them counts. With `fall: 3` the checks come with the first call that
  fails, one `interval` later by the timer, and with the next call that
  fails after that. The node is down with the third.
- **Only a check that has to decide is meant.** A check with no failed call
  of the app before it that finds no route counts toward `fall` as any
  failed check, with a block and without, as in 4.6.0.

The price is a node that is gone together with its route. It leaves
rotation by `fall`, where a check that decides would take it out with the
call. With the defaults that is one `interval` after the first call:
5000 ms, against 9000 without passive health, in the table of
[Time to leave rotation once a call of the app fails](#time-to-leave-rotation-once-a-call-of-the-app-fails).
Once the route is back and the node still does not answer, the check gets
no answer on the connection it opens and decides.

**A route that stays gone for new connections takes the node out, also
while its pool holds connections that work.** After the first check that
found no route the node holds no connection for its checks, so every check
has to open one, and the `fall`th of them takes the node down. With one
node behind that route the others serve. With every node behind it no node
is left, and queries that an open connection of a pool could have served
are rejected with `There is no pool that satisfies the parameters`.

Measured with the real mysql2 on the loopback interface of one Linux host,
by a probe that is not part of the suite. Two healthy nodes addressed by
name, `healthCheck: {}`, `connectionLimit: 10`, four queries at once and
then one every 100 ms through `cluster.query()`. While the name resolves to
an address this host has no route to, a new connection ends with
`ENETUNREACH`, and the connections that are open go on working.

| New connections find no route | The pool of each node holds | Passive health | Queries rejected | Nodes down |
| --- | --- | --- | --- | --- |
| To both nodes, for 100 ms | One idle connection | On | 2 of 74 in each of 3 runs | None. One failed check per node, the first of `fall` 2 |
| To both nodes, for 100 ms | One idle connection | Off | 2 of 74, 1 run | None |
| To both nodes, for 100 ms | No connection | On | 4 of 73 or 74 in each of 3 runs | None. One failed check per node |
| To both nodes, for 100 ms | No connection | Off | 4 of 74, 1 run | None |
| To both nodes, for the 12 s of the run | One idle connection | On | 72 of 124 in each of 2 runs, 70 of them with no node left | Both, by `fall`, after about 5 s |
| To both nodes, for the 12 s of the run | One idle connection | Off | 2 of 124, 1 run | None |
| To both nodes, for the 12 s of the run | No connection | On | All 123 in each of 2 runs, 69 of them with no node left | Both, by `fall`, after about 5 s |
| To both nodes, for the 12 s of the run | No connection | Off | All 123, 1 run | None |
| To one node, for the 12 s of the run | One idle connection | On | 0 of 124 in each of 2 runs | That node, by `fall`, after about 5 s |
| To one node, for the 12 s of the run | No connection | On | 0 of 124 in each of 2 runs | That node, by `fall`, after about 5 s |
| To one node, for the 12 s of the run | No connection | Off | 0 of 124, 1 run | None |

- **A route that is gone for a moment takes no node down.** The check that
  starts finds none either, counts as the first of `fall`, and the check of
  the timer passes on a new connection.
- **With one node behind the missing route no query is lost**, with the
  rule and without. `cluster.query()` sends the query that failed there to
  the other node. With the rule the node is out of rotation after about
  5 s, and no query tries it from then on.
- **With every node behind it and pools that hold no connection every
  query is rejected**, with the rule and without: no new connection can be
  opened. With the rule both nodes are down after about 5 s, and the app
  gets `There is no pool that satisfies the parameters` from then on.
- **With every node behind it and one open connection in each pool the
  rule costs queries:** 72 of 124 against 2 of 124 with `passive: false`,
  where the check goes on asking on the connection the node holds. One
  query at a time needs no second connection, and those pools could have
  served it.

The code before the check connection, with a check through the pool, was
measured by the same probe. With the route gone to both nodes for 100 ms:
2 of 74 rejected and no node down, in 6 runs. For the 12 s of the run: 2 of
124 rejected in 4 runs, and one of the two nodes down by `fall` after about
5 s in each. With the route gone to one node: 0 of 124 in 4 runs, and that
node down after about 5 s in each. Its check drew an idle connection of the
pool when there was one and opened one when there was none. That code was
never released, and its check of `connect()` left one idle connection in
each pool, so the rows of a pool with no connection have no run of it.

The rules are tests in
[tests/cluster/passive-health-loopback.test.ts](../../tests/cluster/passive-health-loopback.test.ts).
A route that is gone for a moment leaves both nodes up. A route that stays
gone takes the node down by `fall`, with a pool that holds a connection and
with one that holds none. A route that is back for the next check leaves
the node up, with one connection for its checks.

#### Coming back

Only a check brings a node back. A node that passive health took down comes
back like a node a check took down: by `rise` passes in a row, or by its
first pass since `connect()`. The check that started at once is the first of
these passes when it passes. The passes the node had while it was up do not
count, and no query of the app that passes brings a node back.

With `rise: 1` that one check brings the node back in the same millisecond.
With the default of 2 the node is back one `interval` later, and with
`rise: 3` two intervals later.

A lost connection, or a connect timeout, whose check got its answer is
over. The node stays up,
the run of failures starts again as after any pass, and the next failed
check is the first of `fall`.

#### What never counts

| Error of a call of the app | Why it says nothing about the node |
| --- | --- |
| A deadlock or a Galera certification failure, 1213 | The node answered. See below |
| A lock wait timeout, 1205. A query the server stopped, 1317 or 3024 | The node answered |
| A syntax or constraint error | The query is wrong on every node |
| A name that does not resolve, `ENOTFOUND`. A resolver that does not answer, `EAI_AGAIN` | A name lookup is shared by every node the app addresses by name. A resolver that fails for a moment says nothing about one node, and the connections the pools hold keep working. Not counted at either place |
| `EADDRNOTAVAIL`, `ECONNABORTED`, `EHOSTDOWN`, `ENETDOWN` | Not among the codes above. The set is closed: a code of the network that is not named there changes nothing |
| A refused login: 1045 and the rest of the [refusal list](#a-login-or-account-refusal) | The node answered. mysql2 marks it `fatal` when it comes at the change of user that every query sends first, so `fatal` alone decides nothing. The next check gets the same answer and applies its own rule |
| Too many connections, 1040. An account at its limit, 1226. A node that is not ready, 1047 | The node answered. The check and the validators decide |
| The query timeout of mysql2, `PROTOCOL_SEQUENCE_TIMEOUT` | The app stopped waiting. A slow query is not a dead node, and the error is not `fatal` |
| `HANDSHAKE_NO_SSL_SUPPORT`, `HANDSHAKE_SSL_ERROR`, `AUTH_SWITCH_PLUGIN_ERROR`, `PROTOCOL_ERROR` | `fatal` in mysql2, but about the settings of the connection or one packet. A check that runs into the same error counts it toward `fall` |
| `Can't add new command when connection is in closed state` | `fatal`, with no code. The connection was closed on this side |
| `Pool is closed.`, `Queue limit reached.`, `No connections available.` | The pool of mysql2 said no, not the node |
| `POOL_NOT_CONNECTED`, the timeout of the package around the change of database, an error passed to `failWaiting()` | The package or the app made it, whatever `code` and `fatal` it carries |
| The abort of a `getConnection()` | The app gave the call up, whatever the reason of the signal reads like. A connection that then cannot be opened still counts, as the attempt was made |
| An error on a connection the app took with `getConnection()` | The app owns that connection. The package does not see what it runs into |

The status query of a check never counts either. A failed check has rules
of its own: `fall` and the refusal list. The check of a node with the block
asks on [the check connection](#the-check-connection) and never reaches
`realFailure()`. A query of the app with the same sql is a query of the
app: it goes through the pool. The check of a node without the block does
run through `Pool.query`, and passive health does nothing for such a node.
The login that
reads the server version at `connect()` is not told to passive health
either. The check of that `connect()` follows it at once.

The queries the cluster sends for itself, for cluster hashing and for the
service names, go through `cluster.query()` and count like those of the app.

**A deadlock is a reason to run the transaction again, not to leave the
node.** In a Galera cluster 1213 is also what a transaction gets when it
loses the certification against a write of another node. The MySQL manual
says about deadlocks: "Always be prepared to re-issue a transaction if it
fails due to deadlock. Deadlocks are not dangerous. Just try again."
([How to minimize and handle deadlocks](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlocks-handling.html)).
The same holds for the limits of a Galera cluster, see
[Percona XtraDB Cluster limitations](https://docs.percona.com/percona-xtradb-cluster/8.0/limitation.html).
`cluster.query()` already sends a failed query to the next node. An app
that runs a transaction on a connection of `getConnection()` runs it again
itself.

#### Time to leave rotation once a call of the app fails

Measured with a fake clock in
[tests/pool/passive-health.test.ts](../../tests/pool/passive-health.test.ts),
in ms from the call that failed until `isValid` is `false`. The node stops
right after a check that passed, and the call comes 1000 ms later.

| What the node does | `healthCheck: {}` | `healthCheck: { passive: false }` |
| --- | --- | --- |
| Refuses connections | 0 | 9000 |
| The same with `fall: 3` | 0 | 14000 |
| Drops the connection of the call, then refuses connections | 0, with one check | 9000 |
| Drops the connection of the call, then its checks hang | 5000, one `timeout` | 19000 |
| Drops every packet: the call ends with the connect timeout, then its checks hang | 5000, one `timeout` | 19000 |
| No route for the call, and none for the connection its checks have to open | 5000, by `fall` | 9000 |
| The same with `fall: 3` | 10000 | 14000 |
| No route for the call, then its checks get no answer on the connection they open | 5000, one `timeout` | 19000 |
| Resets every connection, old and new | 0, with one check | 9000 |

- Without passive health the node is out at the `fall`th failed check,
  wherever the calls of the app fall: 10000 ms after it stopped with the
  defaults, see
  [Time to leave rotation and to come back](#time-to-leave-rotation-and-to-come-back).
  Every call until then fails on that node first.
- With it a node that refuses connections is out with the first call that
  fails, before that call rejects. `cluster.query()` sends the same query to
  the next node, and no later call picks the node.
- A lost connection costs one check. That check ends at once when the node
  refuses connections, and after `timeout` when it hangs: 1000 with
  `timeout: 1000`, and 5000 with `fall: 3` as well.
- A missing route costs one check when the route is back and that check
  gets no answer on the connection it opens: the node is out after
  `timeout`. While the route is gone the check finds none either and does
  not decide alone, so the node is out at the `fall`th failed check: the check of the
  timer one `interval` after the call with the defaults, and one more
  `interval` later with `fall: 3`. In return a route that is gone for a
  moment takes no healthy node down.
- A node that resets every connection is out with one check, which loses
  the connection it held and the one it opens then: 0 ms on the fake
  clock. On loopback, with real resets, see
  [A check whose connection was lost](#a-check-whose-connection-was-lost).
- A node that drops every packet is not seen by passive health on its open
  connections: a query that hangs ends with the query timeout, which never
  counts. A call that has to open a new connection to such a node ends with
  `ETIMEDOUT` after the connect timeout of mysql2, 10 s. That starts a
  check, which hangs too, and the node is out one `timeout` after the call
  failed. The 10 s the call itself waited are not in the table. The checks
  of the timer need `fall * (interval + timeout)` from a check that passed,
  20000 with the defaults. So passive health gains little here: in one run
  on loopback the node was out 15 s after it fell silent, against 20 s with
  `passive: false`.
- Seen against the real mysql2 on the loopback interface, in
  [tests/cluster/passive-health-loopback.test.ts](../../tests/cluster/passive-health-loopback.test.ts):
  a server that takes no connection any more gives `ECONNREFUSED` with
  `fatal: true`, one that drops the connection under a query gives
  `PROTOCOL_CONNECTION_LOST` with `fatal: true`, and a write on a flow the
  path forgot gives `ECONNRESET` with `fatal: true`. A path that swallows
  every packet gives the `ETIMEDOUT` of mysql2 with `fatal: true`, and so
  does a process that sleeps past the connect timer while a login is out.
  The suite sets that timer to 300 ms where the pool is made. Two nodes
  addressed by a name that resolves, on command, to an address this host
  has no route to give `ENETUNREACH` with `fatal: true`: a call that finds
  no route leaves both nodes up, and so does a check that finds none
  either. With `fall: 3` a route that stays gone takes the node down with
  the third check that finds none. The suite lets the waits of the check
  timer run out at once for that, so no clock is in it. A node that says
  nothing once the route is back is down with `passive_unreachable` when
  its check runs into its `timeout`. With pools that hold no connection
  and `fall: 2`, a route that stays gone for new connections takes the
  node down with the second check, and a route that is back for that check
  leaves the node up with one connection. A path that swallows new
  connections and lets the open flows go on gives the call the connect
  timeout, and the node is down with `passive_timeout` when its check gets
  no connection within its `timeout`. The
  address is the limited broadcast address, which Linux
  refuses for a TCP connection before a packet leaves the host. `EPIPE` and
  `EHOSTUNREACH` were not produced there. They are rows of the suite with
  the fake clock only.

#### Where the rule comes from

- **HAProxy** has passive health as
  [`observe layer4`](https://docs.haproxy.org/3.2/configuration.html#5.2-observe):
  "only successful/unsuccessful tcp connections are significant". What an
  error does is set by
  [`on-error`](https://docs.haproxy.org/3.2/configuration.html#5.2-on-error).
  `mark-down` is "mark the server immediately down", which is what a
  refused connection does here. `sudden-death` is "simulate a pre-fatal
  failed health check, one more failed check will mark a server down",
  which is what a lost connection, a connect timeout and a missing route do
  here. HAProxy waits for
  [`error-limit`](https://docs.haproxy.org/3.2/configuration.html#5.2-error-limit)
  errors in a row, 10 by default. Here one is enough. There too only a
  check brings a server back.
- **ProxySQL** shuns a server after `mysql-shun_on_failures` connection
  errors in one second, see its
  [MySQL variables](https://proxysql.com/documentation/global-variables/mysql-variables/).
  Only connection errors count. Its source leaves out 1044, 1045, 1203,
  1226 and 3118, which are answers of the server.
- **mysql2** sets `fatal` on an error after which the connection cannot be
  used. That covers the errors of a socket, its connect timeout and a
  closed stream, but also every error of a change of user, the TLS and auth
  plugin errors of the handshake and a protocol error. So the lists above
  name the codes, and `fatal` is only one of four conditions. Read from
  `lib/base/connection.js` of mysql2 3.24.6. Its own `PoolCluster` counts
  failed `getConnection` calls only, never the error of a query.

### Time to leave rotation and to come back

Measured with a fake clock in
[tests/pool/health-check.test.ts](../../tests/pool/health-check.test.ts) and
[tests/pool/health-check-legacy.test.ts](../../tests/pool/health-check-legacy.test.ts),
in ms. A node leaves rotation when `isValid` turns `false`. The first two
rows are the longest it can take: the node stops right after a check that
passed. In the last two rows the node returns right after a check that
failed, or while a check hangs.

| | Legacy, default settings | Legacy, range 15000 to 60000, multiplier 0.1, `queryTimeout` 15000 | `healthCheck: {}` |
| --- | --- | --- | --- |
| Out, the node refuses connections | 26538 | 75000 | 10000 |
| Out, the checks of the node hang | 56538 | 105000 | 20000 |
| Back, the node answers again | 5000 | 60000 | 10000 |
| Back, a check was hanging as the node returned | 20000 | 75000 | 15000 |

- With the block a node is out after `fall` times `interval`, plus `fall`
  times `timeout` when its checks hang. It is back after `rise` times
  `interval`, plus one `timeout` when a check was hanging.
- The legacy defaults wait 15000 after a pass, then 11538 after the first
  failure. A check that hangs adds its 15000 each time.
- The legacy `Back` numbers are the wait the failures left the node with,
  then one pass. With the default settings that is 5000 once the node failed
  five checks in a row, and more before that: 11538 after the first failure.
  With the multiplier 0.1 of the second column one failed check sets the
  wait to the end of the range, 60000.
- With `rise: 2` a node comes back later than with the legacy defaults, 10000
  against 5000, because one answer is not enough. `rise: 1` gives 5000.
- More values of the block, measured the same way. Out: 5000 with `fall: 1`.
  9000 with `interval: 2000`, `timeout: 1000`, `fall: 3` and checks that
  hang. 30000 and 60000 with `interval: 15000`. 5001 when the node stops 1 ms
  before its check is due. Back: 5000 with `rise: 1`, 6000 with
  `interval: 2000` and `rise: 3`.
- The legacy values next to the block change none of these numbers.
- A node whose login is refused is out with the first refused check: 5000
  at most with the defaults, and the same with `fall: 3`. Once the login is
  put right it is back after `authRetryInterval`, plus `interval` for each
  further pass of `rise`: 65000 with the defaults, 60000 with `rise: 1`,
  24000 with `authRetryInterval: 20000`, `interval: 2000` and `rise: 3`.

### Where the pattern comes from

A fixed interval, a count of failed checks in a row before a server is down
and a count of passed ones before it is back is how HAProxy checks its
servers, with
[`inter`](https://docs.haproxy.org/3.2/configuration.html#5.2-inter),
[`fall`](https://docs.haproxy.org/3.2/configuration.html#5.2-fall) and
[`rise`](https://docs.haproxy.org/3.2/configuration.html#5.2-rise). There
too the interval is the timeout of a check unless one is set. HAProxy
defaults to 2000 ms, 3 and 2, the block to 5000 ms, 2 and 2.

## `PoolStatus` state

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

The public surface that `GaleraCluster` and `Pool` read from:

| Field | Kind | Source | Notes |
| --- | --- | --- | --- |
| `active` | `boolean` (mutable) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Set to `true` by `startTimerCheck()`, which `Pool.connect()` calls (see [pool.md](pool.md)), and to `false` by `Pool.disconnect()`. The first thing `checkStatus()` does is `if (!this.active) return`, so the poll is a no-op until `Pool.connect()` runs. |
| `availableConnectionCount` | `number` (getter) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Returns `Pool.availableConnectionCount`: `connectionLimit` minus connections in use, read from mysql2's own lists (see [pool.md](pool.md)). |
| `isValid` | `boolean` (getter over `_isValid`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Set by a check: from `Validator.check` in the legacy check, by [the rules of the block](#the-rules-of-a-healthcheck-block) for a node that has one. Initially `false` (the field default, re-asserted in the constructor): a pool that has never been polled is not yet routable. |
| `queryTime` | `number` (getter over `_queryTime`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Wall-clock duration in seconds of the most recent `SHOW GLOBAL STATUS`, measured via `QueryTimer`. Set after both the success and the error branches of `checkStatus`. |
| `loadScore` | `number` (getter over `_loadScore`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Sum from `LoadFactor.check`. **Initial value is `100000`** (set in the constructor at [PoolStatus.ts](../../src/pool/PoolStatus.ts), overriding the field's `= 0`). A pool that has never been polled sorts last in `_getActivePools` — see [cluster.md](cluster.md). |
| `checkError` | `INodeCheckError \| undefined` (getter over `_checkError`) | [PoolStatus.ts](../../src/pool/PoolStatus.ts) | Since 4.6.0. What the last check failed with, reduced to `code`, `errno` and `sqlState`. `undefined` before the first check and after a check whose query ran. A new object on every read. See [The error of the last check](#the-error-of-the-last-check). |

Private members worth knowing about:

- `_nextCheckTime: number = 10000` —
  [src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts). Initial
  delay before the first re-check; hard-coded, not configurable. Note
  that `10000` is outside the default `timerCheckRange` of
  `{start: 5000, end: 15000}`, but the first poll fires via
  `await status.checkStatus()` inside `Pool.connect()` (see
  [pool.md](pool.md)) — only the *next* check uses this number, by
  which time the clamp in `nextCheckStatus` has already brought it into range.
- `timerCheckRange: ITimerCheckRange` —
  [PoolStatus.ts](../../src/pool/PoolStatus.ts). Defaults
  `{start: 5000, end: 15000}` ms from the settings schema
  ([src/configs/schema.ts](../../src/configs/schema.ts)).
- `timerCheckMultiplier: number` —
  [PoolStatus.ts](../../src/pool/PoolStatus.ts). Default `1.3` from the
  schema
  ([src/configs/schema.ts](../../src/configs/schema.ts)).
- `_healthCheck?: IHealthCheck`:
  [PoolStatus.ts](../../src/pool/PoolStatus.ts). The `healthCheck` block
  of the node with every key, as `Settings.mixSettings` filled it. Not set
  for a node of the legacy check. See [Two modes](#two-modes).
- `_fall: number`: failed checks in a row that take the node down: `2` in
  the legacy check, `healthCheck.fall` with the block.
- `_passedChecks: number`, `_passedSinceStart: boolean`: the run of passes
  and the first pass since `connect()`. Only a node with the block reads
  them.
- `_refusals`: the errno list of
  [A login or account refusal](#a-login-or-account-refusal), static.
  `_refused()` looks the `errno` of `_checkError` up in it, and says no for
  a node of the legacy check.
- `_slowRetry: boolean`: whether the next check waits `authRetryInterval`.
  A refusal sets it, an answered check and `startTimerCheck()` clear it, and
  a failed check keeps it only when `_unanswered()` says that check got no
  answer: an empty `_checkError`, or the code `ETIMEDOUT`.
- For [passive health](#passive-health): `_refusedCode`,
  `_unreachableCodes`, `_timeoutCode` and `_lostCodes`, the codes of the
  four kinds, static.
  `_connectionFailure(error, opening)` says whether an error counts, as
  which kind, and with which code, read once. `realFailure(error, opening)`
  is what `Pool` calls. `_decides` is `'lost'`, `'timeout'` or `'unreachable'`
  from a lost connection, a connect timeout or a missing route until a
  check decided: one that got its
  answer, or one that failed. `_foundNoRoute()` says whether a
  failed check found no route itself and so does not decide alone, and
  `_logUndecided()` writes its line. `_checksOut` counts the checks of
  the current run that are out, and `stopTimerCheck()` sets it to 0.
  `_holdOff` counts the checks that have to start before passive health may
  start one again: it is set to 2, for the check it started and the next
  one of the timer.
- `_askNode()` sends the status query: through `Pool.query` for the legacy
  check, through `_askOnCheckConnection()` for a node with the block. That
  one reads `Pool.holdsCheckConnection` first, asks with
  `Pool.checkQuery()`, and asks once more on a new connection when the one
  the node held failed with a code of `_lostCodes`. Ahead of all that it
  calls `Pool.renewCheckConnection()` when `_decides` is `'unreachable'` or
  `'timeout'`.
- `_validator: Validator`, `_loadFactor: LoadFactor`, `_timer: Timer` —
  constructed once and reused for the lifetime of the pool
  ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).

## `checkStatus()`

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

Async, idempotent against the `active` flag. Sequence on every tick:

1. Start a `QueryTimer`.
2. Bail if `!this.active`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)) — covers the window
   between `disconnect()` setting `active = false` and the timer
   actually firing.
3. Ask the node with `_askNode()`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)). The legacy check runs
   `this._pool.query('SHOW GLOBAL STATUS;', { redis: false, timeout })`.
   `redis: false` is important: the status poll must never go through the
   Redis cache layer, or every pool would see the same cached snapshot. A
   node with a `healthCheck` block runs
   `this._pool.checkQuery('SHOW GLOBAL STATUS;')` on
   [the check connection](#the-check-connection), which has no cache and
   tells none of its errors to [passive health](#passive-health).
4. End the timer and store it as `_queryTime` so the
   `query_time` custom validator key (below) can read it.
5. `passed = this._validator.check(result)`. The legacy check sets
   `_isValid` to it here and logs its `debug` line `Is status ok in host`,
   as before. A node with a `healthCheck` block logs another `debug` line,
   with the meta `pool` and `passed`: what this check found, which is not
   always the state of that node. A node with a `healthCheck` block is set here only
   when the validators said no. Its pass counts after step 6, in
   `_upAfter(passed)`, so a check that throws in between brings no node up
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).
6. `this._loadScore = this._loadFactor.check(result)`
   ([PoolStatus.ts](../../src/pool/PoolStatus.ts)).
7. `this.nextCheckStatus()` schedules the next tick on success. With a
   `healthCheck` block the wait is `interval`, here and in the `catch`. The
   `catch` waits `authRetryInterval` while the slow pace of a refusal holds.

If any step throws, the `catch` branch
([PoolStatus.ts](../../src/pool/PoolStatus.ts)) logs, still records
`_queryTime` (so a hanging node's slow poll is visible), and calls
`nextCheckStatus(true)` to schedule a *faster* re-check.
Then it emits `pool_check_failed` with the error and the pool id, so the app can read the
error's `code` and `errno`; see [events.md](../events.md#a-failed-health-check).

Since 3.2.2 the `catch` also counts failures in a row (`_failedChecks`).
The **second** failed check in a row sets `_isValid = false`; a single
failure (network blip, proxy restart, DNS) keeps the last `isValid` so one
bad poll doesn't take the node out of rotation. A passing check resets the
counter and assigns `_isValid` from the validator again. Before 3.2.2 a
failed check never touched `_isValid`, so a node whose checks all failed
stayed in rotation. With a `healthCheck` block the count that takes the node
down is `fall`, kept as `_fall`, and a failed check also resets the run of
passes. A check the server refused does not wait for that count: `_refused()`
says so from the `errno` of the reduced error, and the node goes down with
that check.

Every check that ends is recorded as the metric
`mysql_dynamic_cluster.health_check.duration`, with the result `valid`,
`invalid` or `error`. `valid` and `invalid` are what the validators said in
this check, also for a node with a `healthCheck` block that passed and is
still down. Both branches record it as their last step. The
success branch does so after `nextCheckStatus()`. The `catch` branch does so
after the next check is set and `pool_check_failed` is emitted, in a
`finally`, so a step that throws there still leaves the check counted once.
Nothing a record does comes before what the check itself does. A check that
was dropped and a check that did not run record nothing. `isValid` and `loadScore` are also published, as the gauges
`mysql_dynamic_cluster.node.valid` and
`mysql_dynamic_cluster.node.load_score`. See
[metrics.md](./metrics.md#health-check-metric).

When every node is invalid, `GaleraCluster` throws
`"There is no pool that satisfies the parameters"` before the Redis cache
lookup — the reason one failed check isn't enough to drop a node.

The whole check has one timeout, `min(queryTimeout, timerCheckRange.end)`
(15 s with the defaults; `queryTimeout: 0` means no query timeout, so the
check then uses `timerCheckRange.end`). `checkStatus` races the status
query against that timer, so it also covers waiting for a free connection
(mysql2's `getConnection` queue has no timer) and a hung server. A check
slower than that counts as failed. The same value is also passed as the
query's own timeout, so a hung connection is destroyed.

For a node with a `healthCheck` block the timeout is `healthCheck.timeout`,
which is its `interval` when left out: 5 s with the defaults of the block.
`queryTimeout` and `timerCheckRange` have no part in it. The timer and the
race work the same, with three differences. The check asks on
[the check connection](#the-check-connection), so no wait for a connection
of the pool is in the race. No timeout is passed to the query: when the
timer fires the check waits one `setImmediate`, so an answer that is in the
socket by then wins, and then it drops the check connection and fails. And
a timer that fires after a `disconnect()` drops nothing, since the
connection would be the one of a later `connect()`.

A missing status key no longer throws: `Validator.check` logs the key by
name and that validator fails, so the pool is marked invalid (see
[known-issues.md#3](../known-issues.md#3-validatorcheck-crashes-on-missing-status-key)).

### The error of the last check

Since 4.6.0 `PoolStatus` keeps what the last check failed with, and
`checkError` hands it out. `GaleraCluster` reads it through
`Pool.checkError` for `nodes()`. The results of `ready` and `firstReady`
take the outcome of the check of their own connect instead, see below. The
contract is in [../node-api.md](../node-api.md#checkerror).

- The `catch` branch sets it, before it logs. The value is the error the
  status query was rejected with, reduced by `_reduce`: `code` when it is a
  string, `errno` when it is an integer, `sqlState` when it is a string.
  The message is never taken. The reduction is done once, at that moment,
  so a later change of the error object does not show.
- The success branch clears it as soon as the query ran, before the
  validators are asked. So it is cleared also when a validator then says no.
- A check that is dropped because it outlived `stopTimerCheck()` neither
  sets nor clears it.
- `stopTimerCheck()` does not clear it. It keeps its value over a
  `disconnect()`, as `isValid` does.

`checkStatus(outcome?)` also tells a caller how this one check ended. The
caller hands in an object. A check that is recorded, in either branch, sets
`recorded: true` on it, and the `catch` branch adds a copy of the reduced
error as `checkError`. A check that is dropped, and a call while the status
is not active, leave the object as it was. `Pool.connect()` passes the object
of its own caller through, so `GaleraCluster` can put the error of exactly
that check on a result of `ready` and `firstReady`. The timer calls
`checkStatus()` with no object.

Only values that mysql2, the socket or the server produced are kept. The
value is an empty object in these cases:

- The check ran into its own timer. That error has no code.
- The error was marked with `PoolStatus.ownError(error)`. `Pool` marks the
  errors it makes with a code of its own, `POOL_NOT_CONNECTED` and the
  `PROTOCOL_SEQUENCE_TIMEOUT` of its timer around the change of database,
  and the error the app passes to `failWaiting()`. The mark is kept in a
  `WeakSet`, so the error object is not changed and still has its code for
  every other caller.
- The error was thrown after the answer came, by the code that reads the
  answer. Only what the status query is rejected with is reduced.
- The error is not an object, or reading one of the three fields throws.

A check that times out ends by its own timer, not by the `timeout` option
of mysql2 that the status query is sent with. Both have the same length,
and the timer of the check is set first: mysql2 sets its timer only after
the connection was handed out and the database was changed, which is never
in the same turn. So a timed out check reports `{}`, not
`PROTOCOL_SEQUENCE_TIMEOUT`. The connect timeout of mysql2 is set when the
connection is made, before the timer of the check, and is 10 s. It ends the
check with `ETIMEDOUT` when the timer of the check is longer than that.

## Adaptive timer

[src/pool/PoolStatus.ts](../../src/pool/PoolStatus.ts).

This is the wait of the legacy check. For a node with a `healthCheck` block
`nextCheckStatus` starts the timer with `healthCheck.interval`, or with
`healthCheck.authRetryInterval` while the slow pace of a refusal holds, and returns
before any of the arithmetic below. `_nextCheckTime` is not touched then.

```text
nextCheckStatus(downgrade = false):
    if downgrade:  _nextCheckTime /= timerCheckMultiplier   // poll faster after error
    else:          _nextCheckTime *= timerCheckMultiplier   // back off after success
    _nextCheckTime = clamp(_nextCheckTime, range.start, range.end)
    _timer.start(_nextCheckTime)
```

Clamp via [`Utils.clamp`](../../src/utils/Utils.ts#L9):
`Math.min(Math.max(num, min), max)`. With the defaults
(`multiplier = 1.3`, `range = {start: 5000, end: 15000}`), successful
polls walk the interval up from 10000 ms toward 15000 ms in 1.3x steps
and saturate; an error one tick later drops the interval to
`15000 / 1.3 ≈ 11538` ms and continues divisions until it saturates at
5000 ms.

**Rationale:** a healthy node should be polled rarely (every 15 s); a
failing or flapping node should be polled aggressively (every 5 s) so
the cluster sees it recover (or stay broken) quickly. The feedback
loop is purely per-pool — there is no cross-pool coordination, no
exponential cap beyond the clamp, and no jitter.

`Timer` itself is a one-shot wrapper: `start(time)` calls `setTimeout`,
the callback fires once, and `checkStatus` is responsible for calling
`nextCheckStatus` again to re-arm. A second `start` replaces the pending
run, so there is never more than one. `dispose()` clears the pending
timeout and flips `_active = false` so `start()` becomes a no-op, until
`activate()` is called ([src/utils/Timer.ts](../../src/utils/Timer.ts)).
The `active` flag on `Timer` is **independent** of `PoolStatus.active` —
the former gates the timer, the latter gates `checkStatus` itself.

### Stop and start again

`Pool.disconnect()` calls `stopTimerCheck()`, and `Pool.connect()` calls
`startTimerCheck()` before its first check. That call sets `active` and
turns the timer on, so a pool that is connected again is checked again. Up to 4.4.0 the timer stayed off after the first
disconnect.

A check that is still running at `stopTimerCheck()` belongs to a
connection that is gone. When it ends it changes neither `isValid` nor the
failure count nor `checkError`, sets no timer, logs nothing and emits
nothing, also when the pool was connected again in the meantime.

A check may be rejected with anything. The log line of a failed check
prints the message of the error, its `code` when the message is empty, the
value itself when it is not an error, and `unreadable error` for a value
that cannot be turned into text. A dropped check and a restart are logged
at `debug`.

`disconnect()` does not reset `isValid`, the failure count or `checkError`.
They keep their last values until the first check of the next `connect()`
ends. For a node with a `healthCheck` block `isValid` and `checkError` are
kept the same way. Its two runs and the mark of the first pass are not:
`startTimerCheck()` sets them back, so the first pass of the new `connect()`
brings such a node up by itself, and a failed check from before the
`disconnect()` no longer counts.

## `Validator`

[src/pool/Validator.ts:12-102](../../src/pool/Validator.ts#L12).

Takes an array of `IValidatorParams` shaped as
`{ key: string, operator: '>' | '<' | '=' | 'Like', value: string | number }`.
`Validator.check(result)` walks the array; the pool is valid iff
**every** validator matches (`validateCount === this._validators.length`
on [:51](../../src/pool/Validator.ts#L51)).

### Custom keys

Three keys short-circuit the SQL lookup and instead read straight off
the `PoolStatus`
([src/pool/Validator.ts:33-43](../../src/pool/Validator.ts#L33)):

| Validator key | Source |
| --- | --- |
| `available_connection_count` | `PoolStatus.availableConnectionCount.toString()` |
| `query_time` | `PoolStatus.queryTime.toString()` (the poll's own wall-clock) |
| `active` | `PoolStatus.active.toString()` (`"true"` / `"false"`) |

Every other key is looked up by `Variable_name` in the
`SHOW GLOBAL STATUS` row set
([:45](../../src/pool/Validator.ts#L45)):
`result.find(res => res.Variable_name === validator.key)?.Value`. If the
key is missing (a typo, or a non-Galera server without `wsrep_*` rows),
`check` logs the key by name and counts that validator as failed. Before
3.2.2 this threw `TypeError` out of `check`; see
[known-issues.md#3](../known-issues.md#3-validatorcheck-crashes-on-missing-status-key).

`available_connection_count` is the real number of free slots
(`connectionLimit` minus connections in use). Before 3.2.2 it was a
counter that only grew, so thresholds like `> 50` always passed; re-tune
them when upgrading. With `connectionLimit: 0` (mysql2: no limit) it is
`Infinity`.

### Operator semantics

`checkValueIsValid`
([src/pool/Validator.ts:60-101](../../src/pool/Validator.ts#L60))
inspects the *value from the database* first:

- If `isNaN(+value)` (i.e. the value parses as a string):
  - `=` does strict `===` equality
    ([:66-69](../../src/pool/Validator.ts#L66)).
  - `Like` checks substring via `indexOf(...) >= 0`
    ([:70-73](../../src/pool/Validator.ts#L70)) — there is no SQL
    wildcard support; it is plain substring.
  - `<` and `>` on string values log
    `"Operator <op> doesn't support for another type except number"`
    and return `false`
    ([:74-76](../../src/pool/Validator.ts#L74)).
- Otherwise the value is numeric:
  - The validator's `value` is coerced with `+validator.value`. If the
    coercion yields `NaN`, an error is logged and the validator returns
    `false`
    ([:82-85](../../src/pool/Validator.ts#L82)).
  - `<`, `=`, `>` do the obvious numeric comparison
    ([:87-97](../../src/pool/Validator.ts#L87)). `Like` is not in the
    numeric switch, so a `Like` on a numeric column silently returns
    `false`.

### Defaults

The schema defaults exercise both modes
([src/configs/schema.ts](../../src/configs/schema.ts)):

- `{ key: 'wsrep_ready', operator: '=', value: 'ON' }` — string `=`.
- `{ key: 'wsrep_local_state_comment', operator: '=', value: 'Synced' }` — string `=`.
- `{ key: 'Threads_running', operator: '<', value: 50 }` — numeric `<`.

A pool that returns `wsrep_ready=OFF`, `wsrep_local_state_comment` not
exactly `Synced`, or `Threads_running >= 50` is removed from
rotation until the next successful poll, or until `rise` successful polls
in a row for a node with a `healthCheck` block.

## `LoadFactor`

[src/pool/LoadFactor.ts:11-38](../../src/pool/LoadFactor.ts#L11).

Takes an array of `ILoadFactorParams` shaped as
`{ key: string, multiplier: number }`. `LoadFactor.check(result)`
returns a single number — the score:

```text
score = 0
for each loadFactor:
    value = result.find(row.Variable_name == loadFactor.key).Value
    if isNaN(+value) or !value: log error, contribute 0
    else: score += (+value) * loadFactor.multiplier
return score
```

Source:
[src/pool/LoadFactor.ts:25-37](../../src/pool/LoadFactor.ts#L25).

There is no normalisation, no clamp, and no upper bound — the score is
just a weighted sum of MySQL counters. Defaults
([src/configs/schema.ts](../../src/configs/schema.ts)):

- `{ key: 'Connections', multiplier: 2 }` — cumulative connection
  count since the server started (monotonically increasing across
  uptime).
- `{ key: 'wsrep_local_recv_queue_avg', multiplier: 10 }` — Galera
  receive queue depth.

The `Connections` default is a *cumulative* counter, so `loadScore`
grows monotonically over the lifetime of the MySQL server even when
the actual load is flat. This is mainly a relative-comparison metric:
younger MySQL processes get less load until their counter catches up.

**Higher score ⇒ more loaded ⇒ sorted last** by
`GaleraCluster._getActivePools` (ascending sort by `loadScore`; see
[cluster.md](cluster.md)). The initial value of `100000` on a
never-polled pool is by design — it parks fresh pools at the back of
the rotation until at least one successful poll has produced a real
score.

### Crash on missing status key

`result.find(...).Value`
([src/pool/LoadFactor.ts:28](../../src/pool/LoadFactor.ts#L28)) is the
same unguarded dereference as `Validator`. A typo or a missing
status variable throws before the `isNaN(+value) || !value` check on
line 29 has a chance to run, aborting scoring for the affected pool
and falling into `checkStatus`'s catch branch — which means
`loadScore` stays at its previous value (or `100000` if no successful
poll has ever happened). See
[known-issues.md#4](../known-issues.md#4-loadfactorcheck-crashes-on-missing-status-key).
