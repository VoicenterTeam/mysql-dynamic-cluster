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
    },
    // read at each collection: one point per node and connection state
    connectionCount: {
        name: 'mysql_dynamic_cluster.connection.count',
        description: 'Open connections of a node, by state'
    },
    // read at each collection: one point per node
    connectionPendingRequests: {
        name: 'mysql_dynamic_cluster.connection.pending_requests',
        description: 'Requests waiting for a connection of a node'
    },
    // read at each collection: one point per node that has a limit
    connectionLimit: {
        name: 'mysql_dynamic_cluster.connection.limit',
        description: 'Most connections a node may have open'
    },
    // one record per query attempt of Pool.query: the time it waited for a connection
    connectionWaitTime: {
        name: 'mysql_dynamic_cluster.connection.wait_time',
        description: 'Time a query attempt waited for a connection of a node'
    },
    // one record per finished health check of a node
    healthCheckDuration: {
        name: 'mysql_dynamic_cluster.health_check.duration',
        description: 'Duration of the health checks of a node'
    },
    // read at each collection: one point per node, 1 or 0
    nodeValid: {
        name: 'mysql_dynamic_cluster.node.valid',
        description: 'Whether a node is valid: 1 when queries may go to it, 0 when not'
    },
    // read at each collection: one point per node
    nodeLoadScore: {
        name: 'mysql_dynamic_cluster.node.load_score',
        description: 'Load score of a node from its last answered health check, lower is better'
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
    connectionState: 'db.client.connection.state',
    clusterName: 'mysql_dynamic_cluster.cluster.name',
    serviceName: 'mysql_dynamic_cluster.service.name',
    resultSource: 'mysql_dynamic_cluster.result.source',
    cacheResult: 'mysql_dynamic_cluster.cache.result',
    healthCheckResult: 'mysql_dynamic_cluster.health_check.result',
    attemptStep: 'mysql_dynamic_cluster.attempt.step'
}

export default MetricNames;
