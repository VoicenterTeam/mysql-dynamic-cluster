import { IMetric, IMetricOptions } from "../types/MetricsInterfaces";
import Metrics from "../metrics/Metrics";

export class QueryTimer {
    private _timeStart: number;
    private _timeEnd: number;
    private _queryTime: number;
    private readonly _metric: IMetric;

    /**
     * @param metric metric object
     */
    constructor(metric: IMetric) {
        this._metric = metric;
    }

    /**
     * Start counting query time
     */
    public start(): void {
        this._timeStart = QueryTimer._getTime();
    }

    /**
     * Stop counting query time
     */
    public end(): void {
        this._timeEnd = QueryTimer._getTime();
        this._queryTime = Math.abs(this._timeStart - this._timeEnd) / 1000;
    }

    /**
     * Set query time to Metric
     * @param options extra options for metric like pool name or service name
     */
    public save(options?: IMetricOptions): void {
        Metrics.set(this._metric, this._queryTime, options);
    }

    /**
     * Get query time
     */
    public get(): number {
        return this._queryTime;
    }

    /**
     * Get time now
     * @private
     */
    private static _getTime(): number {
        return new Date().getTime();
    }
}
