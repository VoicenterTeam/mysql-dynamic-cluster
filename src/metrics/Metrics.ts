/**
 * Created by Bohdan on Sep, 2021
 */

import { metrics, Attributes, Histogram, MeterProvider } from '@opentelemetry/api';
import MetricNames, { MetricAttributes, SCOPE_NAME } from "./MetricNames";
import Logger from "../utils/Logger";
import {
    CacheLookupResult,
    IOperationMetricOptions,
    IQueryMetricOptions
} from "../types/MetricsInterfaces";

// Bucket boundaries the database client conventions recommend for operation durations, in seconds
const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];

// Operation names that may become an attribute value. Anything else is left out, to keep
// cardinality fixed
const OPERATION_NAMES = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CALL', 'SHOW', 'SET',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'USE', 'START', 'BEGIN', 'COMMIT', 'ROLLBACK'
]);

interface IInstruments {
    operationDuration: Histogram,
    queryDuration: Histogram,
    cacheLookupDuration: Histogram
}

/**
 * Metrics through the OpenTelemetry API. The package never starts an SDK or an exporter:
 * until the host app registers a MeterProvider every call here is a no-op
 */
class Metrics {
    private clusterName: string;
    private _provider: MeterProvider;
    private _instruments: IInstruments;
    private _failureLogged: boolean = false;

    /**
     * Initialize metrics
     * @param clusterName cluster name added to every metric as an attribute
     */
    public init(clusterName: string) {
        this.clusterName = clusterName;
    }

    /**
     * Record one query attempt in a pool
     * @param seconds how long the attempt took
     * @param options pool, database, service and error of the attempt
     */
    public recordOperation(seconds: number, options: IOperationMetricOptions) {
        this._safely(() => {
            const attributes = this._baseAttributes(options);
            attributes[MetricAttributes.serverAddress] = options.host;
            attributes[MetricAttributes.serverPort] = options.port;
            attributes[MetricAttributes.poolName] = options.poolName;

            this._getInstruments().operationDuration.record(seconds, attributes);
        });
    }

    /**
     * Record one cluster query, after cache and retries
     * @param seconds how long the query took
     * @param options result source, database, service and error of the query
     */
    public recordQuery(seconds: number, options: IQueryMetricOptions) {
        this._safely(() => {
            const attributes = this._baseAttributes(options);
            if (options.source) attributes[MetricAttributes.resultSource] = options.source;

            this._getInstruments().queryDuration.record(seconds, attributes);
        });
    }

    /**
     * Record one Redis cache lookup
     * @param seconds how long the lookup took
     * @param result was the key found and still fresh
     */
    public recordCacheLookup(seconds: number, result: CacheLookupResult) {
        this._safely(() => {
            const attributes: Attributes = { [MetricAttributes.cacheResult]: result };
            if (this.clusterName) attributes[MetricAttributes.clusterName] = this.clusterName;

            this._getInstruments().cacheLookupDuration.record(seconds, attributes);
        });
    }

    /**
     * Operation name of a single statement: its first keyword, when it is a known one.
     * Left out for anything else, including text with more than one statement.
     * A plain scan, one pass over the text: a regex here backtracked on runs of whitespace
     * or comments
     * @param sql sql string
     */
    public static operationName(sql?: string): string | undefined {
        if (!sql) return undefined;

        const start = Metrics._skipLeading(sql);
        let end = start;
        while (end < sql.length && Metrics._isLetter(sql.charCodeAt(end))) end++;
        if (end === start) return undefined;

        const name = sql.slice(start, end).toUpperCase();
        if (!OPERATION_NAMES.has(name)) return undefined;
        // a second statement after the first one: no single operation describes the call
        if (Metrics._hasSecondStatement(sql, end)) return undefined;

        return name;
    }

