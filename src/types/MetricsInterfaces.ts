/**
 * Created by Bohdan on Sep, 2021
 */
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Meter from "@pm2/io/build/main/utils/metrics/meter";
import Counter from "@pm2/io/build/main/utils/metrics/counter";
import Histogram from "@pm2/io/build/main/utils/metrics/histogram";

export type MetricValue = Gauge | Meter | Counter | Histogram;

export enum MetricType {
    METRIC,
    METER,
    COUNTER,
    HISTOGRAM
}

export interface IMetricGroup {
    [metric: string]: IMetric
}

export interface IMetric {
    key: string,
    name?: string,
    type: MetricType
}

export interface IMetricsRepository {
    [metric: string]: MetricValue
}

export interface IMetricOptions {
    pool?: {
        id: number,
        name: string
    },
    service?: {
        id: number,
        name: string
    }
}

export interface IServiceMetricsSettings {
    database?: string,
    table?: string
}

export interface IDefaultServiceMetricsSettings extends IServiceMetricsSettings {
    database: string,
    table: string
}
