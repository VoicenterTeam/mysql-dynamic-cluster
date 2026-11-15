/**
 * Created by Bohdan on Sep, 2021
 */

/**
 * OpenTelemetry instrumentation scope, metric names and attribute keys.
 * Every metric name lives under the package's own `mysql_dynamic_cluster.*` namespace, so it never
 * collides with the convention metric a wrapper or app records for the same calls.
 * The `db.*`, `server.*` and `error.type` attribute keys follow the database client
 * semantic conventions
 */
export const SCOPE_NAME = '@voicenter-team/mysql-dynamic-cluster';

const MetricNames = {
    // one record per query attempt in a pool
    operationDuration: {
        name: 'mysql_dynamic_cluster.operation.duration',
        description: 'Duration of query attempts in one pool'
    },
    // one record per cluster query, after cache and retries
    queryDuration: {
        name: 'mysql_dynamic_cluster.query.duration',
        description: 'Duration of cluster queries, including cache lookup and retries'
    },
    // one record per Redis cache lookup
    cacheLookupDuration: {
        name: 'mysql_dynamic_cluster.cache.lookup.duration',
        description: 'Duration of Redis cache lookups'
    }
}

export const MetricAttributes = {
    dbSystem: 'db.system.name',
    dbNamespace: 'db.namespace',
    dbOperation: 'db.operation.name',
    dbStatusCode: 'db.response.status_code',
    errorType: 'error.type',
    serverAddress: 'server.address',
    serverPort: 'server.port',
    poolName: 'db.client.connection.pool.name',
    clusterName: 'mysql_dynamic_cluster.cluster.name',
    serviceName: 'mysql_dynamic_cluster.service.name',
    resultSource: 'mysql_dynamic_cluster.result.source',
    cacheResult: 'mysql_dynamic_cluster.cache.result'
}

export default MetricNames;
