/**
 * Created by Bohdan on Sep, 2021
 */

import pm2io from '@pm2/io'
import {
    IMetric,
    IMetricOptions,
    IMetricsRepository,
    MetricType,
    MetricValue
} from "../types/MetricsInterfaces";
import Logger from "../utils/Logger";
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Counter from "@pm2/io/build/main/utils/metrics/counter";
import Meter from "@pm2/io/build/main/utils/metrics/meter";

/**
 * Real-time metrics
 */
class Metrics {
    private metricsRepository: IMetricsRepository = {};
    private clusterName: string;
    private showKeys: boolean;

    /**
     * Initialize metrics
     * @param clusterName cluster name used for prefix in metric names
     * @param showKeys show keys instead names
     */
    public init(clusterName: string, showKeys: boolean) {
        this.clusterName = clusterName;
        this.showKeys = showKeys;
    }

    /**
     * set value in metric with type Metric
     * @param metric metric object
     * @param value the value what need to change
     * @param options extra options for metric like pool name or service name
     */
    public set(metric: IMetric, value: number, options?: IMetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.METRIC)) return;

        this._getMetricValues(metric, options).forEach(metricValue => {
            (metricValue as Gauge).set(value);
        })
    }

    /**
     * Increase value by 1 in metric with type Counter
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     */
    public inc(metric: IMetric, options?: IMetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.COUNTER)) return;

        this._getMetricValues(metric, options).forEach(metricValue => {
            (metricValue as Counter).inc();
        })
    }

    /**
     * Decrease value by 1 in metric with type Counter
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     */
    public dec(metric: IMetric, options?: IMetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.COUNTER)) return;

        this._getMetricValues(metric, options).forEach(metricValue => {
            (metricValue as Counter).dec();
        })
    }

    /**
     * Mark the state to compute frequency in metric with type Meter
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     */
    public mark(metric: IMetric, options?: IMetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.METER)) return;

        this._getMetricValues(metric, options).forEach(metricValue => {
            (metricValue as Meter).mark();
        })
    }

    /**
     * Check if type is valid for current metric
     * @param metric metric object
     * @param type type what need to compare with current metric
     * @private
     */
    private static _isMetricTypeValid(metric: IMetric, type: MetricType): boolean {
        if (metric.type === type) return true;

        Logger.error(`Metric type of ${metric.key} is not valid. Should be ${MetricType[type]}`);
        return false;
    }

    /**
     * Get formatted metric key and name with prefix by cluster name and extra options
     * @param metric metric object
     * @param useService use service options to generate prop
     * @param options extra options for metric like pool name or service name
     * @private
     */
    private _generatePrefixes(metric: IMetric, options?: IMetricOptions, useService: boolean = false): IMetric {
        const newMetric: IMetric = {
            key: `${this.clusterName}_`,
            name: `[${this.clusterName}] `,
            type: metric.type
        }
        if (options?.service && useService) {
            newMetric.key += `${options.service.id}_`;
            newMetric.name += `[${options.service.name}] `;
        }
        if (options?.pool) {
            newMetric.key += `${options.pool.id}_`;
            newMetric.name += `[${options.pool.name}] `;
        }
        newMetric.key += metric.key;
        newMetric.name = metric.name && !this.showKeys ? newMetric.name + metric.name : newMetric.key;

        return newMetric;
    }

    /**
     * Get all metric separated to service metric and common
     * @param metric metric object
     * @param options extra options for metric like pool name or/and service name
     * @private
     */
    private _getMetricValues(metric: IMetric, options?: IMetricOptions): MetricValue[] {
        const metrics: IMetric[] = [];
        const metricValues: MetricValue[] = [];

        if (options?.service) {
            metrics.push(this._generatePrefixes(metric, options, true));
        }
        metrics.push(this._generatePrefixes(metric, options));

        metrics.forEach(metricProp => {
            if (!this.metricsRepository[metricProp.key]) {
                this._createMetric(metricProp)
            }
            metricValues.push(this.metricsRepository[metricProp.key])
        })

        return metricValues
    }

    /**
     * Create metric
     * @param metric metric object
     * @private
     */
    private _createMetric(metric: IMetric): void {
        const metricKey = metric.key;
        const metricName = metric.name;

        switch (metric.type) {
            case MetricType.METRIC:
                this.metricsRepository[metricKey] = pm2io.metric({
                    name: metricName
                })
                break;
            case MetricType.COUNTER:
                this.metricsRepository[metricKey] = pm2io.counter({
                    name: metricName
                });
                break;
            case MetricType.METER:
                this.metricsRepository[metricKey] = pm2io.meter({
                    name: metricName
                })
                break;
            default:
                Logger.error(`Metric type ${MetricType[metric.type]} doesn't exist`);
        }
    }
}

export default new Metrics();
