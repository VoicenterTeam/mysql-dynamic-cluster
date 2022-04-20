/**
 * Created by Bohdan on Sep, 2021
 */

import pm2io from '@pm2/io'
import { Metric, MetricGroup, MetricOptions, MetricsRepository, MetricType } from "../types/MetricsInterfaces";
import Logger from "../utils/Logger";
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Counter from "@pm2/io/build/main/utils/metrics/counter";
import Meter from "@pm2/io/build/main/utils/metrics/meter";

/**
 * Real-time metrics
 */
class Metrics {
    private metricsRepository: MetricsRepository = {};
    private clusterName: string = "";
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
    public set(metric: Metric, value: number, options?: MetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.METRIC)) return;

        const metricKey = this._createMetric(metric, options);
        (this.metricsRepository[metricKey] as Gauge).set(value);
    }

    /**
     * Increase value by 1 in metric with type Counter
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     */
    public inc(metric: Metric, options?: MetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.COUNTER)) return;

        const metricKey = this._createMetric(metric, options);
        (this.metricsRepository[metricKey] as Counter).inc();
    }

    /**
     * Decrease value by 1 in metric with type Counter
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     */
    public dec(metric: Metric, options?: MetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.COUNTER)) return;

        const metricKey = this._createMetric(metric, options);
        (this.metricsRepository[metricKey] as Counter).dec();
    }

    /**
     * Mark the state to compute frequency in metric with type Meter
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     */
    public mark(metric: Metric, options?: MetricOptions) {
        if (!Metrics._isMetricTypeValid(metric, MetricType.METER)) return;

        const metricKey = this._createMetric(metric, options);
        (this.metricsRepository[metricKey] as Meter).mark();
    }

    /**
     * Activate metrics to see them immediately in the panel
     * @param metricGroup group of metrics
     */
    public activateMetrics(metricGroup: MetricGroup) {
        for (const [, metric] of Object.entries(metricGroup)) {
            switch (metric.type) {
                case MetricType.METRIC:
                    this.set(metric, 0);
                    break;
                case MetricType.COUNTER:
                    this.inc(metric);
                    this.dec(metric);
                    break;
            }
        }
    }

    /**
     * Check if type is valid for current metric
     * @param metric metric object
     * @param type type what need to compare with current metric
     * @private
     */
    private static _isMetricTypeValid(metric: Metric, type: MetricType): boolean {
        if (metric.type !== type) {
            Logger.error(`Metric type of ${metric.key} is not valid. Should be ${MetricType[type]}`);
            return false;
        }
        return true;
    }

    /**
     * Get formatted metric key and name with prefix by cluster name and extra options
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     * @private
     */
    private _generateMetricKeyName(metric: Metric, options?: MetricOptions): { key: string, name: string } {
        let key = `${this.clusterName}_`;
        let name = `[${this.clusterName}] `;
        if (options?.service) {
            key += `${options.service.id}_`
            name += `[${options.service.name}] `
        }
        if (options?.pool) {
            key += `${options.pool.id}_`;
            name += `[${options.pool.name}] `
        }
        key += metric.key;
        name = metric.name && !this.showKeys ? name + metric.name : key;
        return { key, name };
    }

    /**
     * Create metric and set it to the metric repository if doesn't exist
     * @param metric metric object
     * @param options extra options for metric like pool name or service name
     * @private
     */
    private _createMetric(metric: Metric, options?: MetricOptions): string {
        const { key: metricKey, name: metricName } = this._generateMetricKeyName(metric, options);
        if (this.metricsRepository[metricKey]) return metricKey;

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
        }

        return metricKey;
    }
}

export default new Metrics();
