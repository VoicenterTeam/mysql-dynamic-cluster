/**
 * Created by Bohdan on Sep, 2021
 */

import { INodeCheckError } from "./NodeInterfaces";
import { QueryStep } from "./PoolInterfaces";

// Where the result of a cluster query came from
export type QueryResultSource = 'pool' | 'cache' | 'stale_cache';

// Outcome of a Redis cache lookup
export type CacheLookupResult = 'hit' | 'expired' | 'miss';

// One query attempt in a pool
export interface IOperationMetricOptions {
    poolName: string,
    host: string,
    port: number,
    database?: string,
    serviceName?: string,
    // sql of a single statement, used only to read the operation name (SELECT, CALL...)
    sql?: string,
    error?: any,
    // where an attempt of Pool.query ended. Not set by the other callers
    step?: QueryStep,
    // how long an attempt of Pool.query waited for a connection, recorded apart. Not set by
    // the other callers, which then record no wait
    waitSeconds?: number,
    // the name of the cluster of the pool. Not set: the name of Metrics.init
    clusterName?: string,
    // false: the point has no server.address, server.port and db.namespace (#160). Not set: true
    serverAttributes?: boolean
}

// One cluster query, after cache and retries
export interface IQueryMetricOptions {
    // not set when the query failed
    source?: QueryResultSource,
    database?: string,
    serviceName?: string,
    sql?: string,
    error?: any,
    // the name of the cluster. Not set: the name of Metrics.init
    clusterName?: string,
    // false: the point has no db.namespace (#160). Not set: true
    serverAttributes?: boolean
}

// How one health check of a node ended. valid and invalid: the status query ran, and the
// validator passed or said no. error: the check failed. It got no answer, or the package
// failed after the answer came
export type HealthCheckResult = 'valid' | 'invalid' | 'error';

// One finished health check of a node
export interface IHealthCheckMetricOptions {
    poolName: string,
    host: string,
    port: number,
    result: HealthCheckResult,
    // what a check with the result error failed with, as PoolStatus reduced it. A code or an
    // errno is there only when it came from mysql2, the socket or the server
    checkError?: INodeCheckError,
    // the name of the cluster of the node. Not set: the name of Metrics.init
    clusterName?: string,
    // false: the point has no server.address and server.port (#160). Not set: true
    serverAttributes?: boolean
}

// State of an open connection, the value of the db.client.connection.state attribute
export type ConnectionState = 'idle' | 'used';

// What the connection metrics and the node gauges read of a pool at each collection. Pool
// has all of it
export interface IPoolMetricSource {
    name: string,
    // the pool name the metrics carry. Not set: name (#160)
    metricName?: string,
    // false: no server.address and server.port on its points (#160). Not set: true
    serverAttributes?: boolean,
    host: string,
    port: number,
    // 0 means no limit
    connectionLimit: number,
    stats(): { used: number, idle: number, pending: number },
    // read by the node gauges
    status: { isValid: boolean, loadScore: number }
}

// What a cluster keeps off its own metrics (#160)
export interface IMetricsSettings {
    // false: no server.address, server.port and db.namespace on its points, and the id of a host
    // without a name as its pool name. Default true
    serverAttributes?: boolean
}

export interface IDefaultMetricsSettings extends IMetricsSettings {
    serverAttributes: boolean
}

export interface IServiceMetricsSettings {
    database?: string,
    table?: string
}

export interface IDefaultServiceMetricsSettings extends IServiceMetricsSettings {
    database: string,
    table: string
}
