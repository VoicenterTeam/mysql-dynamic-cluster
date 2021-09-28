/**
 * Created by Bohdan on Sep, 2021
 */

import pm2io from '@pm2/io'
import { Metric, MetricGroup, MetricsRepository, MetricType } from "../types/MetricsInterfaces";
import Logger from "../utils/Logger";
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import Counter from "@pm2/io/build/main/utils/metrics/counter";
import Meter from "@pm2/io/build/main/utils/metrics/meter";

/**
 * Real-time metrics
 */
class Metrics {
    private metricsRepository: MetricsRepository = {};

    /**
     * set value in metric with type Metric
     * @param metric metric object
     * @param value the value to be changed
     */
    public set(metric: Metric, value: number) {
        if (!Metrics._isMetricTypeValid(metric.type, MetricType.METRIC)) return;

        this._createMetric(metric);
        (this.metricsRepository[metric.key] as Gauge).set(value);
    }

    /**
     * Increase value by 1 in metric with type Counter
     * @param metric metric object
     */
    public inc(metric: Metric) {
        if (!Metrics._isMetricTypeValid(metric.type, MetricType.COUNTER)) return;

        this._createMetric(metric);
        (this.metricsRepository[metric.key] as Counter).inc();
    }

    /**
     * decrease value by 1 in metric with type Counter
     * @param metric metric object
     */
    public dec(metric: Metric) {
        if (!Metrics._isMetricTypeValid(metric.type, MetricType.COUNTER)) return;

        this._createMetric(metric);
        (this.metricsRepository[metric.key] as Counter).dec();
    }

    /**
     * Mark the state to compute frequency in metric with type Meter
     * @param metric metric object
     */
    public mark(metric: Metric) {
        if (!Metrics._isMetricTypeValid(metric.type, MetricType.METER)) return;

        this._createMetric(metric);
        (this.metricsRepository[metric.key] as Meter).mark();
    }

    /**
     * Activate metrics to see them in the panel
     * @param metricGroup group of metrics
     */
    public activateMetrics(metricGroup: MetricGroup) {
        for (const [, value] of Object.entries(metricGroup)) {
            switch (value.type) {
                case MetricType.METRIC:
                    this.set(value, 0);
                    break;
                case MetricType.COUNTER:
                    this.inc(value);
                    this.dec(value);
                    break;
            }
        }
    }

    /**
     * check if type is valid for current metric
     * @param metricType type of metric what want to check
     * @param type type what need to compare with current metric
     * @private
     */
    private static _isMetricTypeValid(metricType: MetricType, type: MetricType): boolean {
        if (metricType !== type) {
            Logger.error("Metric type is not a " + MetricType[type]);
            return false;
        }
        return true;
    }

    /**
     * Create metric and set it to the metric repository if doesn't exist
     * @param metric metric object
     * @private
     */
    private _createMetric(metric: Metric) {
        const metricKey = metric.key;
        const metricName = metric.name ? metric.name : metricKey;
        if (this.metricsRepository[metricKey]) return;

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
    }
}

export default new Metrics();
