# Node API

Added in 4.5.0.

`cluster.query()` picks a node, runs one statement and gives the connection back. Some apps
need more than that. They hold a connection over several statements, choose the node
themselves, or want to know which nodes are up. Before 4.5.0 such an app had to reach into
`cluster.pools`, which is internal and can change in any release. These five members of
`GaleraCluster` are the supported way.

| Member | What it does |
| --- | --- |
| [`nodes()`](#nodes) | Lists the nodes with their id, validity and load score. |
| [`getConnection(options?)`](#getconnectionoptions) | Takes one connection of the best node. The caller owns it. |
| [`ready`](#ready) | Tells when every node finished its first connect, and how. |
| [`getPoolStats()`](#getpoolstats) | Counts used, idle and waiting connections per node. |
| [`failWaiting(nodeId, error)`](#failwaitingnodeid-error) | Fails the requests that wait for a connection of one node. |

`query()`, `multiStatementQuery()` and the settings did not change. There is no new setting.

Source: [src/cluster/GaleraCluster.ts](../src/cluster/GaleraCluster.ts) and the last three
methods of [src/pool/Pool.ts](../src/pool/Pool.ts). The types are in
[src/types/NodeInterfaces.ts](../src/types/NodeInterfaces.ts) and the package exports them:

```ts
import type {
    IGetConnectionOptions, IClusterConnection, INodeInfo, INodePoolStats, INodeReadyResult
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
    id: number; name: string; host: string; port: number; isValid: boolean; loadScore: number
}
```

One entry per host of the settings, in the order of the settings. It works before `connect()`.

- `name` is the `name` of the host, or `host:port` when it has none.
- `isValid` is the result of the last health check. It is `false` before the first check.
- `loadScore` is the load the last health check computed. Lower is better. It is `100000`
  before the first check. See [health-and-scoring.md](./subsystems/health-and-scoring.md).

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
const { connection, nodeId } = await cluster.getConnection();
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

interface INodeReadyResult { nodeId: number; ok: boolean; error?: Error }
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
  `pool in host <host> is not valid`. The reason behind it, such as a wrong password, comes
  with the `pool_check_failed` event. See [events.md](./events.md#a-failed-health-check).
- It is pending until `connect()` is called. The promise you read before the first
  `connect()` is the one that call resolves.
- Every later `connect()` call puts a new promise there. A promise of an earlier call still
  resolves with the results of its own call.
- `ok` is about that first connect only. For the state of a node now, read `nodes()`.

`connect()` behaves as before: it resolves on the first pool and rejects as it did. See
[subsystems/cluster.md](./subsystems/cluster.md#connect).

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
- The node stays in the cluster and stays valid. A request that comes after the call waits
  again. A callback that asks for a connection again while it is being failed is not failed
  in the same call.

It returns `0` for a node id that does not exist and for a node whose pool is not created
yet. It throws a `TypeError` when `error` is not an `Error`. A waiting request that is called
back without an error would take its missing connection for a real one.
