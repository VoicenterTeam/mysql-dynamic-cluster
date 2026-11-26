# Node API

`cluster.query()` picks a node, runs one statement and gives the connection back. Some apps
need more than that. They hold a connection over several statements, choose the node
themselves, or want to know which nodes are up. Before this API such an app had to reach into
`cluster.pools`, which is internal and can change in any release. These six members of
`GaleraCluster` are the supported way.

| Member | What it does |
| --- | --- |
| [`nodes()`](#nodes) | Lists the nodes with their id, validity, load score and the error of their last health check. |
| [`getConnection(options?)`](#getconnectionoptions) | Takes one connection of the best node, probed when it was idle. The cluster resets it at `release()`. |
| [`ready`](#ready) | Tells when every node finished its first connect, and how. |
| [`firstReady`](#firstready) | Tells when the first node passed its first connect. |
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
  For a node with a `healthCheck` block it is the state the checks left the node in: down
  after `fall` failed checks in a row, back after `rise` passed ones. See
  [health-and-scoring.md](./subsystems/health-and-scoring.md#two-modes).
  `disconnect()` does not clear it, so it can still be `true` for a node of a cluster that
  was disconnected.
- `loadScore` is the load the last health check computed. Lower is better. It is `100000`
  before the first check. See [health-and-scoring.md](./subsystems/health-and-scoring.md).
- `checkError` is there when the last health check did not get its answer.
  See [`checkError`](#checkerror).

Every call returns new plain objects. They are a snapshot. They do not change later, and
changing them changes nothing in the cluster.

## `getConnection(options?)`

```ts
getConnection(options?: IGetConnectionOptions): Promise<IClusterConnection>

interface IGetConnectionOptions { exclude?: number[]; signal?: AbortSignal }
interface IClusterConnection { connection: PoolConnection; nodeId: number }
```

It takes one connection out of the pool of one node and hands it to you. `connection` is the
`PoolConnection` of mysql2 and `nodeId` is the node it belongs to.

`exclude` leaves nodes out, see [Which node](#which-node). `signal` ends the wait for the
connection, see [Give up the wait with a signal](#give-up-the-wait-with-a-signal).

### Which node

The cluster takes the nodes that are valid and not in `exclude`, and picks the one with the
lowest load score. `query()` filters and sorts its pools with the same code. Service hashing
plays no part here. There is no service, so no node is pinned.

Only `exclude` and `signal` are read. A value passed as `options` that is not an object, such
as the list in `getConnection([2])`, is ignored with no error, and no node is left out.

It asks that one node once. It does not retry and it does not try a second node. To move on
to another node, call again with the failed node in `exclude`:

```ts
async function connectionOfAnyNode(cluster) {
    const exclude = [];
    for (;;) {
        try {
            return await cluster.getConnection({ exclude });
        } catch (error) {
            // no nodeId: no node is left, an option was wrong, or the signal ended the call
            if (error.nodeId === undefined) throw error;
            exclude.push(error.nodeId);
        }
    }
}
```

### It waits without limit

When the node already has `connectionLimit` connections and all are in use, the request waits
in the queue of mysql2 until a connection is released. While the node is up nothing ends that
wait by itself. The cluster sets no timeout and the package sets no queue limit.
`getPoolStats()` shows such a request as `pending`. When the node goes down the request fails
with `MDC_NODE_DOWN`, since 4.2.0, see [Errors](#errors).

A [`signal`](#give-up-the-wait-with-a-signal) ends the wait of one call and takes its
request out of the queue. That is the way to put a time limit on the call.

If you race the promise against your own timer instead, the request still waits in the queue
after your timer wins. When it gets its connection later, somebody has to release it:

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

### Give up the wait with a signal

Pass the `signal` of an `AbortController` and call `abort()` when you no longer want the
connection:

```ts
async function connectionWithin(cluster, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('no connection in time')), ms);
    try {
        return await cluster.getConnection({ signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
```

`cluster.getConnection({ signal: AbortSignal.timeout(ms) })` does the same in one line, on a
Node that has `AbortSignal.timeout`. The call then rejects with the `TimeoutError` Node puts
on that signal.

A call without `signal` behaves as before. With one, what happens depends on when the signal
aborts:

| The signal aborts | What happens |
| --- | --- |
| Before the call | The promise rejects with the reason. No node is asked and nothing is queued. This comes before the search for a node, so it is the answer also when no node is valid. |
| While the request waits in the queue of the node | The promise rejects with the reason at that moment. The request is taken out of the queue, so `getPoolStats()` shows one `pending` less right away. |
| While a new connection for the call logs in | The promise rejects with the reason at that moment. The login goes on. When the connection arrives the package releases it to the pool, where it is `idle` for the next caller. If the login fails instead, nobody is told. |
| While the connection answers its [probe](#the-probe-on-the-way-out) | The promise rejects with the reason at that moment. The connection is destroyed: its ping may still be out. |
| After the promise resolved | Nothing. You have the connection and you release it. |
| After the promise rejected | Nothing. The first rejection stays. |

The other requests that wait for the node keep their place and their order.

The call settles once, and what comes first wins. A call that an error of the node or
`failWaiting()` rejected first keeps that error, with its `nodeId`. A call that the signal
ended first keeps the reason. A later `failWaiting()` does not find it and does not count it.

#### The reason

The promise rejects with `signal.reason`, the value you passed to `abort()`. It is the same
value, not a copy. The package does not wrap it, adds no `nodeId` to it and does not change it.

- `abort()` without a value: Node puts a `DOMException` with the name `AbortError` on the
  signal, and that is what the call rejects with.
- `AbortSignal.timeout()`: a `DOMException` with the name `TimeoutError`.
- A signal without a `reason`, as on an old Node that has no `signal.reason` yet and with
  some polyfills: the call rejects with an `Error` made by the package. It has the three
  marks of the `AbortError` of Node itself: the `name` `AbortError`, the `code` `ABORT_ERR`
  and the message `The operation was aborted`.

To tell an abort without a reason from any other rejection, test `error.name === 'AbortError'`.
It is the one test that holds on both paths. The `DOMException` of a current Node has the
`code` `20`, not `ABORT_ERR`, and its own message.

Pass an `Error` as the reason. Any value is passed through, also `null` or a string, and code
that reads `error.nodeId` or `error.code` of a rejection then has to cope with it. An `Error`
reason has no `nodeId`, so the loop in [Which node](#which-node) stops on it and throws it.

#### What counts as a signal

`undefined` and `null` both mean no signal. Any other value has to have a boolean `aborted`
and the functions `addEventListener` and `removeEventListener`. The package does not ask for
the `AbortSignal` class of the running Node. So the signal of a polyfill is taken, and so is
one made in another realm, such as a vm context. Anything else rejects with a `TypeError` and
asks no node.

A wrong `exclude` and a wrong `signal` are both reported before the signal is read. So a call
with a wrong `exclude` and an aborted signal rejects with the `TypeError` about `exclude`.

#### The listener

The package puts one `abort` listener on the signal while the call waits, and takes it off
when the call settles: resolved, rejected by an error, rejected by the abort or rejected by
`failWaiting()`. A call that asks no node adds none. So one long-lived signal can be passed
to any number of calls and does not collect listeners.

The listener runs inside your `abort()` call. It throws nothing into it.

#### When the request cannot be taken out of the queue

Taking one request out of the queue reaches into mysql2, which has no call for it. Two cases
are known where the package cannot do it:

- Something wraps the request on its way into the queue, so the package cannot tell which
  entry is its own. mysql2 does that itself while a subscriber listens on its tracing channel
  `mysql2:pool:connect`. A tracing library that patches the pool of mysql2 would have the
  same effect.
- A mysql2 whose queue is not the one mysql2 3 keeps. The package then logs one line at
  `warn` for the mysql2 pool of the node, with `nodeId` and `pool`, at the first abort that
  runs into it. It is logged once for that pool, not once for every call. A later `connect()`
  makes a new mysql2 pool, which gets a line of its own.

The first case is not logged. The package cannot tell a wrapped request in the queue from a
request whose connection still logs in.

The promise still rejects with the reason at the abort. Only the queue is slower to follow:
the request keeps its place and still counts as `pending`. When its turn comes, the package
releases the connection at once and the next waiter gets it. No connection is lost. A
`failWaiting()` in between counts that request, though its call already ended.

### Errors

| Rejection | When |
| --- | --- |
| `Error` with `code: 'MDC_NO_NODE_AVAILABLE'` | No node is left: none is valid, or every valid node is in `exclude`. This is also the answer before `connect()`. |
| The error of mysql2, with `nodeId` added | The node gave no connection. It is the same object mysql2 made, so `code`, `errno` and `fatal` are as mysql2 set them. Examples: a refused login, a node that went down after its last check, `Pool is closed.` after `disconnect()`. Also the error of the last [probe](#the-probe-on-the-way-out) when `connectionLimit + 1` connections in a row failed theirs, `Probe timeout` with `code: 'PROTOCOL_SEQUENCE_TIMEOUT'` for one that got no answer. |
| The error passed to `failWaiting()`, with `nodeId` added | The request waited and `failWaiting()` failed it. |
| `Error` with `code: 'MDC_NODE_DOWN'`, `sent: false` and `nodeId` | The request waited in the queue of the node, and the node went down. The message names the host and the port: `The node <host>:<port> went down while the request waited for a connection`. Each call gets an error of its own. Since 4.2.0, see [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#a-node-that-goes-down-fails-the-requests-that-wait). |
| The reason of the `signal`, as it is, with no `nodeId` | The signal was aborted before the call, or it aborted while the call waited. See [The reason](#the-reason). |
| `TypeError` | `exclude` is given and is not an array of numbers. No node is asked. |
| `TypeError` with the message `getConnection: options.signal must be an AbortSignal` | `signal` is given and is not a signal. No node is asked. See [What counts as a signal](#what-counts-as-a-signal). |

An error that cannot take a new property, such as a frozen `Error` passed to
`failWaiting()`, is rejected as it is, without `nodeId`.

A node that fails here stays valid until its health check says otherwise. The next call
without `exclude` may pick it again.

A node with a `healthCheck` block is the exception, unless its `passive` is `false`. When
the node gave no connection because it refused one, with `fatal: true` and the `code`
`ECONNREFUSED`, the node is not valid any more by the time the call rejects, and the next
call picks another node. The rejection itself is the same. A connect timeout, `ETIMEDOUT`,
and a missing route, `EHOSTUNREACH` or `ENETUNREACH`, leave the node valid and start a
health check at once, which takes the node out when it fails. A check that finds no route
itself counts toward `fall` and takes no node out alone. A refused login does neither,
nor does a name that does not resolve, an error passed to `failWaiting()`, `MDC_NODE_DOWN` or
the abort of a signal. A connection the node refuses after the signal ended the call still
takes the node down. The package does not see what happens on a
connection after it handed it to you. See
[passive health](subsystems/health-and-scoring.md#passive-health).

### What the cluster does with the connection

The connection goes through the same steps as one of the cluster's own queries
(#93): a probe on the way out, and a reset when it comes back. There is no option to skip
either.

- A probe when it was idle, see [The probe on the way out](#the-probe-on-the-way-out).
- A reset at `release()`, see [The reset at release()](#the-reset-at-release).
- Packets out of order end it, see [Packets out of order](#packets-out-of-order).
- No timeout. A statement you send has the timeout you give it, or none. `queryTimeout` of
  the settings is not applied.
- No database change. This connection is on whatever database its last user left it on.
  Send `USE`, or put the database in front of the table name. The cluster's own
  queries send `USE` only when a connection is on another database than the one they need.
- No metric. Nothing you run on it shows in `mysql_dynamic_cluster.query.duration` or
  `mysql_dynamic_cluster.operation.duration`. The connection itself counts as `used` in
  `mysql_dynamic_cluster.connection.count` while you hold it, and until its reset is answered.

The events `acquire`, `connection` and `release` fire for it as they do for the cluster's own
connections.

When you are done, give it back with `connection.release()`. If it is broken, you can call
`connection.destroy()` instead. The pool then opens a new one when it needs it. A connection
you never give back counts against `connectionLimit` for good.
Hold all of them and the health check of that node waits in the queue too, times out, and
after two failed checks the node is no longer valid. That is the legacy check. A node with a
`healthCheck` block is checked on a connection of its own and stays valid, while the
requests of the app go on waiting.

#### The probe on the way out

A connection that was idle in the pool longer than `probeIdle` (1000 ms by default) answers
a ping before you get it. On a node with a `healthCheck` block the idle connections get a
ping every `idleCheckInterval`, and an answered one counts as well: the time runs from the
later of the release and that answer. When such a ping is still out, the cluster waits for
its answer, within `probeTimeout`, instead of sending a second one, also on a connection
used within `probeIdle`. A connection
that answers in time is yours. One that fails, does not answer within `probeTimeout`
(1000 ms by default) or meets packets out of order is destroyed with its socket, passive
health hears of it as a lost connection, and the cluster takes the next connection of the
same node. A new connection needs no ping, so the call ends with one at the latest. A path
that forgot an idle connection, such as a firewall or a NAT, costs you nothing then: the
ping meets it, not your first statement.

So the call can take up to `probeTimeout` longer per connection that does not answer. The
worst case is a path that drops the packets of every idle connection without a reset: each
one costs `probeTimeout`, so about `connectionLimit × probeTimeout` (10 s with a limit of
10 and the defaults) pass before the call gets to a new connection, which then has
mysql2's `connectTimeout` for its login. On a node with a `healthCheck` block it ends
sooner: a failed probe tells passive health of a lost connection, which starts a check, and
the first probe that fails after that check took the node down rejects the call with its
error. With the block's default check `timeout` of 5 s that is after about 6 to 7 probes. A
node on the legacy check, the default without a block, has no passive health and keeps
about the whole worst case.
A connection used within `probeIdle` gets no ping of its own.

#### The reset at release()

`release()` resets the connection before it goes back to the pool: one `COM_RESET_CONNECTION`,
bounded by `resetTimeout`. The server rolls back an open transaction and drops its locks,
temporary tables, user variables, prepared statements and session settings. A reset that
fails or runs out of time destroys the connection, and it never goes back. So do packets
out of order on the reset: the connection is destroyed at once, not after `resetTimeout`.
The next caller,
a `getConnection()` or a query of the cluster, gets the connection only after the reset was
answered. A query of the cluster sends `USE` before it, since the cluster does not know which
database you left the connection on.

The first `release()` does that. A second one does nothing, until a later `getConnection()`
hands out the same connection again: the object then belongs to that caller.

Do not reset the connection yourself before you release it. It costs a second reset, and
the cluster's reset follows anyway.

```ts
const { connection } = await cluster.getConnection();
const db = connection.promise();
try {
    await db.query('START TRANSACTION');
    await db.query('UPDATE accounts SET balance = balance - 10 WHERE id = 1');
    await db.query('UPDATE accounts SET balance = balance + 10 WHERE id = 2');
    await db.query('COMMIT');
} finally {
    // a transaction left open by a failed statement is rolled back by the reset
    connection.release();
}
```

#### Packets out of order

mysql2 only warns when the packets of a reply come with a wrong sequence number, and then
waits on, often until the timeout of the statement (#94). While you hold the connection, the
cluster listens for that warning. It destroys the connection with its socket, and the
command you have out on it fails with the warning of mysql2: an `Error` with the numbers
`expected` and `received`, and `fatal: true`. Your `release()` after that does nothing.
A `timeout` you hand mysql2 yourself on such a command is mysql2's timer, which stays armed
when the connection is destroyed and keeps the process alive until it fires (#120): bound
your commands on a lent connection with a timer of your own, unref'd, or with a signal.

### Who releases what after an abort

It follows from how the promise ended, not from the state of the signal:

- The promise resolved. The connection is yours and you release it. That holds also when the
  signal is aborted by the time your code runs, because the abort came a moment after the
  connection. The package never takes back a connection it handed out.
- The promise rejected, with the reason or with anything else. You got no connection and have
  nothing to release. A connection that arrives later for a call the signal ended is released
  by the package. It is released as it is, with no reset: nobody has used it. The events
  `connection`, `acquire` and `release` fire for it as for any other connection.

That release runs inside mysql2, not inside a call of yours. So a `release` listener of yours
that throws for such a connection has nobody to throw to. The package catches the throw and
logs it at `warn` with `nodeId`, `pool` and `error`. The connection is not lost: mysql2 puts
it back into the pool before it calls the listeners, so it is `idle` and the next caller gets
it. The `release` listeners that come after the one that threw are not called for it.

```ts
const { connection } = await cluster.getConnection({ signal });
// signal.aborted can be true here. The connection is still yours
try {
    // ...
} finally {
    connection.release();
}
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
  `checkError`. See [`checkError`](#checkerror). The whole error object comes
  with the `pool_check_failed` event. See [events.md](./events.md#a-failed-health-check).
- It is pending until `connect()` is called. The promise you read before the first
  `connect()` is the one that call resolves.
- Every later `connect()` call puts a new promise there. A promise of an earlier call still
  resolves with the results of its own call.
- `ok` is about that first connect only. For the state of a node now, read `nodes()`.

`connect()` behaves as before: it resolves on the first pool and rejects as it did. See
[subsystems/cluster.md](./subsystems/cluster.md#connect).

## `firstReady`


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

The results of `firstReady` are objects of their own, and so are their `checkError` objects.
Changing one does not change the result `ready` gives for the same node. Only the `error` of
a failed node is the same `Error` object in both.

## `checkError`


```ts
interface INodeCheckError { code?: string; errno?: number; sqlState?: string }
```

The error of the last health check of a node, reduced to three fields. It is on every entry
of `nodes()` and on every result of `ready` and `firstReady`, when there is one. A refused
login looks like this:

```ts
{ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }
```

That error goes to the log and to the `pool_check_failed` event, and also to `checkError`.

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
  and a validator said no. For example the node is not `Synced`. There are two other
  cases. One is a node whose first check has not ended yet. The other is a node with a
  `healthCheck` block that was down and passed its last check, but has not passed `rise`
  checks in a row yet: its answer was fine, and it is still not valid.
- One failed check does not take a valid node out, the second in a row does, or the
  `fall`th for a node with a `healthCheck` block. So a node can
  be valid and have a `checkError` for one check interval. A node with a `healthCheck`
  block is the exception when the server refused the login of the check: it is out with
  that one check. See
  [A login or account refusal](subsystems/health-and-scoring.md#a-login-or-account-refusal).
- `disconnect()` does not clear it, as it does not clear `isValid`. After `disconnect()`,
  `nodes()` still shows the error of the last check. A later `connect()` keeps it until its
  first check ends. That check sets it or clears it.

### How old it is

On `nodes()` it is the error of the last check, not of this moment. A node is checked every
`timerCheckRange.start` to `timerCheckRange.end` ms, 5 to 15 seconds with the defaults, so
the value can be up to one check interval old, plus the time the check itself takes. A node
with a `healthCheck` block is checked every `healthCheck.interval` ms. After a check the
server refused the login of, its next check is `healthCheck.authRetryInterval` ms away, one
minute with an empty block, so a refusal on `nodes()` can be that old. The same holds for
the checks after it that got no answer.

On a result of `ready` or `firstReady` it is the error of the health check of that connect,
and of no other check. It does not change later. For the state of a node now, read
`nodes()`.

### On a result

- A result with `ok: false` and a `checkError` with a `code`: the check of that connect
  failed with that code. The code stays on the result whatever is called after the check.
  A `pool_check_failed` listener that calls `disconnect()` on a refused login still finds
  the 1045 on the result, and so does the first of two `connect()` calls.
- A result with `ok: false` and no `checkError`: the server answered and a validator said no.
- A result with `checkError: {}`: there is nothing from mysql2, the socket or the server to
  report. There are two cases. Mostly the check ran into its own timer. Or the check of that
  connect never ended: `disconnect()` came while the check was out, or `disconnect()` or
  another `connect()` came while the pool still asked the server for its version. Such a
  result says nothing about the server, neither that it refused nor that it would have
  answered. The cluster logs the second case at `debug`, with the message
  `The connect of a node ended without a recorded health check, its result gets an empty
  checkError` and the fields `nodeId` and `pool`.
- A result with `ok: true` has no `checkError`, with one exception. A node that was valid
  before a `disconnect()` keeps `isValid` over one failed check, so its next connect can pass
  though its first check failed. That result has `ok: true` and the `checkError` of that
  check. A passed result never shows the error of an earlier check. When the check of its
  connect never ended, it has none.

### What a timeout gives

| What ran out | `checkError` | Made by |
| --- | --- | --- |
| The timer of the check itself, `min(queryTimeout, timerCheckRange.end)`, 15 s with the defaults, or `healthCheck.timeout` for a node with a `healthCheck` block. It ends a check that waits for a free connection, for a reset of a dirty connection or for the answer to the status query. It also ends a check that waits for a new connection when that timer is shorter than 10 s. A check of a node with a `healthCheck` block waits for no free connection: it asks on a connection of its own, and drops that connection when this timer ends it. | `{}` | the package |
| The connect timeout of mysql2, 10 s. A new connection got no greeting, or no answer to its login. It ends the check when the timer of the check is longer than 10 s, as with the defaults. | `{ code: 'ETIMEDOUT' }`, with no `errno` | mysql2 |
| A connect timeout of the operating system. | `{ code: 'ETIMEDOUT', errno: -110 }`. The number depends on the platform. | the socket |
| A timeout of the server, or of a proxy in between, that closes the connection while the check uses it. | `{ code: 'PROTOCOL_CONNECTION_LOST' }` | mysql2 |

`PROTOCOL_SEQUENCE_TIMEOUT` is the code of a query that ran out of its `timeout`. The
status query of the legacy check has that limit, by the timer of the pool (the `timeout`
option of mysql2, which earlier releases passed), the one of a node with a `healthCheck` block has none. A
check that times out still does not report the code: the timer of the check has the same
length and is set first, so it ends the check first, with `{}`. A check would report
`PROTOCOL_SEQUENCE_TIMEOUT` only if the pool handed it that error before the check's own
timer ran out.

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

mysql2 makes more codes of its own while it logs in. They are listed here from reading the
source of mysql2 3.24.6. No test of this package produces them, so take the list as a guide.
None of them is a wrong user or password:

| `code` | When mysql2 makes it |
| --- | --- |
| `HANDSHAKE_UNKNOWN_ERROR` | The server sent a packet mysql2 did not expect during the login. |
| `AUTH_SWITCH_PLUGIN_ERROR` | An authentication plugin failed, or the server asked for one mysql2 does not have. |
| `MYSQL_CLEAR_PASSWORD_NOT_ENABLED` | The server asked for the password in clear text, which mysql2 refuses by default. |
| `HANDSHAKE_NO_SSL_SUPPORT`, `HANDSHAKE_SSL_ERROR` | Only with TLS. This package sets no `ssl` option on its pools, so it should not come up. |
| `PROTOCOL_ERROR`, `PROTOCOL_UNEXPECTED_PACKET` | The server sent a packet when no command was waiting for one. mysql2 raises these on the connection, so they may never reach a health check. |

A refused login is `ER_ACCESS_DENIED_ERROR` with `errno` 1045 and `sqlState` `'28000'`.

The health check of a node with a `healthCheck` block reads `checkError` too, and draws its
own line. It takes a wider list of `errno` values as a refusal of the login or the account,
1045 and 1049 among them and 1040 and 1226 not, and treats the node apart for those: down
with one check, and a slower pace of the checks after it. The list is in
[A login or account refusal](subsystems/health-and-scoring.md#a-login-or-account-refusal).
The tables above are about what a code means to an app, and do not change with it.

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
- `idle` is the free connections: open, and nobody uses them. A connection of a node with a
  `healthCheck` block whose ping is out counts here too, see
  [subsystems/pool.md](subsystems/pool.md#the-idle-connections-of-the-pool).
- `pending` is the requests that wait for a connection.
- `limit` is the `connectionLimit` of the node. `0` means no limit, as in mysql2.

The connection a node with a `healthCheck` block keeps for its health checks is no connection
of the pool and is in none of these counts. So such a node shows `idle: 0` after `connect()`
until a query of the app ran, and holds one connection of the server more than `used` plus
`idle`. A check never shows as `pending`.

`used`, `idle` and `pending` are `0` while the mysql2 pool of the node does not exist, which
is before `connect()`. `limit` is set from the start.

After `disconnect()` the closed mysql2 pool still exists. `getPoolStats()` keeps the counts
that pool had when it was closed, and they do not go back to `0`. A connection the app held
at that moment stays counted as `used`.

The library publishes the same counts as OpenTelemetry metrics from `connect()` until
`disconnect()`, as `mysql_dynamic_cluster.connection.count`,
`mysql_dynamic_cluster.connection.pending_requests` and
`mysql_dynamic_cluster.connection.limit`. See
[subsystems/metrics.md](subsystems/metrics.md#pool-connection-metrics).

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

- It fails waiting `getConnection()` calls. They reject with `error`, plus `nodeId`. A call
  that its `signal` already ended does not wait any more and is not failed again.
- It also fails the cluster's own queries that wait on that node. `cluster.query()` then
  tries another node, since the statement was never sent, within `maxRetry` and the valid
  nodes that are left. After an error reply, a timeout or a lost connection it tries no
  other node, see [the rule](subsystems/cluster.md#8-retry-loop). A query that has no node
  left rejects with `error` itself, with `nodeId` and `errors` set on it. An `error` that
  has an `errors` of its own, such as the fields of a validation, keeps it and gets no list
  of nodes. All those queries share that one object, so its `nodeId` and `errors` are those
  of the query that rejected last. An entry that would lead
  back to it is left out of `errors`, so the errors never refer to each other in a cycle. A
  health check of the legacy check that waits is failed too and counts as a failed check.
- Connections in use are left alone. So are logins that are still running.
- The node stays in the cluster, and the call does not set `isValid`. It can still cost the
  node its validity through a health check of the legacy check. A check that waits is failed
  with the others and counts as a failed check, and the second failed check in a row marks
  the node not valid. A check waits when every connection of the node is in use, so this is
  the case of a full pool. Two calls that each catch a waiting check take the node out.
- It fails no check of a node with a `healthCheck` block. Such a check asks on a connection
  of its own and never waits in that queue, see
  [subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#the-check-connection).
- A request that comes after the call waits again. A callback that asks for a connection
  again while it is being failed is not failed in the same call.
- It logs one `info` line with the host of the node and how many requests it failed, also
  when none waited, since 4.1.1. The meta has `nodeId`, `pool` and `failed`.

Since 4.2.0 the package does the same by itself when a node goes down: each waiting request
fails with an `MDC_NODE_DOWN` error of its own, and the status query of a legacy check that
waits keeps its place, see
[subsystems/health-and-scoring.md](subsystems/health-and-scoring.md#a-node-that-goes-down-fails-the-requests-that-wait).
`failWaiting()` does what it did before.

It returns `0` for a node id that does not exist and for a node whose pool is not created
yet. It throws a `TypeError` when `error` is not an `Error`. A waiting request that is called
back without an error would take its missing connection for a real one.
