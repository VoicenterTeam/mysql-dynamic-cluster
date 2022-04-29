/**
 * Created by Bohdan on Sep, 2021
 */
import { MetricType } from "../types/MetricsInterfaces";

/**
 * All metric names used in the program. Structure:
 * {
 *     (group name): {
 *          (metric name): <Metric> {
 *              key: string,
 *              name?: string,
 *              type: MetricType
 *          }
 *      }
 * }
 *
 * Metric types:
 * COUNTER - Things that increment or decrement
 * METER - Things that are measured as events / interval
 * METRIC - Values that can be read instantly
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
    },
    redis: {
        uses: {
            key: 'redis_uses',
            name: 'Redis uses',
            type: MetricType.COUNTER
        },
        expired: {
            key: 'redis_expired',
            name: 'Redis expired',
            type: MetricType.COUNTER
        },
        latency: {
            key: 'redis_latency',
            name: 'Redis latency',
            type: MetricType.METRIC
        }
    }
}

export default MetricNames;