    /**
     * Index of the first character after leading whitespace, comments and brackets.
     * The length of the text when a comment never ends
     * @private
     */
    private static _skipLeading(sql: string): number {
        let i = 0;
        while (i < sql.length) {
            const char = sql[i];
            if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '(') {
                i++;
            } else if (char === '/' && sql[i + 1] === '*') {
                const close = sql.indexOf('*/', i + 2);
                i = close === -1 ? sql.length : close + 2;
            } else if (char === '#' || (char === '-' && sql[i + 1] === '-')) {
                const lineEnd = sql.indexOf('\n', i);
                i = lineEnd === -1 ? sql.length : lineEnd + 1;
            } else {
                break;
            }
        }
        return i;
    }

    /**
     * Is there anything but whitespace after a `;` that stands outside quotes
     * @private
     */
    private static _hasSecondStatement(sql: string, from: number): boolean {
        let quote = '';
        let ended = false;
        for (let i = from; i < sql.length; i++) {
            const char = sql[i];
            if (quote) {
                if (char === '\\') i++;
                else if (char === quote) quote = '';
            } else if (ended) {
                if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') return true;
            } else if (char === "'" || char === '"' || char === '`') {
                quote = char;
            } else if (char === ';') {
                ended = true;
            }
        }
        return false;
    }

    private static _isLetter(code: number): boolean {
        return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    }

    /**
     * Run a record and swallow whatever it throws. The record goes into the MeterProvider the
     * host app registered, and a failure there must never fail a query or run it twice
     * @private
     */
    private _safely(record: () => void) {
        try {
            record();
        } catch (e) {
            // metrics are best effort. The first failure is logged once, so a broken SDK
            // is not silent
            if (this._failureLogged) return;
            this._failureLogged = true;
            try {
                const reason = e && e.message;
                Logger.warn("Recording a metric failed, further failures are not logged: " + reason);
            } catch (logError) {
                // the logger is not ready
            }
        }
    }

    /**
     * Attributes shared by the query metrics
     * @private
     */
    private _baseAttributes(options: IQueryMetricOptions): Attributes {
        const { database, serviceName, sql, error } = options;
        const attributes: Attributes = { [MetricAttributes.dbSystem]: 'mysql' };

        if (this.clusterName) attributes[MetricAttributes.clusterName] = this.clusterName;
        if (database) attributes[MetricAttributes.dbNamespace] = database;
        if (serviceName) attributes[MetricAttributes.serviceName] = serviceName;

        const operation = Metrics.operationName(sql);
        if (operation) attributes[MetricAttributes.dbOperation] = operation;

        if (error) {
            // mysql2 error code like ER_ACCESS_DENIED_ERROR or ECONNREFUSED
            const code = typeof error.code === 'string' && error.code ? error.code : '_OTHER';
            attributes[MetricAttributes.errorType] = code;
            if (typeof error.errno === 'number') {
                attributes[MetricAttributes.dbStatusCode] = String(error.errno);
            }
        }

        return attributes;
    }

    /**
     * Instruments of the current global MeterProvider. They are created again when the app
     * registers its provider after the first record, otherwise they would stay no-op forever
     * @private
     */
    private _getInstruments(): IInstruments {
        const provider = metrics.getMeterProvider();
        if (this._instruments && provider === this._provider) return this._instruments;

        const meter = provider.getMeter(SCOPE_NAME, Metrics._packageVersion());
        const histogram = (metric: { name: string, description: string }) => {
            return meter.createHistogram(metric.name, {
                description: metric.description,
                unit: 's',
                advice: { explicitBucketBoundaries: DURATION_BUCKETS }
            });
        };

        this._provider = provider;
        this._instruments = {
            operationDuration: histogram(MetricNames.operationDuration),
            queryDuration: histogram(MetricNames.queryDuration),
            cacheLookupDuration: histogram(MetricNames.cacheLookupDuration)
        };

        return this._instruments;
    }

    /**
     * Version from the package's own package.json: three levels up from dist, two from the sources
     * @private
     */
    private static _packageVersion(): string | undefined {
        for (const path of ['../../../package.json', '../../package.json']) {
            try {
                const pkg = require(path);
                if (pkg.name === SCOPE_NAME) return pkg.version;
            } catch (e) {
                // not at this depth
            }
        }

        return undefined;
    }
}

export { Metrics as MetricsClass };
export default new Metrics();
