# Events

`@voicenter-team/mysql-dynamic-cluster` exposes a small set of lifecycle and per-pool events through a single shared Node.js `EventEmitter`. Subscribers attach via `GaleraCluster.on(event, callback)` (see [src/cluster/GaleraCluster.ts:145](../src/cluster/GaleraCluster.ts#L145)), which delegates to the singleton emitter in [src/utils/Events.ts:12](../src/utils/Events.ts#L12). The event-name union is fixed by the `ClusterEvent` type in [src/types/PoolInterfaces.ts:10](../src/types/PoolInterfaces.ts#L10). See also [architecture.md](./architecture.md) for where these emissions sit in the connect / query / disconnect flow, and [glossary.md](./glossary.md) for terms like *pool* and *cluster hashing*.

## Catalog

| Event | Emitter | Payload | When it fires |
| --- | --- | --- | --- |
| `connected` | [src/cluster/GaleraCluster.ts:101](../src/cluster/GaleraCluster.ts#L101) | none | Once, when the first pool in `GaleraCluster.connect()` finishes its initial validation. Subsequent pool successes do not re-emit because of the `this.connected` guard. |
| `hashing_created` | [src/cluster/GaleraCluster.ts:119](../src/cluster/GaleraCluster.ts#L119) | none | After `ClusterHashing.connect()` resolves, if the cluster was constructed with `useClusterHashing: true`. Fires immediately after `connected`. |
| `disconnected` | [src/cluster/GaleraCluster.ts:137](../src/cluster/GaleraCluster.ts#L137) | none | At the end of `GaleraCluster.disconnect()`, after all pools have been instructed to close and the hashing helper / Redis client are stopped. |
| `pool_connected` | [src/pool/Pool.ts:88](../src/pool/Pool.ts#L88) | `poolId: number` | Per pool, when its initial `checkStatus()` reports `isValid`. Emitted once per pool per connect cycle. |
| `pool_disconnected` | [src/pool/Pool.ts:129](../src/pool/Pool.ts#L129) | `poolId: number` | Per pool, inside `Pool.disconnect()` after `mysql2.Pool.end()` is invoked and the status timer is stopped. |
| `connection` | [src/pool/Pool.ts:102](../src/pool/Pool.ts#L102) | `connection, poolId` | Re-emit of the underlying `mysql2.Pool` `"connection"` event: a new physical MySQL connection has just been opened by the pool. |
| `acquire` | [src/pool/Pool.ts:113](../src/pool/Pool.ts#L113) | `connection, poolId` | Re-emit of `mysql2.Pool` `"acquire"`: an existing connection has been handed out for a query. |
| `release` | [src/pool/Pool.ts:108](../src/pool/Pool.ts#L108) | `connection, poolId` | Re-emit of `mysql2.Pool` `"release"`: a connection has been returned to the pool. |
| `pool_check_failed` | `PoolStatus.checkStatus()` in [src/pool/PoolStatus.ts](../src/pool/PoolStatus.ts) | `error, poolId` | Per pool, each time a health check fails with an error. See [A failed health check](#a-failed-health-check). |

The `poolId` is the numeric `id` assigned to a pool at construction time (auto-incrementing, surfaced in metrics and logs).

## The args-wrap quirk

The shared emitter wraps emit arguments into an array before forwarding them:

```ts
// src/utils/Events.ts
emit(event: ClusterEvent, ...args: any[]) {
    eventEmitter.emit(event, args);   // note: `args`, not `...args`
}
```

See [src/utils/Events.ts:22](../src/utils/Events.ts#L22). Because the rest-spread is collapsed into a single `args` array on the way out, every listener receives **one** positional argument: an array of whatever was passed to `Events.emit`.

That means the listener signatures documented elsewhere (e.g. `(connection, poolId) => ...` in the README) do not match runtime behaviour. In practice you must destructure the first parameter.

### Broken form (what the README implies)

```ts
cluster.on('acquire', (connection, poolId) => {
    // connection is actually [connection, poolId]
    // poolId is undefined
    console.log('acquired on pool', poolId);   // logs: acquired on pool undefined
});
```

### Correct form (what the code actually delivers)

```ts
cluster.on('acquire', (args) => {
    const [connection, poolId] = args;
    console.log('acquired on pool', poolId);
});

// Same shape for `connection` and `release`:
cluster.on('connection', ([connection, poolId]) => {
    console.log('new mysql connection on pool', poolId);
});

cluster.on('release', ([connection, poolId]) => {
    console.log('released connection on pool', poolId);
});
```

Single-payload events follow the same rule - even `pool_connected` and `pool_disconnected` deliver `[poolId]`, not `poolId`:

```ts
cluster.on('pool_connected', ([poolId]) => {
    console.log('pool', poolId, 'is online');
});
```

And payload-less events still pass an empty array:

```ts
cluster.on('connected', (args) => {
    // args === []
    console.log('cluster connected');
});
```

## A failed health check

Added in 4.4.0. `pool_check_failed` hands the app the error of a failed health check, so it
can tell a wrong
password from a node that is down. The listener gets `[error, poolId]`, wrapped like every
other payload.

- `error` is the error the check failed with, the same object, not a copy. For an error from
  mysql2 it keeps `code`, and `errno` when there is one. A wrong password has
  `code: 'ER_ACCESS_DENIED_ERROR'` and `errno: 1045`. A node that refuses the connection has
  `code: 'ECONNREFUSED'`. A host that does not answer has `code: 'ETIMEDOUT'`. Go by `code`:
  network errors do not always carry an `errno` or a message. A host name that resolves to
  several addresses, such as `localhost`, gives an `AggregateError` with the `code` and an empty
  message.
- `poolId` is the `id` of the pool the check ran on.

```ts
cluster.on('pool_check_failed', ([error, poolId]) => {
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
        console.error('pool', poolId, 'has a wrong user or password', error.errno);
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        console.error('pool', poolId, 'is down');
    } else {
        console.error('pool', poolId, 'failed its check:', error.message);
    }
});
```

What to know:

- It fires for every failed check, not only the first. A failing pool is checked again every
  `timerCheckRange.start` ms at the fastest, so expect one event per check until it recovers.
- It fires for the first check inside `connect()` too, so subscribe before calling `connect()`.
- It fires when the check ends with an error: the status query was rejected, or the check
  timed out. A timed out check gives an `Error` with the message `Status check timeout` and no
  `code`.
- It does not fire when the query worked and a validator said no, for example a node that is
  not `Synced`. There is no error then.
- One failed check does not take the pool out of rotation, the second in a row does (see
  [health-and-scoring.md](./subsystems/health-and-scoring.md)). The event fires for both.
- A listener that throws does not stop the health checks. The next check is set before the
  listeners run, and the thrown error is logged. Other listeners of the same event that were
  added after the one that threw do not run for that check. The other events have no such
  guard.
- An `async` listener that rejects is not caught. Node treats it as an unhandled rejection of
  the app, which ends the process by default. Catch inside an async listener.
- A check that is still running when the pool is disconnected reports nothing. No
  `pool_check_failed` comes after `pool_disconnected`.

## Notes for subscribers

- All events flow through a single module-level `EventEmitter` in [src/utils/Events.ts:4](../src/utils/Events.ts#L4). It is process-wide, so multiple `GaleraCluster` instances created in the same process will share listeners and emissions. There is no per-cluster scoping.
- `cluster.on(...)` only registers a listener; it never removes one. If you re-create a cluster, detach listeners yourself via the underlying emitter or avoid re-registering.
- `connected` is one-shot per process-cluster lifecycle (guarded by `this.connected`). If you `disconnect()` and `connect()` again, it will fire again because the flag is reset in `disconnect()`.
- `hashing_created` only fires when `useClusterHashing` is enabled; see [configuration.md](./configuration.md) for that flag.
- `connection`, `acquire`, `release` are high-frequency events tied to query throughput. Avoid heavy work in their handlers.
