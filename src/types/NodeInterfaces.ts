import type { PoolConnection } from 'mysql2';

// Options of GaleraCluster.getConnection
export interface IGetConnectionOptions {
    // ids of the nodes to leave out, as nodes() reports them
    exclude?: number[]
}

// A connection handed out by GaleraCluster.getConnection. The caller owns it
export interface IClusterConnection {
    connection: PoolConnection,
    // id of the node the connection belongs to
    nodeId: number
}

// A node of the cluster, as GaleraCluster.nodes() reports it
export interface INodeInfo {
    id: number,
    name: string,
    host: string,
    port: number,
    // result of the last health check
    isValid: boolean,
    // load of the last health check, lower is better
    loadScore: number
}

// Connection counts of the pool of one node, as GaleraCluster.getPoolStats() reports them
export interface INodePoolStats {
    nodeId: number,
    // connections handed out, or still logging in
    used: number,
    // open connections nobody uses
    idle: number,
    // requests that wait for a connection
    pending: number,
    // connectionLimit of the node. 0 means no limit
    limit: number
}

// How the first connect of one node ended, as GaleraCluster.ready reports it
export interface INodeReadyResult {
    nodeId: number,
    ok: boolean,
    // set when ok is false
    error?: Error
}
