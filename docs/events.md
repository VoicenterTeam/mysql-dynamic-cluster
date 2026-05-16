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

## Notes for subscribers

- All events flow through a single module-level `EventEmitter` in [src/utils/Events.ts:4](../src/utils/Events.ts#L4). It is process-wide, so multiple `GaleraCluster` instances created in the same process will share listeners and emissions. There is no per-cluster scoping.
- `cluster.on(...)` only registers a listener; it never removes one. If you re-create a cluster, detach listeners yourself via the underlying emitter or avoid re-registering.
- `connected` is one-shot per process-cluster lifecycle (guarded by `this.connected`). If you `disconnect()` and `connect()` again, it will fire again because the flag is reset in `disconnect()`.
- `hashing_created` only fires when `useClusterHashing` is enabled; see [configuration.md](./configuration.md) for that flag.
- `connection`, `acquire`, `release` are high-frequency events tied to query throughput. Avoid heavy work in their handlers.
