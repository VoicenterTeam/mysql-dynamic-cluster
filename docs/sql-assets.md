# SQL Assets

The package ships a small SQL bundle under [`assets/sql/create_hashing_database/`](../assets/sql/create_hashing_database/) that defines the helper database backing the cluster-hashing feature (sticky service-to-node routing). `ClusterHashing` reads these files at runtime and replays them against the live cluster when it needs to create, or recreate, the helper schema. See [architecture.md](./architecture.md) for where the helper database sits in the connect flow, and [glossary.md](./glossary.md) for the *cluster hashing* term.

## Path layout

```
assets/sql/create_hashing_database/
├── metadata/
│   └── metadata.sql
├── routines/
│   ├── FN_GetServiceNodeMapping.sql
│   ├── SP_NodeInsert.sql
│   ├── SP_NodeServiceUpdate.sql
│   └── SP_RemoveNode.sql
└── tables/
    ├── node.sql
    └── node_services.sql
```

`ClusterHashing._createDB` loads the three subdirectories in a fixed order: `tables` first, then `routines`, then `metadata` ([src/cluster/ClusterHashing.ts:120](../src/cluster/ClusterHashing.ts#L120)-[L125](../src/cluster/ClusterHashing.ts#L125)). Existing routines are dropped before the routine bundle is replayed; the `metadata` block runs last because it carries the version row that signals success.

The helper database itself is named `${clusterName}_${dbName}` ([src/cluster/ClusterHashing.ts:34](../src/cluster/ClusterHashing.ts#L34)) — both halves come from the cluster-hashing settings (see [configuration.md](./configuration.md)).

## Tables

### `node`

Owns the list of pools the hashing helper is aware of. The primary key is the `node_id` assigned by `Pool` construction; the `(ip, port)` unique constraint makes `SP_NodeInsert` idempotent even when the same host/port pair is re-inserted with a different `node_id`.

Source: [assets/sql/create_hashing_database/tables/node.sql](../assets/sql/create_hashing_database/tables/node.sql)

```sql
create table if not exists node
(
    node_id   tinyint               not null
        primary key,
    node_name varchar(100)          null,
    ip        varchar(100)          null,
    port      smallint default 3306 null,
    constraint unique_port_ip
        unique (ip, port)
);
```

### `node_services`

Maps a service id to the node currently serving it. The primary key is the service id, so each service has at most one mapping; rewriting the mapping is done via upsert in `SP_NodeServiceUpdate`. The `node_id` column is a foreign key into `node(node_id)`, so a node row cannot be removed without first clearing its mappings — `SP_RemoveNode` does that explicitly.

Source: [assets/sql/create_hashing_database/tables/node_services.sql](../assets/sql/create_hashing_database/tables/node_services.sql)

```sql
create table if not exists node_services
(
    service_id tinyint not null
    primary key,
    node_id    tinyint not null,
    constraint node_services_node_node_id_fk
    foreign key (node_id) references node (node_id)
);
```

> ⚠️ **Capacity caps**
>
> Both `node.node_id` and `node_services.service_id` are **signed `TINYINT`**, so the usable range is `-128..127`. In practice this means **at most 127 nodes and 127 services** can be registered before inserts start failing on overflow. The runtime does not validate this up front — once you exceed the cap, `SP_NodeInsert` / `SP_NodeServiceUpdate` will silently error out per call (errors are caught and only logged in [src/cluster/ClusterHashing.ts:89-91](../src/cluster/ClusterHashing.ts#L89)), and affected services will simply never get a sticky mapping. If you plan to operate near these limits, change both columns (and the routine signatures) to a wider integer type before going to production.

## Routines

All four routines live under [assets/sql/create_hashing_database/routines/](../assets/sql/create_hashing_database/routines/) and are reloaded on every helper-database (re)build. `_createDB` issues a `DROP PROCEDURE IF EXISTS` for each routine file *by base name* before re-creating them ([src/cluster/ClusterHashing.ts:127-132](../src/cluster/ClusterHashing.ts#L127)); note that the function `FN_GetServiceNodeMapping` is also dropped with `DROP PROCEDURE` because the loader does not distinguish procedures from functions — this works on MySQL only because the create-after-drop replaces it regardless.

### `SP_NodeInsert(_ID, _Name, _IP, _Port)`

Source: [assets/sql/.../SP_NodeInsert.sql](../assets/sql/create_hashing_database/routines/SP_NodeInsert.sql)

Idempotently upserts a row into `node`. The body first probes for an existing row keyed on `(ip, port)` and produces a human-readable `Result` string describing one of three cases — *inserted*, *already exists*, or *renamed* (same id and address, different name) — then performs an `INSERT ... ON DUPLICATE KEY UPDATE` that writes `(node_id, node_name, ip, port)`. The diagnostic `SELECT` is informational; the upsert is what actually persists the row. Called from `ClusterHashing._insertNodes` once per pool on every `connect()` ([src/cluster/ClusterHashing.ts:208](../src/cluster/ClusterHashing.ts#L208)).

### `SP_NodeServiceUpdate(_ServiceID, _NodeID)`

Source: [assets/sql/.../SP_NodeServiceUpdate.sql](../assets/sql/create_hashing_database/routines/SP_NodeServiceUpdate.sql)

Upserts a single service-to-node mapping into `node_services`. The body is a one-liner: `INSERT ... ON DUPLICATE KEY UPDATE node_id = _NodeID`. Because `service_id` is the primary key, each call either inserts a new mapping or overwrites the existing one. Called from `ClusterHashing.updateNodeForService` whenever the cluster wants to pin a service to a different pool ([src/cluster/ClusterHashing.ts:82](../src/cluster/ClusterHashing.ts#L82)).

Note: the signature declares `_NodeID smallint` while the table column is `tinyint`. MySQL will silently down-cast on insert, but values outside `-128..127` will be truncated — another reason to keep an eye on the [capacity caps](#tables) above.

### `SP_RemoveNode(_ID)`

Source: [assets/sql/.../SP_RemoveNode.sql](../assets/sql/create_hashing_database/routines/SP_RemoveNode.sql)

Removes a node and any service mappings that point at it. The body deletes from `node_services` first (to respect the FK), then from `node`. Not called from anywhere in the current TypeScript code — it exists for manual cleanup or for future use; `ClusterHashing` only ever inserts, never removes.

### `FN_GetServiceNodeMapping()`

Source: [assets/sql/.../FN_GetServiceNodeMapping.sql](../assets/sql/create_hashing_database/routines/FN_GetServiceNodeMapping.sql)

Returns the full contents of `node_services` as a single JSON array of `{ "ServiceID": <int>, "NodeID": <int> }` objects (via `JSON_ARRAYAGG` + `JSON_OBJECT`). Called from `ClusterHashing._checkHashing` on every poll interval — the JSON payload is decoded into `IServiceNodeMap[]` and used to refresh the in-memory `_serviceNodeMap` ([src/cluster/ClusterHashing.ts:228](../src/cluster/ClusterHashing.ts#L228)-[L237](../src/cluster/ClusterHashing.ts#L237)). When the table is empty `JSON_ARRAYAGG` returns SQL `NULL`, which decodes to a falsy result and short-circuits the `forEach`.

## Metadata and version

Source: [assets/sql/.../metadata.sql](../assets/sql/create_hashing_database/metadata/metadata.sql)

```sql
create table if not exists metadata
(
    version   tinyint   not null
        primary key
);
```

A single-row table that records the schema version of the helper database. The TypeScript side hard-codes the current version in `ClusterHashing._databaseVersion = 1` ([src/cluster/ClusterHashing.ts:23](../src/cluster/ClusterHashing.ts#L23)).

The flow on every `connect()`:

1. `_isDatabaseVersionEquals()` (`SHOW DATABASES`, then `SELECT version FROM metadata`) checks whether the helper DB exists and whether its `metadata.version` matches the constant ([src/cluster/ClusterHashing.ts:154](../src/cluster/ClusterHashing.ts#L154)-[L182](../src/cluster/ClusterHashing.ts#L182)).
2. If either check fails, the **entire helper schema is dropped** (`DROP SCHEMA IF EXISTS ...`) and rebuilt from the SQL files ([src/cluster/ClusterHashing.ts:45](../src/cluster/ClusterHashing.ts#L45)-[L55](../src/cluster/ClusterHashing.ts#L55)).
3. The final step of `_createDB` writes `INSERT INTO metadata (version) VALUES (1);` to mark the freshly built schema as current ([src/cluster/ClusterHashing.ts:136](../src/cluster/ClusterHashing.ts#L136)-[L144](../src/cluster/ClusterHashing.ts#L144)).

Bumping `_databaseVersion` is therefore the supported way to ship a breaking change to the helper schema: on next start the old database is wiped and the new SQL bundle takes over. Any existing `node_services` data is lost in the process — clients re-populate it via `updateNodeForService` after reconnecting.

## Path resolution at runtime

`_createDB` resolves the three SQL directories relative to the **compiled module's `__dirname`**, not relative to the project root or the install root:

```ts
// src/cluster/ClusterHashing.ts (lines 108-114)
const extraPath = '../';
const sqlLocations: ISQLLocations = {
    tables:   extraPath + '../../assets/sql/create_hashing_database/tables/',
    routines: extraPath + '../../assets/sql/create_hashing_database/routines/',
    metadata: extraPath + '../../assets/sql/create_hashing_database/metadata/'
}
// ...
this._readFilesInDir(join(__dirname, sqlLocations.tables))
```

After `tsc` runs, `ClusterHashing.js` is emitted to `dist/src/cluster/` (because `tsconfig.outDir = "./dist"` and the source lives at `src/cluster/ClusterHashing.ts`). The three `../` segments walk back up to the package root, where `assets/` sits next to `dist/`:

```
dist/src/cluster/  +  ../../../assets/sql/...   =   <package-root>/assets/sql/...
```

This is fragile in several ways. **Any** of the following will break file resolution and cause `connect()` to throw:

- Changing `tsconfig.outDir` (e.g. flattening to `./dist` without the nested `src/`).
- Moving `ClusterHashing.ts` to a different depth in the source tree.
- Relocating the `assets/` directory, or shipping a bundler that does not copy `assets/` into the published package next to `dist/`.
- Consuming the source directly (`ts-node` from a non-standard cwd) — `__dirname` then points at `src/cluster/`, not `dist/src/cluster/`, and `../../../assets/` still happens to resolve on disk only because the repo layout matches by coincidence.

If any of those change, update the constants in `_createDB` (or, better, switch to a path resolved from `package.json` / a known anchor) before publishing.

## See also

- [architecture.md](./architecture.md) — where `ClusterHashing` sits in the cluster lifecycle.
- [configuration.md](./configuration.md) — `useClusterHashing`, `clusterHashing.dbName`, `clusterHashing.nextCheckTime`.
- [events.md](./events.md) — the `hashing_created` event fired after `ClusterHashing.connect()` resolves.
