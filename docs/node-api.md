# Node API

Added in 4.5.0. [`firstReady`](#firstready) and [`checkError`](#checkerror) were added in
4.6.0.

`cluster.query()` picks a node, runs one statement and gives the connection back. Some apps
need more than that. They hold a connection over several statements, choose the node
themselves, or want to know which nodes are up. Before 4.5.0 such an app had to reach into
`cluster.pools`, which is internal and can change in any release. These six members of
`GaleraCluster` are the supported way.

| Member | What it does |
| --- | --- |
| [`nodes()`](#nodes) | Lists the nodes with their id, validity, load score and the error of their last health check. |
| [`getConnection(options?)`](#getconnectionoptions) | Takes one connection of the best node. The caller owns it. |
| [`ready`](#ready) | Tells when every node finished its first connect, and how. |
| [`firstReady`](#firstready) | Tells when the first node passed its first connect. Added in 4.6.0. |
| [`getPoolStats()`](#getpoolstats) | Counts used, idle and waiting connections per node. |
| [`failWaiting(nodeId, error)`](#failwaitingnodeid-error) | Fails the requests that wait for a connection of one node. |

`query()`, `multiStatementQuery()` and the settings did not change. There is no new setting.

Source: [src/cluster/GaleraCluster.ts](../src/cluster/GaleraCluster.ts) and the members at the
end of [src/pool/Pool.ts](../src/pool/Pool.ts). The types are in
[src/types/NodeInterfaces.ts](../src/types/NodeInterfaces.ts) and the package exports them:

```ts
import type {
    IGetConnectionOptions, IClusterConnection, INodeInfo, INodePoolStats, INodeReadyResult,
    INodeCheckError
} from '@voicenter-team/mysql-dynamic-cluster';
```

## Node ids

Every member names a node by its id. Read the ids from `nodes()`, not from your settings.
A host with `id: 0` or with no `id` gets a generated one, so the id in the settings and the
id of the node can differ. The same id is the `poolId` of the events in
[events.md](./events.md).

## `nodes()`

```ts
nodes(): INodeInfo[]

interface INodeInfo {
    id: number; name: string; host: string; port: number; isValid: boolean; loadScore: number;
    checkError?: INodeCheckError
}
```

One entry per host of the settings, in the order of the settings. It works before `connect()`.

- `name` is the `name` of the host, or `host:port` when it has none.
- `isValid` is the result of the last health check. It is `false` before the first check.
  `disconnect()` does not clear it, so it can still be `true` for a node of a cluster that
  was disconnected.
- `loadScore` is the load the last health check computed. Lower is better. It is `100000`
  before the first check. See [health-and-scoring.md](./subsystems/health-and-scoring.md).
- `checkError` is there when the last health check did not get its answer. Added in 4.6.0.
  See [`checkError`](#checkerror).

Every call returns new plain objects. They are a snapshot. They do not change later, and
changing them changes nothing in the cluster.

## `getConnection(options?)`

```ts
getConnection(options?: IGetConnectionOptions): Promise<IClusterConnection>

interface IGetConnectionOptions { exclude?: number[] }
interface IClusterConnection { connection: PoolConnection; nodeId: number }
```

It takes one connection out of the pool of one node and hands it to you. `connection` is the
`PoolConnection` of mysql2 and `nodeId` is the node it belongs to.

### Which node

The cluster takes the nodes that are valid and not in `exclude`, and picks the one with the
lowest load score. `query()` filters and sorts its pools with the same code. Service hashing
plays no part here. There is no service, so no node is pinned.

Only `exclude` is read. A value passed as `options` that is not an object, such as the list
in `getConnection([2])`, is ignored with no error, and no node is left out.

It asks that one node once. It does not retry and it does not try a second node. To move on
to another node, call again with the failed node in `exclude`:

```ts
async function connectionOfAnyNode(cluster) {
    const exclude = [];
    for (;;) {
        try {
            return await cluster.getConnection({ exclude });
        } catch (error) {
            // no nodeId: no node is left, or exclude was wrong
            if (error.nodeId === undefined) throw error;
            exclude.push(error.nodeId);
        }
    }
}
```

### It waits without limit

When the node already has `connectionLimit` connections and all are in use, the request waits
in the queue of mysql2 until a connection is released. Nothing ends that wait. The cluster
sets no timeout and the package sets no queue limit. `getPoolStats()` shows such a request
as `pending`.

If you race the promise against your own timer, the request still waits in the queue after
your timer wins. When it gets its connection later, somebody has to release it:

```ts
async function connectionWithin(cluster, ms) {
    const request = cluster.getConnection();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('no connection in time')), ms);
    });
    try {
        return await Promise.race([request, timeout]);
    } catch (error) {
        // the request may still get a connection later. Give it back when it does
        request.then(({ connection }) => connection.release(), () => undefined);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
```

`failWaiting()` ends the wait of every request of a node at once.

### Errors

| Rejection | When |
| --- | --- |
| `Error` with `code: 'MDC_NO_NODE_AVAILABLE'` | No node is left: none is valid, or every valid node is in `exclude`. This is also the answer before `connect()`. |
| The error of mysql2, with `nodeId` added | The node gave no connection. It is the same object mysql2 made, so `code`, `errno` and `fatal` are as mysql2 set them. Examples: a refused login, a node that went down after its last check, `Pool is closed.` after `disconnect()`. |
| The error passed to `failWaiting()`, with `nodeId` added | The request waited and `failWaiting()` failed it. |
| `TypeError` | `exclude` is given and is not an array of numbers. No node is asked. |

An error that cannot take a new property, such as a frozen `Error` passed to
`failWaiting()`, is rejected as it is, without `nodeId`.

A node that fails here stays valid until its health check says otherwise. The next call
without `exclude` may pick it again.

### You own the connection

The cluster does nothing to the connection before it hands it over, and nothing after.

- No timeout. A statement you send has the timeout you give it, or none. `queryTimeout` of
  the settings is not applied.
- No database change. The cluster's own queries switch the database before every statement.
  This connection is on whatever database its last user left it on. Send `USE`, or put the
  database in front of the table name.
- No metric. Nothing you run on it shows in `mysql_dynamic_cluster.query.duration` or
  `mysql_dynamic_cluster.operation.duration`.
- No reset, neither on the way out nor on the way back.

The events `acquire`, `connection` and `release` fire for it as they do for the cluster's own
connections.

When you are done, give it back with `connection.release()`. If it is broken or you are not
sure what state it is in, call `connection.destroy()` instead. The pool then opens a new one
when it needs it. A connection you never give back counts against `connectionLimit` for good.
Hold all of them and the health check of that node waits in the queue too, times out, and
after two failed checks the node is no longer valid.

### Reset before you release

mysql2 does not reset a connection that is released into these pools. The package does not
set `resetOnRelease`, and the default of mysql2 is `false`. So reset the connection yourself
before you release it. If you do not, the session state you leave on it goes to the next user
of the pool: user variables, session settings, temporary tables, an open transaction and its
locks, the current database. The next user can be another `getConnection()` caller, or one of
the cluster's own queries.

The cluster's own queries start with a change-user command, which is how they switch the
database, and a MySQL server resets the session when it gets that command. Do not rely on it.
An open transaction keeps its locks until that command arrives, which can be much later on a
quiet pool. And another `getConnection()` caller gets the connection with no reset at all.

`connection.reset()` of mysql2 sends the reset command of the server. mysql2 states it needs
MySQL 5.7.3 or later.

```ts
const { connection } = await cluster.getConnection();
const db = connection.promise();
try {
    await db.query('START TRANSACTION');
    await db.query('UPDATE accounts SET balance = balance - 10 WHERE id = 1');
    await db.query('UPDATE accounts SET balance = balance + 10 WHERE id = 2');
    await db.query('COMMIT');
} catch (error) {
    // closing the connection makes the server drop the transaction
    connection.destroy();
    throw error;
}
// a connection that cannot be reset does not go back to the pool
connection.reset(error => error ? connection.destroy() : connection.release());
```

## `ready`

```ts
readonly ready: Promise<INodeReadyResult[]>

interface INodeReadyResult {
    nodeId: number; ok: boolean; error?: Error; checkError?: INodeCheckError
}
```

`await cluster.connect()` resolves when the first node is up. The other nodes may still be
connecting, or failing. `ready` tells you when all of them are done:

```ts
await cluster.connect();
const results = await cluster.ready;
const down = results.filter(result => !result.ok);
```

- It resolves once every pool finished the first connect of the current `connect()` call,
  pass or fail. There is one result per node, in the order of `nodes()`.
- It never rejects. A node that failed has `ok: false` and its `error`. It resolves also when
  every node failed and `connect()` itself rejected.
- `error` is what the connect of the pool failed with, mostly
  `pool in host <host> is not valid`. The reason behind it, such as a wrong password, is in
  `checkError` since 4.6.0. See [`checkError`](#checkerror). The whole error object comes
  with the `pool_check_failed` event. See [events.md](./events.md#a-failed-health-check).
- It is pending until `connect()` is called. The promise you read before the first
  `connect()` is the one that call resolves.
- Every later `connect()` call puts a new promise there. A promise of an earlier call still
  resolves with the results of its own call.
- `ok` is about that first connect only. For the state of a node now, read `nodes()`.

`connect()` behaves as before: it resolves on the first pool and rejects as it did. See
[subsystems/cluster.md](./subsystems/cluster.md#connect).

## `firstReady`

Added in 4.6.0.

```ts
readonly firstReady: Promise<INodeReadyResult[]>
```

`connect()` rejects as soon as the first node fails, even when another node passes a moment
later. `ready` waits for every node. `firstReady` is for an app that wants to start on the
first node that is up:

```ts
// connect() rejects when the first node that finishes has failed. That is not the end here
cluster.connect().catch(() => undefined);

const results = await cluster.firstReady;
if (!results.some(result => result.ok)) {
    // every node failed, and each result says why
    for (const { nodeId, error, checkError } of results) {
        console.error('node', nodeId, error.message, checkError);
    }
    throw new Error('no node is up');
}
// one node is up. cluster.ready tells when the others are done
```

- It resolves when the first node passes its first connect of the current `connect()` call.
  The array holds the results that are in by then, in the order of `nodes()`. At least one
  has `ok: true`. A node that still connects is not in the array.
- The array does not grow later. Read `ready` for the nodes that were not in.
- When no node passes, it resolves once the last one failed, with every result. That is the
  moment `ready` resolves, and the same results.
- It never rejects.
- It is pending until `connect()` is called. The promise you read before the first
  `connect()` is the one that call resolves. Every later `connect()` call puts a new promise
  there, as with `ready`.
- It resolves with `[]` for a cluster without hosts.
- `cluster.connected` is `true` when it resolves with a node that passed.
- It does not wait for the cluster hashing. With `useClusterHashing` on, `connect()` resolves
  after the hashing is set up, and `firstReady` can resolve before that. Queries work from
  then on. A service is pinned to its node once the hashing is up.

Each result carries the [`checkError`](#checkerror) of its node, if there is one.

## `checkError`

Added in 4.6.0.

```ts
interface INodeCheckError { code?: string; errno?: number; sqlState?: string }
```

The error of the last health check of a node, reduced to three fields. It is on every entry
of `nodes()` and on every result of `ready` and `firstReady`, when there is one. A refused
login looks like this:

```ts
{ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }
```

Before 4.6.0 that error only went to the log and to the `pool_check_failed` event.

### What it holds

- `code` only when the error had a string there, `errno` only when it had an integer,
  `sqlState` only when it had a string. A field the error did not have is left out.
- Never the message. The message of a refused login holds the user name.
- Only values that mysql2, the socket or the server produced. A failure the package makes
  itself gives an empty object, `{}`. No code of this package is ever put there, so no
  `MDC_*` code and no `POOL_NOT_CONNECTED`. The error an app passes to `failWaiting()` gives
  an empty object too, whatever code it has, when it fails a health check that waited.
- An error that has none of the three fields also gives `{}`.
- A new plain object on every read. Changing it changes nothing in the cluster.

It is filled the same way with and without `flags` in the settings. Without `flags` the
pool first logs in once to read the server version. When that login is refused the pool is
still created, its first check fails, and that check sets `checkError`.

### When it is set and cleared

- It is set when a health check did not get its answer: the status query was rejected, or
  the check timed out. Every failed check sets it again, with the error of that check.
- It is cleared by the next check whose query ran, whatever the validators then say.
- So a node that is **not valid and has no `checkError`** is a node the server answered for,
  and a validator said no. For example the node is not `Synced`. The only other case is a
  node whose first check has not ended yet.
- One failed check does not take a valid node out, the second in a row does. So a node can
  be valid and have a `checkError` for one check interval.
- `disconnect()` does not clear it, as it does not clear `isValid`. After `disconnect()`,
  `nodes()` still shows the error of the last check. A later `connect()` keeps it until its
  first check ends. That check sets it or clears it.

### How old it is

On `nodes()` it is the error of the last check, not of this moment. A node is checked every
`timerCheckRange.start` to `timerCheckRange.end` ms, 5 to 15 seconds with the defaults, so
the value can be up to one check interval old, plus the time the check itself takes.

On a result of `ready` or `firstReady` it is read once, when the connect of that node
settled. It does not change later. For the state of a node now, read `nodes()`.

### On a result

- A result with `ok: false` and a `checkError` with a `code`: the check of that connect
  failed with that code.
- A result with `ok: false` and no `checkError`: the server answered and a validator said no.
- A result with `checkError: {}`: the check failed with nothing from mysql2, the socket or
  the server to report. Mostly the timer of the check ran out. A result with `ok: false`
  also has `checkError: {}` when `disconnect()` or another `connect()` was called while the
  node connected. Then the connect was given up and the server refused nothing.
- A result with `ok: true` has no `checkError`, with one exception. A node that was valid
  before a `disconnect()` keeps `isValid` over one failed check, so its next connect can pass
  though its first check failed. That result has `ok: true` and the `checkError` of the
  check.

### What a timeout gives

| What ran out | `checkError` | Made by |
| --- | --- | --- |
| The timer of the check itself, `min(queryTimeout, timerCheckRange.end)`, 15 s with the defaults. It ends a check that waits for a free connection, for the change of database or for the answer to the status query. It also ends a check that waits for a new connection when that timer is shorter than 10 s. | `{}` | the package |
| The connect timeout of mysql2, 10 s. A new connection got no greeting, or no answer to its login. It ends the check when the timer of the check is longer than 10 s, as with the defaults. | `{ code: 'ETIMEDOUT' }`, with no `errno` | mysql2 |
| A connect timeout of the operating system. | `{ code: 'ETIMEDOUT', errno: -110 }`. The number depends on the platform. | the socket |
| A timeout of the server, or of a proxy in between, that closes the connection while the check uses it. | `{ code: 'PROTOCOL_CONNECTION_LOST' }` | mysql2 |

`PROTOCOL_SEQUENCE_TIMEOUT` is the code mysql2 has for the `timeout` option of a query. The
status query is sent with that option. A check that times out still does not report the
code: the timer of the check has the same length and is set first, so it ends the check
first, with `{}`. A check would report `PROTOCOL_SEQUENCE_TIMEOUT` only if mysql2 handed it
that error before the check's own timer ran out.

### A code is not always a refused login

Every `code` comes from mysql2, the socket or the server, never from this package. That
does not make every `code` a wrong user or password. Do not treat a code you do not know as
a refused login. These are common, and none of them is one:

| `code` | What it means | Made by |
| --- | --- | --- |
| `PROTOCOL_CONNECTION_LOST` | The server, or a proxy in between, closed the connection. | mysql2 |
| `ETIMEDOUT` | The node did not answer in time. See the table above. | mysql2 or the socket |
| `ECONNREFUSED` | Nothing listens on that host and port. `errno` is `-111` on Linux. | the socket |
| `ECONNRESET`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN` | Other network and name lookup failures. | the socket |
| `ER_CON_COUNT_ERROR` (`errno` 1040) | The server has too many connections. | the server |
| `ER_BAD_DB_ERROR` (`errno` 1049) | The `database` of the settings does not exist on that node. | the server |

A refused login is `ER_ACCESS_DENIED_ERROR` with `errno` 1045 and `sqlState` `'28000'`.

```ts
const results = await cluster.ready;
const wrongLogin = results.filter(result => result.checkError?.errno === 1045);
const notListening = results.filter(result => result.checkError?.code === 'ECONNREFUSED');
```

## `getPoolStats()`

```ts
getPoolStats(): INodePoolStats[]

interface INodePoolStats {
    nodeId: number; used: number; idle: number; pending: number; limit: number
}
```

One entry per node, in the order of `nodes()`. The counts are read from the lists mysql2
keeps, at the moment of the call.

- `used` is every connection of the pool minus the free ones. A connection that still logs in
  counts as used.
- `idle` is the free connections: open, and nobody uses them.
- `pending` is the requests that wait for a connection.
- `limit` is the `connectionLimit` of the node. `0` means no limit, as in mysql2.

`used`, `idle` and `pending` are `0` while the mysql2 pool of the node does not exist, which
is before `connect()`. `limit` is set from the start.

After `disconnect()` the closed mysql2 pool still exists. `getPoolStats()` keeps the counts
that pool had when it was closed, and they do not go back to `0`. A connection the app held
at that moment stays counted as `used`.

## `failWaiting(nodeId, error)`

```ts
failWaiting(nodeId: number, error: Error): number
```

It fails every request that waits in the queue of that node's mysql2 pool, with `error`, and
returns how many it failed. It is synchronous. The callbacks of the waiting requests have run
by the time it returns.

Use it when you know a node is in trouble and do not want requests to sit behind it:

```ts
// the app learned that node 2 is being drained
const failed = cluster.failWaiting(2, new Error('node 2 is being drained'));
```

What it touches and what it does not:

- It fails waiting `getConnection()` calls. They reject with `error`, plus `nodeId`.
- It also fails the cluster's own queries that wait on that node. `cluster.query()` then
  retries on another node, as it does after any failed attempt, within `maxRetry` and the
  valid nodes that are left. A health check that waits is failed too and counts as a failed
  check.
- Connections in use are left alone. So are logins that are still running.
- The node stays in the cluster, and the call does not set `isValid`. It can still cost the
  node its validity through a health check. A check that waits is failed with the others
  and counts as a failed check, and the second failed check in a row marks the node not
  valid. A check waits when every connection of the node is in use, so this is the case of a
  full pool. Two calls that each catch a waiting check take the node out.
- A request that comes after the call waits again. A callback that asks for a connection
  again while it is being failed is not failed in the same call.

It returns `0` for a node id that does not exist and for a node whose pool is not created
yet. It throws a `TypeError` when `error` is not an `Error`. A waiting request that is called
back without an error would take its missing connection for a real one.
