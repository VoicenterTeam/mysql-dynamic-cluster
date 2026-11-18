import type { PoolConnection } from 'mysql2';

// Options of GaleraCluster.getConnection
export interface IGetConnectionOptions {
    // ids of the nodes to leave out, as nodes() reports them
    exclude?: number[],
    // ends the wait for the connection when it aborts. The call then rejects with its reason
    signal?: AbortSignal
}

// A connection handed out by GaleraCluster.getConnection. The caller owns it
export interface IClusterConnection {
    connection: PoolConnection,
    // id of the node the connection belongs to
    nodeId: number
}

// The error of the last health check of a node, reduced to what mysql2, the socket or the
// server produced. Never the message, which can hold the user name. An empty object stands
// for a failure the package made itself, such as its own timeout around the check
export interface INodeCheckError {
    // only when the error had a string here
    code?: string,
    // only when the error had an integer here
    errno?: number,
    // only when the error had a string here
    sqlState?: string
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
    loadScore: number,
    // set when the last health check did not get its answer
    checkError?: INodeCheckError
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

// How the first connect of one node ended, as GaleraCluster.ready and firstReady report it
export interface INodeReadyResult {
    nodeId: number,
    ok: boolean,
    // set when ok is false
    error?: Error,
    // set when the health check of that connect did not get its answer
    checkError?: INodeCheckError
}
