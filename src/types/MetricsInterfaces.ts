/**
 * Created by Bohdan on Sep, 2021
 */
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Meter from "@pm2/io/build/main/utils/metrics/meter";
import Counter from "@pm2/io/build/main/utils/metrics/counter";

export enum MetricType {
    METRIC,
    METER,
    COUNTER
}

export interface MetricGroup {
    [metric: string]: Metric
}

export interface Metric {
    key: string,
    name?: string,
    type: MetricType
}

export interface MetricsRepository {
    [metric: string]: Gauge | Meter | Counter
}

export interface MetricOptions {
    pool?: {
        id: number,
        name: string
    },
    service?: {
        id: number,
        name: string
    }
}
