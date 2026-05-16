# Subsystem: `ClusterHashing`

`ClusterHashing` is the sticky-routing layer that sits next to
`GaleraCluster`. Its job is to remember, for every `serviceId` the
caller passes into a query, which pool last successfully served that
service, and to bias subsequent routing decisions toward the same pool.
The motivation is read-skew minimisation across a Galera cluster: a
read that follows a write for the same service should land on the node
the write hit, so the application is not exposed to inter-node
replication lag.

The mapping is stored in a small helper database on the cluster itself
(`${clusterName}_${dbName}`) and cached in-memory. Reads are served
from the in-memory cache; writes go to both the cache and the helper
database. A periodic timer refreshes the cache so that mappings made by
other consumers — different processes, different node fleets — converge
in this process as well.

Source: [src/cluster/ClusterHashing.ts](../../src/cluster/ClusterHashing.ts).

Companion docs:

- [cluster.md](cluster.md) for the `GaleraCluster` orchestrator that
  instantiates and consumes this subsystem.
- [../sql-assets.md](../sql-assets.md) for the helper-database schema,
  routines, version row, and capacity caps.
- [../known-issues.md](../known-issues.md) for outstanding bugs in the
  current implementation (referenced in-line below).

## Construction

[src/cluster/ClusterHashing.ts:30-38](../../src/cluster/ClusterHashing.ts#L30).

The constructor takes `(cluster, clusterName, options:
IClusterHashingSettings)` and pulls two values off `options`:

- `_nextCheckTime` ← `options.nextCheckTime` (default `5000` ms; see
  [src/configs/schema.ts:111-117](../../src/configs/schema.ts#L111)).
- `_database` ← `` `${clusterName}_${options.dbName}` ``
  ([src/cluster/ClusterHashing.ts:34](../../src/cluster/ClusterHashing.ts#L34)).

The internal map `_serviceNodeMap` is a `Map<number, number>` keyed by
service id and valued by pool id
([src/cluster/ClusterHashing.ts:16](../../src/cluster/ClusterHashing.ts#L16)).
A `Timer` wrapper is created bound to `_checkHashing` but not started;
`connect()` is what actually kicks the timer off
([src/cluster/ClusterHashing.ts:36](../../src/cluster/ClusterHashing.ts#L36)).

`_databaseVersion` is the hard-coded constant `1`
([src/cluster/ClusterHashing.ts:23](../../src/cluster/ClusterHashing.ts#L23)).
Bumping this constant is what forces existing deployments to drop and
recreate the helper schema on next boot.

## `connect()` — flow

[src/cluster/ClusterHashing.ts:43-64](../../src/cluster/ClusterHashing.ts#L43).

`connect` does four things in order:

1. **Version check.** Calls `_isDatabaseVersionEquals()`
   ([src/cluster/ClusterHashing.ts:154-182](../../src/cluster/ClusterHashing.ts#L154)):
   - Runs `` SHOW DATABASES WHERE `Database` = '...' `` to confirm
     the helper schema exists. An empty result returns `false`
     immediately.
   - Otherwise runs `SELECT version FROM metadata;` and compares the
     first row's `version` against `_databaseVersion`. Match returns
     `true`; anything else (mismatch, missing metadata, query throw)
     returns `false`.
2. **Drop + recreate on mismatch.** If the version check returned
   `false`, the helper schema is dropped (`DROP SCHEMA IF EXISTS ...`)
   and rebuilt via `_createDB()`. If the version check returned `true`,
   both steps are skipped and the existing schema is reused as-is.
3. **Insert nodes.** `_insertNodes()` registers every pool currently
   in `GaleraCluster.pools` into the helper database's `node` table
   ([src/cluster/ClusterHashing.ts:205-218](../../src/cluster/ClusterHashing.ts#L205)).
4. **Prime cache and arm timer.** Calls `_checkHashing()` once
   synchronously; that method both fetches the current
   service-to-node mapping and schedules itself to run again. Sets
   `this.connected = true`
   ([src/cluster/ClusterHashing.ts:60](../../src/cluster/ClusterHashing.ts#L60)).
   Until `connected` flips to `true`, callers of `getNodeByService` /
   `updateNodeForService` are short-circuited by guards in
   `GaleraCluster` (see below).

Any thrown error in steps 1-3 propagates out of `connect`; `GaleraCluster._enableHashing`
([src/cluster/GaleraCluster.ts:116-124](../../src/cluster/GaleraCluster.ts#L116))
catches and logs it so a hashing failure does not abort
`GaleraCluster.connect`.

### `_createDB`

[src/cluster/ClusterHashing.ts:106-148](../../src/cluster/ClusterHashing.ts#L106).

Three SQL bundles are loaded off disk via `_readFilesInDir`
([src/cluster/ClusterHashing.ts:189-199](../../src/cluster/ClusterHashing.ts#L189)):

- `tables/` — `node`, `node_services`.
- `routines/` — `SP_NodeInsert`, `SP_NodeServiceUpdate`,
  `SP_RemoveNode`, `FN_GetServiceNodeMapping`.
- `metadata/` — the `metadata` table that holds the schema version.

The order of operations
([src/cluster/ClusterHashing.ts:117-144](../../src/cluster/ClusterHashing.ts#L117)):

1. `CREATE SCHEMA IF NOT EXISTS ${database} COLLATE utf8_general_ci;`.
2. `multiStatementQuery` with one `DROP PROCEDURE IF EXISTS` per
   routine. This makes the routine replay idempotent.
3. `multiStatementQuery` with the combined tables + routines payload.
4. `multiStatementQuery` with the metadata payload.
5. `INSERT INTO metadata (version) VALUES (${_databaseVersion});`.

The version row is inserted **last**: presence of the row is the
implicit success signal for the next `connect`.

The SQL files live under `assets/sql/create_hashing_database/`; see
[../sql-assets.md](../sql-assets.md) for the full schema, routine
signatures, and the column-width caps (TINYINT signed, max 127
nodes / 127 services). The asset paths are resolved against
`__dirname` and are fragile to build-output layout changes — see
[../known-issues.md](../known-issues.md) for the dist-depth issue.

### `_insertNodes`

[src/cluster/ClusterHashing.ts:205-218](../../src/cluster/ClusterHashing.ts#L205).

Iterates `cluster.pools` and calls
`SP_NodeInsert(pool.id, pool.name, pool.host, pool.port)` for each.
The procedure is idempotent — the `(ip, port)` unique constraint on
`node` means re-running this on an already-populated helper schema is
safe.

**Known issue:** the `try/catch` wraps a non-awaited Promise, so a
rejected `cluster.query` slips out as an unhandled rejection and the
`forEach` fires every insert in parallel without ordering. See
[#6 in known-issues](../known-issues.md#6-clusterhashing_insertnodes-swallows-errors-silently).

## Periodic refresh — `_checkHashing`

[src/cluster/ClusterHashing.ts:223-244](../../src/cluster/ClusterHashing.ts#L223).

Called once synchronously at the end of `connect()` and then
re-armed on a `_nextCheckTime` timer
([src/cluster/ClusterHashing.ts:250-252](../../src/cluster/ClusterHashing.ts#L250)).
Each tick:

1. Bails if `_timer.active` is false (i.e. `stop()` has been called).
2. Runs `SELECT FN_GetServiceNodeMapping() AS Result;` against the
   helper database.
3. Treats the returned `Result` as an `IServiceNodeMap[]` and writes
   every `(ServiceID, NodeID)` row into `_serviceNodeMap`.
4. Re-arms the timer via `_nextCheckHashing`.

Both the success and failure branches re-arm the timer, so a transient
query error does not stop the refresh loop. Failures are logged but
not propagated — callers continue to read from the last-good cache.

Note that `_checkHashing` only **adds** to `_serviceNodeMap`; it does
not remove keys. A service that was previously mapped but is no longer
returned by `FN_GetServiceNodeMapping` will keep its stale in-memory
entry until process restart.

## Write path — `updateNodeForService`

[src/cluster/ClusterHashing.ts:80-92](../../src/cluster/ClusterHashing.ts#L80).

`updateNodeForService(serviceId, nodeId)` is called from
`GaleraCluster._queryRequest`
([src/cluster/GaleraCluster.ts:268-270](../../src/cluster/GaleraCluster.ts#L268))
after a successful single-pool query, but only when both:

- `queryOptions.serviceId` is truthy, **and**
- `_clusterHashing.connected` is true.

The method runs `CALL SP_NodeServiceUpdate(?, ?)` against the helper
database, then writes the same `(serviceId, nodeId)` pair into
`_serviceNodeMap` so subsequent reads observe the update without
waiting for the next refresh tick. Errors are caught and logged; the
caller never sees a failure from the hashing write.

The fallback service id (`0` / `${clusterName}_mdc`) inserted by
`GaleraCluster.query` when the caller supplies neither `serviceId`
nor `serviceName`
([src/cluster/GaleraCluster.ts:171-178](../../src/cluster/GaleraCluster.ts#L171))
is falsy, so the `if (queryOptions?.serviceId ...)` guard in
`_queryRequest` skips the write for unhashed traffic — only callers
that explicitly opt in by passing a non-zero `serviceId` (or a
`serviceName` resolvable to one) cause a pin.

## Read path — `getNodeByService`

[src/cluster/ClusterHashing.ts:98-100](../../src/cluster/ClusterHashing.ts#L98).

`getNodeByService(serviceId)` is a one-line wrapper around
`_serviceNodeMap.get(serviceId)`. It returns the cached pool id or
`undefined` when no mapping is known. No I/O happens on this path —
reads are pure memory.

It is invoked exactly once per `query`, inside
`GaleraCluster._getActivePools`
([src/cluster/GaleraCluster.ts:325-327](../../src/cluster/GaleraCluster.ts#L325)):

```ts
if (serviceId && this._clusterHashing.connected) {
    poolIdService = this._clusterHashing.getNodeByService(serviceId);
}
```

`poolIdService` starts as `-1`. If the guards fail (no service id, or
hashing not connected) or the map returns `undefined`, it stays at
`-1` and the downstream sort treats every pool equally.

## Effect on routing — `_getActivePools`

[src/cluster/GaleraCluster.ts:321-344](../../src/cluster/GaleraCluster.ts#L321).

The pinning logic threads through three steps of active-pool selection:

1. **Filter and exclude the pin.** The valid-pool filter explicitly
   removes the pinned pool from the candidate set:
   ```ts
   activePools = this._pools.filter(pool => {
       return pool.status.isValid && pool.id !== poolIdService;
   })
   ```
   ([src/cluster/GaleraCluster.ts:329-331](../../src/cluster/GaleraCluster.ts#L329)).
2. **Sort by load score.** The remaining candidates are sorted ascending
   by `pool.status.loadScore`
   ([src/cluster/GaleraCluster.ts:332](../../src/cluster/GaleraCluster.ts#L332)).
3. **Prepend the pin.** If the pinned pool id is non-negative *and*
   the pool can be found in `_pools`, `unshift` it onto the front of
   the sorted list
   ([src/cluster/GaleraCluster.ts:334-337](../../src/cluster/GaleraCluster.ts#L334)).

The consequence: a valid pinned pool always goes first, even if its
load score is the worst in the cluster. If the pinned pool is invalid
(failed validator) or otherwise missing from `_pools`, the query
falls back to the pure load-sorted order; nothing forces the query to
wait for the pinned node to come back. A pin is a *bias*, not a
constraint. The retry loop in `query`
([src/cluster/GaleraCluster.ts:217-233](../../src/cluster/GaleraCluster.ts#L217))
walks the resulting array left-to-right, so a transient failure on
the pinned pool simply falls through to the next-best candidate.

The `isValid` check on the filter is what allows the pin to be
silently bypassed when the pinned node has been downgraded by
`PoolStatus` — see [health-and-scoring.md](health-and-scoring.md) for
that subsystem. Note one subtle behaviour: the prepend step finds the
pinned pool in `_pools` without re-checking `isValid`, so an invalid
pinned pool will still be unshifted if it exists in the pool list.
The downstream retry will fail on it once, then fall through to the
sorted tail.

## `stop()`

[src/cluster/ClusterHashing.ts:69-73](../../src/cluster/ClusterHashing.ts#L69).

Disposes the refresh timer and sets `connected = false`. After `stop`,
`updateNodeForService` and `getNodeByService` are gated off at the
`GaleraCluster` call sites by the `_clusterHashing.connected` guard,
so they become no-ops. The `_serviceNodeMap` is **not** cleared —
calling `connect` again will simply resume populating it.

`GaleraCluster.disconnect` invokes `this._clusterHashing?.stop()`
as part of teardown
([src/cluster/GaleraCluster.ts:129-138](../../src/cluster/GaleraCluster.ts#L129));
see [cluster.md](cluster.md) for the full shutdown order.

## Public API summary

| Member | Source | Notes |
| --- | --- | --- |
| `connected: boolean` | [:14](../../src/cluster/ClusterHashing.ts#L14) | `true` only between a successful `connect()` and `stop()`. Read by `GaleraCluster._queryRequest` and `_getActivePools`. |
| `connect(): Promise<void>` | [:43](../../src/cluster/ClusterHashing.ts#L43) | Version-checks, recreates schema if needed, inserts nodes, primes the cache. |
| `stop(): void` | [:69](../../src/cluster/ClusterHashing.ts#L69) | Disposes the refresh timer. Leaves `_serviceNodeMap` intact. |
| `updateNodeForService(serviceId, nodeId)` | [:80](../../src/cluster/ClusterHashing.ts#L80) | Writes the pin to both the helper db (`SP_NodeServiceUpdate`) and the in-memory cache. |
| `getNodeByService(serviceId): number` | [:98](../../src/cluster/ClusterHashing.ts#L98) | Pure memory read; returns `undefined` when no mapping is known. |
