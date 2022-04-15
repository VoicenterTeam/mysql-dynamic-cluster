/**
 * Created by Bohdan on Sep, 2021
 */
import { MetricType } from "../types/MetricsInterfaces";

/**
 * All metric names used in the program. Structure:
 * {
 *     (group): {
 *          (metric): Metric
 *      }
 * }
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
            name: 'Cluster successful queries',
            type: MetricType.COUNTER
        },
        errorQueries: {
            key: 'cluster_error_queries',
            name: 'Cluster error queries',
            type: MetricType.COUNTER
        },
        queryTime: {
            key: 'cluster_query_time',
            name: 'Cluster query time',
            type: MetricType.METRIC
        },
        queryPerMinute: {
            key: 'cluster_query_per_minute',
            name: 'Cluster query per minute',
            type: MetricType.METER
        }
    },
    pool: {
        allQueries: {
            key: 'pool_all_queries',
            name: 'Pool all queries',
            type: MetricType.COUNTER
        },
        successfulQueries: {
            key: 'pool_successful_queries',
            name: 'Pool successful queries',
            type: MetricType.COUNTER
        },
        errorQueries: {
            key: 'pool_error_queries',
            name: 'Pool error queries',
            type: MetricType.COUNTER
        },
        queryTime: {
            key: 'pool_query_time',
            name: 'Pool query time',
            type: MetricType.METRIC
        },
        queryPerMinute: {
            key: 'pool_query_per_minute',
            name: 'Pool query per minute',
            type: MetricType.METER
        }
    }
    // services: {
    //     allQueries: {
    //         key: 'services_all_queries',
    //         name: 'Services all queries',
    //         type: MetricType.COUNTER
    //     },
    //     successfulQueries: {
    //         key: 'services_successful_queries',
    //         name: 'Services all successful queries',
    //         type: MetricType.COUNTER
    //     },
    //     errorQueries: {
    //         key: 'services_error_queries',
    //         name: 'Services all error queries',
    //         type: MetricType.COUNTER
    //     }
    // }
}

export default MetricNames;
