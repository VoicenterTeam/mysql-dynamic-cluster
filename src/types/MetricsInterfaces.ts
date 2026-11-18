/**
 * Created by Bohdan on Sep, 2021
 */

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
    error?: any
}

// One cluster query, after cache and retries
export interface IQueryMetricOptions {
    // not set when the query failed
    source?: QueryResultSource,
    database?: string,
    serviceName?: string,
    sql?: string,
    error?: any
}

// State of an open connection, the value of the db.client.connection.state attribute
export type ConnectionState = 'idle' | 'used';

// What the connection metrics read of a pool at each collection. Pool has all of it
export interface IPoolMetricSource {
    name: string,
    host: string,
    port: number,
    // 0 means no limit
    connectionLimit: number,
    stats(): { used: number, idle: number, pending: number }
}

export interface IServiceMetricsSettings {
    database?: string,
    table?: string
}

export interface IDefaultServiceMetricsSettings extends IServiceMetricsSettings {
    database: string,
    table: string
}
