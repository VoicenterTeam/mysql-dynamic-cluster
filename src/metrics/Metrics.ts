/**
 * Created by Bohdan on Sep, 2021
 */

import {
    metrics,
    Attributes,
    BatchObservableResult,
    Histogram,
    Meter,
    MeterProvider,
    ObservableUpDownCounter
} from '@opentelemetry/api';
import MetricNames, { MetricAttributes, SCOPE_NAME } from "./MetricNames";
import Logger from "../utils/Logger";
import {
    CacheLookupResult,
    ConnectionState,
    IOperationMetricOptions,
    IPoolMetricSource,
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

// The connection metrics of the pools, and the callback that reports them. Kept together so
// the callback can be taken off the same meter and instruments it was added to
interface IPoolInstruments {
    meter: Meter,
    connectionCount: ObservableUpDownCounter,
    pendingRequests: ObservableUpDownCounter,
    connectionLimit: ObservableUpDownCounter,
    callback: (result: BatchObservableResult) => void
}

/**
 * Metrics through the OpenTelemetry API. The package never starts an SDK or an exporter:
 * until the host app registers a MeterProvider every call here is a no-op
 */
class Metrics {
    private clusterName: string;
    private _provider: MeterProvider;
    private _instruments: IInstruments;
    private _poolInstruments: IPoolInstruments;
    // pools of the connected clusters. A set, so a second connect() adds no pool twice
    private readonly _pools: Set<IPoolMetricSource> = new Set();
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
     * Report the connection metrics of these pools at every collection, until they are
     * unregistered. A pool that is registered already is not added again
     * @param pools pools of a cluster that connects
     */
    public registerPools(pools: IPoolMetricSource[]) {
        this._safely(() => {
            Metrics._mustBeList(pools, 'registerPools');
            pools.forEach(pool => this._pools.add(pool));
            // the instruments are created here when the app registered its provider by now
            this._getInstruments();
        });
    }

    /**
     * Stop reporting the connection metrics of these pools
     * @param pools pools of a cluster that disconnects
     */
    public unregisterPools(pools: IPoolMetricSource[]) {
        this._safely(() => {
            Metrics._mustBeList(pools, 'unregisterPools');
            pools.forEach(pool => this._pools.delete(pool));
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
        // after the histograms, and on its own: a provider that fails here still gets the
        // durations
        this._safely(() => this._movePoolInstruments(meter));

        return this._instruments;
    }

    /**
     * Create the connection metrics on the meter of the new provider and report the pools
     * there. The callback is taken off the provider before first, so the pools are not read
     * for a provider the app replaced
     * @private
     */
    private _movePoolInstruments(meter: Meter) {
        const old = this._poolInstruments;
        this._poolInstruments = undefined;
        if (old) {
            this._safely(() => {
                old.meter.removeBatchObservableCallback(old.callback, Metrics._observables(old));
            });
        }

        const upDownCounter = (metric: { name: string, description: string }, unit: string) => {
            return meter.createObservableUpDownCounter(metric.name, {
                description: metric.description,
                unit
            });
        };
        const instruments: IPoolInstruments = {
            meter,
            connectionCount: upDownCounter(MetricNames.connectionCount, '{connection}'),
            pendingRequests: upDownCounter(MetricNames.connectionPendingRequests, '{request}'),
            connectionLimit: upDownCounter(MetricNames.connectionLimit, '{connection}'),
            callback: (result) => this._observePools(result, instruments)
        };
        // one callback for the three: a pool is read once per collection, so its counts fit
        // together
        meter.addBatchObservableCallback(instruments.callback, Metrics._observables(instruments));
        this._poolInstruments = instruments;
    }

    private static _observables(instruments: IPoolInstruments): ObservableUpDownCounter[] {
        const { connectionCount, pendingRequests, connectionLimit } = instruments;
        return [connectionCount, pendingRequests, connectionLimit];
    }

    /**
     * Throw when the pools handed to a method are not a list. The caller runs inside
     * _safely, so the cluster that passed them is not failed, and the log names the argument
     * @private
     */
    private static _mustBeList(pools: unknown, method: string) {
        if (!Array.isArray(pools)) throw new TypeError(method + ": pools must be an array");
    }

    /**
     * Report every registered pool. The SDK calls it at each collection. A pool that cannot be
     * read is left out, and the others are still reported: what is thrown here would cost the
     * collection every pool
     * @private
     */
    private _observePools(result: BatchObservableResult, instruments: IPoolInstruments) {
        this._pools.forEach(pool => this._safely(() => {
            const attributes: Attributes = {
                [MetricAttributes.poolName]: pool.name,
                [MetricAttributes.serverAddress]: pool.host,
                [MetricAttributes.serverPort]: pool.port
            };
            if (this.clusterName) attributes[MetricAttributes.clusterName] = this.clusterName;
            const state = (value: ConnectionState): Attributes => {
                return { ...attributes, [MetricAttributes.connectionState]: value };
            };

            // read before the first observe, so a pool that throws reports nothing at all
            const { used, idle, pending } = pool.stats();
            result.observe(instruments.connectionCount, idle, state('idle'));
            result.observe(instruments.connectionCount, used, state('used'));
            result.observe(instruments.pendingRequests, pending, attributes);
            // 0 means no limit, which is not a number of connections
            if (pool.connectionLimit) {
                result.observe(instruments.connectionLimit, pool.connectionLimit, attributes);
            }
        }));
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
