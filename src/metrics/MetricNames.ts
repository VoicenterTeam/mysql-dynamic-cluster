/**
 * Created by Bohdan on Sep, 2021
 */
import { MetricType } from "../types/MetricsInterfaces";

/**
 * Structure:
 * [group]: {
 *      [metric]: Metric
 *  }
 */
const MetricNames = {
    cluster: {
        allQueries: {
            key: 'cluster_all_queries',
            name: 'Cluster all queries',
            type: MetricType.COUNTER
        },
        successfulQueries: {
            key: 'cluster_successful_queries',
            name: 'Cluster all successful queries',
            type: MetricType.COUNTER
        },
        errorQueries: {
            key: 'cluster_error_queries',
            name: 'Cluster all error queries',
            type: MetricType.COUNTER
        },
        queryTime: {
            key: 'cluster_query_time',
            name: 'Cluster query time',
            type: MetricType.METRIC
        },
        queryPerSecond: {
            key: 'cluster_query_per_minute',
            name: 'Cluster query per minute',
            type: MetricType.METER
        }
    },
    pools: {
        allQueries: {
            key: 'pools_all_queries',
            name: 'Pools all queries',
            type: MetricType.COUNTER
        },
        successfulQueries: {
            key: 'pools_successful_queries',
            name: 'Pools all successful queries',
            type: MetricType.COUNTER
        },
        errorQueries: {
            key: 'pools_error_queries',
            name: 'Pools all error queries',
            type: MetricType.COUNTER
        },
        queryTime: {
            key: 'pools_query_time',
            name: 'Pools query time',
            type: MetricType.METRIC
        },
        queryPerSecond: {
            key: 'pools_query_per_minute',
            name: 'Pools query per minute',
            type: MetricType.METER
        }
    },
    services: {
        allQueries: {
            key: 'services_all_queries',
            name: 'Services all queries',
            type: MetricType.COUNTER
        },
        successfulQueries: {
            key: 'services_successful_queries',
            name: 'Services all successful queries',
            type: MetricType.COUNTER
        },
        errorQueries: {
            key: 'services_error_queries',
            name: 'Services all error queries',
            type: MetricType.COUNTER
        }
    }
}

export default MetricNames;
