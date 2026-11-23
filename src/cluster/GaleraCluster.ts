/**
 * Created by Bohdan on Sep, 2021
 */

import { IUserSettings } from "../types/SettingsInterfaces";
import {
    IAttemptTiming, IQueryOptions, IQueryOutcome, IQueryTiming, QueryValues, ClusterEvent,
    QueryResult
} from '../types/PoolInterfaces'
import Logger from "../utils/Logger";

import { PoolConnection } from 'mysql2';
// The format() and escape() mysql2 exports are these. Taken from the package's own dependency,
// 1.6 or later, whatever copy mysql2 resolves (#121)
import { escape as escapeValue, format as formatValues } from 'sql-escaper';
import { IPoolCall, Pool } from "../pool/Pool";
import { abortReason } from "../utils/Abort";
import { ClusterHashing } from "./ClusterHashing";
import { mayTryNextNode } from "./QueryRetry";
import Metrics from "../metrics/Metrics";
import Events from "../utils/Events";
import Redis from "../Redis/Redis";
import { IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";
import ServiceNames from "../utils/ServiceNames";
import { IRedisData } from "../types/RedisInterfaces";
import { QueryResultSource } from "../types/MetricsInterfaces";
import config from "../configs";
import {
    IClusterConnection, IGetConnectionOptions, INodeInfo, INodePoolStats, INodeReadyResult
} from "../types/NodeInterfaces";
import { types } from "util";

// each attempt of the node loop of a query, with what its pool filled in
type Attempts = { nodeId: number, timing: IAttemptTiming }[];

export class GaleraCluster {
    public connected: boolean = false;

    private readonly _pools: Pool[] = [];
    /**
     * Get all pools
     * @internal
     */
    public get pools(): Pool[] {
        return this._pools;
    }

    private readonly _useClusterHashing: boolean;
    private readonly _clusterHashing: ClusterHashing;
    private readonly _serviceNames: ServiceNames;
    private readonly _errorRetryCount: number; // retry count after query error
    private readonly _useRedis: boolean;

    private readonly _clusterName: string;
    private readonly _nullServiceName: string = "mdc"

    // the promise behind `ready`, and its resolver until a connect() call takes it
    private _ready: Promise<INodeReadyResult[]>;
    private _resolveReady?: (results: INodeReadyResult[]) => void;
    /**
     * Resolves once every pool finished the first connect of the current connect() call, with
     * one result per node. It never rejects. Pending until connect() is called. Every later
     * connect() call replaces it with a new promise
     */
    public get ready(): Promise<INodeReadyResult[]> {
        if (!this._ready) this._newReady();
        return this._ready;
    }

    // the promise behind `firstReady`, and its resolver until a connect() call takes it
    private _firstReady: Promise<INodeReadyResult[]>;
    private _resolveFirstReady?: (results: INodeReadyResult[]) => void;
    /**
     * Resolves when the first pool passed the first connect of the current connect() call, with
     * the results that are in by then, in the order of the nodes. When no pool passes it
     * resolves with every result, at the moment `ready` does. It never rejects. Pending until
     * connect() is called. Every later connect() call replaces it with a new promise
     */
    public get firstReady(): Promise<INodeReadyResult[]> {
        if (!this._firstReady) this._newFirstReady();
        return this._firstReady;
    }

    /**
     * @param userSettings global user settings
     */
    constructor() {
        Logger.debug("Configuring cluster...");

        this._useClusterHashing = config.current.useClusterHashing
        this._clusterName = config.current.clusterName
        this._errorRetryCount = config.current.errorRetryCount
        this._useRedis = config.current.redis.enabled
        const poolIds: number[] = this._sortPoolIds(config.current.hosts);

        config.current.hosts.forEach(poolSettings => {
            if (!poolSettings.id) {
                // id 0 counts as not set. The app that wrote 0 is told when
                // the node got another id
                const wroteZero = poolSettings.id === 0;
                poolSettings.id = poolIds.length <= 0 ? 0 : poolIds[poolIds.length - 1] + 1;
                poolIds.push(poolSettings.id);
                if (wroteZero && poolSettings.id !== 0) {
                    Logger.warn(`Host ${poolSettings.host}:${poolSettings.port} has id 0, which `
                        + `counts as not set: the node got the id ${poolSettings.id}`);
                }
            }
            // a host without `host` never gets here: the settings schema rejects it
            this._pools.push(
                new Pool(poolSettings, this._clusterName)
            )
        })
        // Ids that break a rule are kept as they are, with one warning per host (#71)
        config.current.hosts.forEach(poolSettings => {
            const id = poolSettings.id;
            const broken: string[] = [];
            if (id < 0) broken.push('is negative');
            if (!Number.isInteger(id)) broken.push('is not an integer');
            if (config.current.hosts.some(other => other !== poolSettings && other.id === id)) {
                broken.push('is the id of another host too');
            }
            // the hashing database keeps the id of a node in a signed TINYINT
            if (this._useClusterHashing && id > 127) {
                broken.push('is above 127, the highest id cluster hashing takes');
            }
            if (broken.length) {
                Logger.warn(`Host ${poolSettings.host}:${poolSettings.port} uses the id ${id}, `
                    + `which ${broken.join(' and ')}`);
            }
        })

        this._serviceNames = new ServiceNames(this, config.current.serviceMetrics);
        const hashingSettings = config.current.clusterHashing;
        this._clusterHashing = new ClusterHashing(this, this._clusterName, hashingSettings);

        Logger.info("Cluster configuration finished");
    }

    /**
     * Sort pool ids for mix userSettings and autogenerated ids
     * @param pools pools passed in userSettings
     * @private
     */
    private _sortPoolIds(pools: IUserPoolSettings[]): number[] {
        const poolIds: number[] = [];
        pools.forEach(pool => {
            if (pool.id) poolIds.push(pool.id);
        })
        poolIds.sort((a, b) => a - b);
        return poolIds;
    }

    /**
     * Connect all cluster pools what created from host information in config
     */
    public async connect(): Promise<void> {
        // the connection metrics of the pools are reported from here until disconnect()
        Metrics.registerPools(this._pools);
        // the first call resolves the promise `ready` already handed out, a later call a new one
        if (!this._resolveReady) this._newReady();
        const resolveReady = this._resolveReady;
        this._resolveReady = undefined;
        // the `ready` of this call: a later call makes a new one
        const ready = this._ready;
        // the same for `firstReady`
        if (!this._resolveFirstReady) this._newFirstReady();
        const resolveFirstReady = this._resolveFirstReady;
        this._resolveFirstReady = undefined;

        return new Promise((resolve, reject) => {
            Logger.debug("Connecting all pools");
            // no node to wait for: a query then fails with MDC_NO_NODE_AVAILABLE, as with no
            // valid node
            if (!this._pools.length) resolve();
            // the results that are in, each at the place of its node
            const settled: INodeReadyResult[] = [];
            const results = this._pools.map((pool, index) => {
                // the pool fills it: how the health check of this connect ended
                const outcome: CheckOutcome = {};
                const connecting = pool.connect(outcome);
                connecting.then(async () => {
                    if (this.connected) return;

                    this.connected = true;
                    if (this._useClusterHashing) await this._enableHashing();

                    Events.emit('connected');
                    Logger.info('Cluster connected');

                    resolve();
                }).catch(err => {
                    // the message when there is one. Nothing here may throw: a pool may reject
                    // with undefined, null or an object whose message cannot be read
                    let reason: string;
                    try {
                        reason = err?.message ? String(err.message) : String(err);
                    } catch {
                        reason = 'unreadable error';
                    }
                    Logger.error(reason);
                    reject(reason);
                });
                const result = GaleraCluster._readyResult(pool, connecting, outcome);
                result.then(ended => {
                    settled[index] = ended;
                    // only the first pass resolves it. filter leaves out the nodes not in yet
                    const inByNow = () => GaleraCluster._ownResults(settled.filter(() => true));
                    if (ended.ok) resolveFirstReady(inByNow());
                });
                return result;
            })
            const all = Promise.all(results);
            all.then(resolveReady);
            // no pool passed: every result, at the moment of `ready`. After a pass it does nothing
            all.then(everyResult => resolveFirstReady(GaleraCluster._ownResults(everyResult)));
            // No node passed: the pools of a connect() that failed report no metrics. Kept
            // when the cluster is connected, or when a later connect() call, which has a
            // `ready` of its own, runs
            all.then(() => {
                if (!this.connected && this._ready === ready) Metrics.unregisterPools(this._pools);
            });
        })
    }

    /**
     * Make the promise behind `ready` and keep its resolver for the connect() call that takes it
     * @private
     */
    private _newReady(): void {
        this._ready = new Promise(resolve => {
            this._resolveReady = resolve;
        });
    }

    /**
     * Make the promise behind `firstReady` and keep its resolver for the connect() call that
     * takes it
     * @private
     */
    private _newFirstReady(): void {
        this._firstReady = new Promise(resolve => {
            this._resolveFirstReady = resolve;
        });
    }

    /**
     * How the connect of one pool ended. The promise it returns never rejects
     * @param pool the pool
     * @param connecting the connect() of the pool
     * @param outcome the object that connect() fills with how its own health check ended
     * @private
     */
    private static _readyResult(
        pool: Pool, connecting: Promise<void>, outcome: CheckOutcome
    ): Promise<INodeReadyResult> {
        const nodeId = pool.id;
        // The outcome is read when the connect settled. A result carries the error of the check
        // of its own connect only, never what the pool holds from another check
        return connecting.then(
            // a pool that passed has one only when its check failed and it was still valid
            () => ({
                nodeId,
                ok: true,
                ...GaleraCluster._withCheckError(outcome.recorded ? outcome.checkError : undefined)
            }),
            reason => ({
                nodeId,
                ok: false,
                error: GaleraCluster._isError(reason) ? reason : new Error(String(reason)),
                ...GaleraCluster._failedCheckError(pool, outcome)
            })
        );
    }

    /**
     * The checkError field of the result of a connect that failed.
     * A check that was recorded gives its own error, or nothing when it got its answer and a
     * validator said no. A check that was dropped, or that never ran, gives an empty object:
     * the pool was closed or the connect was given up, so there is nothing of mysql2, the
     * socket or the server to report. That case is logged, since the empty object alone does
     * not tell it from a check that ran into its own timeout
     * @param pool the pool
     * @param outcome what connect() filled in
     * @private
     */
    private static _failedCheckError(
        pool: Pool, outcome: CheckOutcome
    ): Pick<INodeInfo, 'checkError'> {
        if (outcome.recorded) return GaleraCluster._withCheckError(outcome.checkError);
        // a pool that tells nothing about its check has nothing to report here
        if (outcome.recorded === undefined) return {};
        Logger.debug("The connect of a node ended without a recorded health check, " +
            "its result gets an empty checkError", { nodeId: pool.id, pool: pool.name });
        return { checkError: {} };
    }

    /**
     * The results for `firstReady`: a new array of new objects, each with a checkError object
     * of its own, so a write through a result of `firstReady` does not show in `ready`.
     * The Error of a failed node is the same object in both
     * @private
     */
    private static _ownResults(results: INodeReadyResult[]): INodeReadyResult[] {
        return results.map(result => ({
            ...result,
            ...GaleraCluster._withCheckError(result.checkError && { ...result.checkError })
        }));
    }

    /**
     * The checkError field of a result or of a node. Left out when there is no check error
     * @private
     */
    private static _withCheckError(
        checkError: INodeInfo['checkError']
    ): Pick<INodeInfo, 'checkError'> {
        return checkError ? { checkError } : {};
    }

    /**
     * An Error, also one that was made in another realm such as a vm context
     * @private
     */
    private static _isError(value: unknown): value is Error {
        return value instanceof Error || types.isNativeError(value);
    }

    /**
     * Enable hashing for cluster
     */
    private async _enableHashing() {
        try {
            await this._clusterHashing.connect();
            Events.emit('hashing_created');
            Logger.info("Cluster hashing enabled");
        } catch (e) {
            Logger.error(e.message);
        }
    }

    /**
     * Disconnect all cluster pools
     */
    public async disconnect() {
        Logger.debug("disconnecting all pools");
        this.connected = false;
        Metrics.unregisterPools(this._pools);
        this._clusterHashing?.stop();
        Redis.disconnect();
        this._pools.forEach((pool) => {
            pool.disconnect();
        })
        Events.emit('disconnected');
    }

    /**
     * Connect to the event
     * @param event event name
     * @param callback function what will be called after emit
     */
    public on(event: ClusterEvent, callback: (...args: any[]) => void) {
        Events.on(event, callback);
    }

    /**
     * Run one statement with its values bound by the server: query() with the option
     * `execute`. mysql2 prepares the statement once per connection and keeps it, and the values
     * never become part of the text. The same choice of node, retry rule, error, signal,
     * metrics and passive health as query(). No Redis
     * @param sql MySQL query, with a ? for each value
     * @param values the values, as an array
     * @param queryOptions params for configure query
     */
    public async execute<T extends QueryResult>(
        sql: string, values?: unknown[], queryOptions?: IQueryOptions
    ): Promise<T> {
        return this.query<T>(sql, values, { ...queryOptions, execute: true });
    }

    /**
     * Cluster mysql query
     * @param sql MySQL query
     * @param values values what passed in sql string. Written into the text and escaped, unless
     * the option `execute` asks the server to bind them
     * @param queryOptions params for configure query
     */
    public async query<T extends QueryResult>(sql: string, values?: QueryValues, queryOptions?: IQueryOptions): Promise<T> {
        queryOptions = {
            redis: this._useRedis,
            maxRetry: this._errorRetryCount,
            redisRefreshCache: false,
            ...queryOptions
        }
        // a bound statement is neither read from Redis nor written to it, in this version
        if (queryOptions.execute) queryOptions.redis = false;

        let activePools: Pool[]; // available pools for query what passed the validator
        let retryCount; // max retry query count after error
        let serviceId = queryOptions?.serviceId;

        const queryTimer = new QueryTimer();
        queryTimer.start();
        const originalSql = sql;
        // each attempt of the node loop, as its pool filled it. Empty for a call that asked
        // no node
        const attempts: Attempts = [];
        // one metric record per cluster query, whatever way it ends. So onTiming is called
        // here too: once, before the call settles
        const record = (source?: QueryResultSource, error?: any) => {
            queryTimer.end();
            Metrics.recordQuery(queryTimer.get(), {
                source,
                error,
                sql: originalSql,
                database: queryOptions.database,
                serviceName: queryOptions.serviceId
                    ? queryOptions.serviceName ?? String(queryOptions.serviceId)
                    : undefined
            });
            if (attempts.length) GaleraCluster._tellTiming(queryOptions.onTiming, attempts);
        }
        // What _formatSQL throws, such as the error of a toSqlString() of a value, is a failed
        // query too. A falsy one as well
        const formatSQL = (): string => {
            try {
                return this._formatSQL(sql, values);
            } catch (formatError) {
                record(undefined, formatError || {});
                throw formatError;
            }
        };

        // null stands for no signal, as undefined does
        const signal = queryOptions.signal ?? undefined;
        if (signal !== undefined && !GaleraCluster._isAbortSignal(signal)) {
            const error = new TypeError("query: options.signal must be an AbortSignal");
            record(undefined, error);
            throw error;
        }
        // as queryTimeout in the settings: a negative one fired at once. 0 means none
        if (queryOptions.timeout < 0) {
            const error = new TypeError("query: options.timeout must not be negative");
            record(undefined, error);
            throw error;
        }
        // null stands for no onTiming, as undefined does
        const onTiming = queryOptions.onTiming ?? undefined;
        if (onTiming !== undefined && typeof onTiming !== 'function') {
            const error = new TypeError("query: options.onTiming must be a function");
            record(undefined, error);
            throw error;
        }
        // mysql2 throws for other values, or fails after the prepare. Before any node.
        // includes() counts the holes of a sparse array as undefined
        const unbindable = queryOptions.execute && values !== undefined && values !== null
            && (!Array.isArray(values) || values.includes(undefined)
                || values.some(value => typeof value === 'function'));
        if (unbindable) {
            const error = new TypeError("execute: values must be an array, with no undefined " +
                "and no function in it");
            record(undefined, error);
            throw error;
        }
        // The values of an object take the named pass of _formatSQL. A :name of the object
        // inside quotes or backticks would get a quoted value, whose quotes close the literal
        // (#131). Before any node
        if (!queryOptions.execute && values && typeof values !== 'string'
            && !Array.isArray(values)) {
            const quoted = GaleraCluster._namedPlaceholders(sql, values)
                .find(found => found.quoted);
            if (quoted) {
                const error = Object.assign(new Error(`query: the placeholder :${quoted.key} is ` +
                    `inside quotes or backticks. Write it bare, as = :${quoted.key}`),
                    { code: 'MDC_QUOTED_PLACEHOLDER' });
                record(undefined, error);
                throw error;
            }
        }
        // The caller gave up: the call rejects with the reason of the signal as it is, never
        // with stale data of Redis. A falsy reason is a failed query to the metric too
        const stopIfAborted = () => {
            if (!signal?.aborted) return;
            const reason = abortReason(signal);
            record(undefined, reason || {});
            throw reason;
        };
        // before the service name, Redis and the nodes: an aborted call asks none of them
        stopIfAborted();

        try {
            if (!serviceId && queryOptions?.serviceName) {
                serviceId = await this._serviceNames.getID(queryOptions.serviceName);
                queryOptions.serviceId = serviceId;
            }
            if (!serviceId) {
                queryOptions.serviceId = 0;
                queryOptions.serviceName = `${this._clusterName}_${this._nullServiceName}`;
            }

            activePools = await this._getActivePools(serviceId);
            retryCount = this._maxRetryCount(queryOptions.maxRetry, activePools.length);
        } catch (e) {
            // the signal aborted while the nodes were looked for
            stopIfAborted();
            // no pool passed the validator: serve cached data, even expired, as when every pool fails
            if (queryOptions.redis && !queryOptions.redisRefreshCache) {
                const redisResult = await Redis.get(formatSQL());
                // or while Redis was read
                stopIfAborted();
                if (redisResult) {
                    Logger.warn("No valid pool. Use old data from Redis");
                    // parsed before the record: a cached value that doesn't parse is a failed query
                    let cached: IRedisData;
                    try {
                        cached = JSON.parse(redisResult);
                    } catch (parseError) {
                        record(undefined, parseError);
                        throw parseError;
                    }
                    record('stale_cache');
                    return cached.data;
                }
            }
            // MDC_NO_NODE_AVAILABLE of _getActivePools(). The lookup of a service name catches
            // its own errors
            record(undefined, e);
            throw e;
        }
        // the signal aborted during the lookup of the service name or of the nodes: no Redis,
        // no node
        stopIfAborted();

        // bound values stay apart from the text
        if (!queryOptions.execute) {
            sql = formatSQL();
            Logger.debug("formatSQL", {sql, values})
        }
        // The one rule for values in the text: the formatting changed it. The pool refuses
        // such a statement under NO_BACKSLASH_ESCAPES. [] and {}, or a :name the object does
        // not have, write nothing
        const valuesInText = sql !== originalSql;
        let redisData: IRedisData = null;
        if (queryOptions.redis && !queryOptions.redisRefreshCache) {
            const redisLatency = new QueryTimer();
            redisLatency.start();

            const redisResult = await Redis.get(sql);

            redisLatency.end();

            if (redisResult) {
                Logger.debug("Get result of query from redis");
                try {
                    redisData = JSON.parse(redisResult);
                } catch (parseError) {
                    Metrics.recordCacheLookup(redisLatency.get(), 'miss');
                    record(undefined, parseError);
                    throw parseError;
                }
                if (redisData.expired > Date.now()) {
                    Metrics.recordCacheLookup(redisLatency.get(), 'hit');
                    record('cache');
                    return redisData.data;
                }

                Metrics.recordCacheLookup(redisLatency.get(), 'expired');
            } else {
                Metrics.recordCacheLookup(redisLatency.get(), 'miss');
            }
        }

        // the error of each node tried, in the order they were tried
        const errors: { nodeId: number, error: any }[] = [];
        // what a pool rejected with when the signal aborted in its call
        let aborted: { reason: unknown } | undefined;

        for (let i = 0; i < retryCount; i++) {
            const pool = activePools[i];
            // the pool says in it whether the statement went to the node
            const outcome: IQueryOutcome = {};
            // and in this one where the attempt ended and how long it waited for a connection
            const timing: IAttemptTiming = {};
            attempts.push({ nodeId: pool.id, timing });
            let res: T;
            try {
                Logger.debug("Query use host: " + pool.host);
                res = await this._queryRequest(
                    sql, pool, queryOptions, outcome, { values, valuesInText, timing }
                ) as T;
            } catch (e) {
                if (outcome.aborted) {
                    // the reason of the signal is the app's: no node id goes on it
                    aborted = { reason: e };
                    Logger.debug(`Query in pool ${pool.name} was aborted`);
                } else {
                    errors.push({ nodeId: pool.id, error: GaleraCluster._fromNode(e, pool.id) });
                    Logger.error(`Query failed in pool ${pool.name}: ` +
                        GaleraCluster._failureText(e));
                }
                // a statement that may have run on this node must not run on another one, and
                // no node gets it once the signal aborted
                if (!mayTryNextNode(e, outcome, queryOptions)) break;
                if (i + 1 < retryCount) {
                    Logger.debug("Retrying query...");
                }
                continue;
            }
            // outside the try: what the bookkeeping throws is no failure of the node
            record('pool');
            return res;
        }

        // the signal aborted in a node, or before the next one was asked: no stale data
        if (aborted) {
            record(undefined, aborted.reason || {});
            throw aborted.reason;
        }
        stopIfAborted();

        if (redisData) {
            Logger.warn("The query failed. Use old data from Redis");
            record('stale_cache');
            return redisData.data;
        }

        // The error of the node tried last, as mysql2 made it. The nodes tried before it are
        // listed on it, so a caller can see every error without a second error type
        const { error } = errors.pop();
        GaleraCluster._listEarlier(error, errors);
        // a rejection without a value, or with a falsy one, is still a failed query to the metric
        record(undefined, error || {});
        throw error;
    }

    /**
     * Query request to pool
     * @param sql MySQL query string
     * @param pool active pool
     * @param queryOptions options to configure query
     * @param outcome handed to the pool, which says in it whether the statement was sent
     * @param call the values, valuesInText and the timing the pool fills, see Pool.query()
     * @private
     */
    private async _queryRequest<T extends QueryResult>(
        sql: string, pool: Pool, queryOptions: IQueryOptions, outcome: IQueryOutcome,
        call: IPoolCall
    ): Promise<T> {
        const result = await pool.query(sql, queryOptions, outcome, call) as T;

        if (queryOptions?.serviceId && this._clusterHashing.connected) {
            // the statement ran: a failure from here on must not send it to another node
            try {
                await this._clusterHashing?.updateNodeForService(queryOptions?.serviceId, pool.id);
            } catch (error) {
                Logger.warn("Query passed in pool " + pool.name + ", but the hashing table " +
                    "was not updated: " + (error?.message || error),
                    { nodeId: pool.id, serviceId: queryOptions.serviceId });
            }
        }
        return result;
    }

    /**
     * Call the onTiming of a query that asked a node: the step of the last attempt, its node,
     * and the time every attempt waited for a connection. It never throws: what onTiming
     * throws, and the rejection of a promise it returns, is logged once and changes nothing
     * of the call
     * @param onTiming the option of the query, or nothing
     * @param attempts the attempts of the node loop, in the order they were made
     * @private
     */
    private static _tellTiming(onTiming: IQueryOptions['onTiming'], attempts: Attempts): void {
        if (!onTiming) return;
        const last = attempts[attempts.length - 1];
        let warned = false;
        const failed = (thrown: unknown) => {
            if (warned) return;
            warned = true;
            GaleraCluster._timingFailed(thrown, last.nodeId);
        };
        try {
            const queuedMs = attempts.reduce(
                (sum, attempt) => sum + (attempt.timing.queuedMs ?? 0), 0
            );
            const step = last.timing.step ?? 'queue';
            const timing: IQueryTiming = { step, queuedMs, nodeId: last.nodeId };
            const returned: any = onTiming(timing);
            // an async onTiming: its rejection is logged, never left unhandled
            if (typeof returned?.then === 'function') returned.then(undefined, failed);
        } catch (thrown) {
            failed(thrown);
        }
    }

    /**
     * Log what onTiming threw, as text. A value that cannot be made text, such as a Symbol
     * or an object without a prototype, is named so: nothing here may throw
     * @param thrown what onTiming threw, or what the promise it returned rejected with
     * @param nodeId the node of the last attempt
     * @private
     */
    private static _timingFailed(thrown: unknown, nodeId: number): void {
        let text: string;
        try {
            text = String((thrown as any)?.message || thrown);
        } catch {
            text = 'a value that is not text';
        }
        // the logger catches what the logger of the app throws
        Logger.warn("onTiming of a query threw or rejected, the call keeps its result: " + text,
            { nodeId });
    }

    /**
     * Count max retry after error
     * @param maxRetry max retry count after error
     * @param activePoolsLength length active pools what passed the validator
     * @private
     */
    private _maxRetryCount(maxRetry: number, activePoolsLength: number): number {
        let retryCount = maxRetry && maxRetry > 0 ? maxRetry : this._errorRetryCount;
        if (retryCount > activePoolsLength) {
            Logger.warn("Active pools less than error retry count");
        }
        // one node at least: a query that tries none has no error of a node to reject with
        retryCount = Math.max(1, Math.min(retryCount, activePoolsLength));
        return retryCount;
    }

    /**
     * Mix together values and sql string. Every value is escaped, those of an object too.
     * sql-escaper's format() and escape() with the arguments of mysql2's, see the import
     * @param sql MySQL query
     * @param values values to mix with sql
     * @private
     */
    private _formatSQL(sql: string, values: QueryValues): string {
        if (values) {
            if (Array.isArray(values)) {
                return formatValues(sql, values);
            } else if (typeof values === 'string') {
                return formatValues(sql, values);
            } else {
                // one pass over the sql: a value that holds :name itself is not replaced again.
                // A :name in quotes or backticks stays as it is: query() refused it before
                let text = '';
                let last = 0;
                for (const found of GaleraCluster._namedPlaceholders(sql, values)) {
                    if (found.quoted) continue;
                    // true: a plain object becomes a quoted string, not `key` = value pairs
                    text += sql.slice(last, found.start) + escapeValue(values[found.key], true);
                    last = found.end;
                }
                return text + sql.slice(last);
            }
        }

        return sql;
    }

    /**
     * Each :name of the text whose key the object has as its own, in order. The text is read as
     * sql-escaper 1.7 reads it for a ?, see _contextEnd(): a :name inside a comment is text and
     * is left out, one inside /*! *\/ or /*+ *\/ is code, as sql-escaper treats a ? there, and
     * one inside quotes or backticks comes with quoted: true
     * @param sql MySQL query
     * @param values the named values
     * @private
     */
    private static _namedPlaceholders(sql: string, values: object) {
        const found: { key: string, start: number, end: number, quoted: boolean }[] = [];
        // the placeholders of own keys from start up to end
        const collect = (start: number, end: number, quoted: boolean) => {
            const placeholder = /:(\w+)/g;
            const part = sql.slice(start, end);
            let match: RegExpExecArray;
            while ((match = placeholder.exec(part))) {
                if (!Object.prototype.hasOwnProperty.call(values, match[1])) continue;
                const at = start + match.index;
                found.push({ key: match[1], start: at, end: at + match[0].length, quoted });
            }
        };
        // where the code not looked at yet starts
        let code = 0;
        for (let position = 0; position < sql.length; position++) {
            const end = GaleraCluster._contextEnd(sql, position);
            if (end === -1) continue;
            collect(code, position, false);
            // a comment is text
            if ("'\"`".includes(sql[position])) collect(position, end, true);
            code = end;
            position = end - 1;
        }
        collect(code, sql.length, false);
        return found;
    }

    /**
     * The end of the string, identifier or comment that opens at position, or -1 for code. A
     * port of skipSqlContext of sql-escaper 1.7, without ANSI_QUOTES. Unterminated, a context
     * runs to the end of the text
     * @param sql MySQL query
     * @param position where a context may open
     * @private
     */
    private static _contextEnd(sql: string, position: number): number {
        const length = sql.length;
        // a comment up to and including the line break
        const lineEnd = (start: number) => {
            const lineBreak = sql.indexOf('\n', start);
            return lineBreak === -1 ? length : lineBreak + 1;
        };
        const char = sql[position];
        if (char === "'" || char === '"') {
            // a string, until the same quote. A backslash skips the next character
            for (let cursor = position + 1; cursor < length; cursor++) {
                if (sql[cursor] === '\\') cursor++;
                else if (sql[cursor] === char) return cursor + 1;
            }
            return length;
        }
        if (char === '`') {
            // an identifier, until a backtick that is not doubled
            for (let cursor = position + 1; cursor < length; cursor++) {
                if (sql[cursor] !== '`') continue;
                if (sql[cursor + 1] === '`') {
                    cursor++;
                    continue;
                }
                return cursor + 1;
            }
            return length;
        }
        if (char === '#') return lineEnd(position + 1);
        const next = sql[position + 1];
        if (char === '-' && next === '-') {
            // -- with a space, a control character or the end of the text after it
            const afterDash = sql.charCodeAt(position + 2);
            return Number.isNaN(afterDash) || afterDash <= 32 ? lineEnd(position + 2) : -1;
        }
        if (char === '/' && next === '*') {
            // /*! and /*+ are code, as for a ? in sql-escaper
            const marker = sql[position + 2];
            if (marker === '!' || marker === '+') return -1;
            const commentEnd = sql.indexOf('*/', position + 2);
            return commentEnd === -1 ? length : commentEnd + 2;
        }
        return -1;
    }

    /**
     * Get all active pools what passed the validator
     * @param serviceId serviceId of what need to hashing in the cluster
     * @private
     */
    private async _getActivePools(serviceId?: number) : Promise<Pool[]> {
        let activePools: Pool[];
        let poolIdService: number = -1;

        if (serviceId && this._clusterHashing.connected) {
            poolIdService = this._clusterHashing.getNodeByService(serviceId);
        }

        activePools = this._validPools([poolIdService]);

        if (poolIdService >= 0) {
            const servicePool = this._pools.find(pool => pool.id === poolIdService);
            // only a valid pinned pool goes first. An invalid one is left out: it is never the
            // first attempt (#43)
            if (servicePool?.status.isValid) activePools.unshift(servicePool);
        }

        if (activePools.length < 1) {
            throw GaleraCluster._noNode("There is no pool that satisfies the parameters");
        }

        return activePools;
    }

    /**
     * Valid pools that are not in exclude, lowest load score first.
     * query() and getConnection() both choose their pools here
     * @param exclude ids of the pools to leave out
     * @private
     */
    private _validPools(exclude: number[]): Pool[] {
        return this._pools
            .filter(pool => pool.status.isValid && !exclude.includes(pool.id))
            .sort((a, b) => a.status.loadScore - b.status.loadScore);
    }

    /**
     * Take a connection of one node: the valid node with the lowest load score that is not
     * excluded. One node and one request to its pool, with no retry. The pool probes it when
     * it was idle, and its release() resets it before it goes back. The cluster sets no
     * timeout on it, does not change its database and records no metric for it. A query of
     * the cluster that gets it later sends USE first. See docs/node-api.md
     * @param options exclude: ids of the nodes to leave out. signal: ends the wait for the
     * connection when it aborts, the call then rejects with the reason of the signal as it is
     */
    public async getConnection(options?: IGetConnectionOptions): Promise<IClusterConnection> {
        const exclude = options?.exclude;
        const isIds = Array.isArray(exclude) && exclude.every(id => typeof id === 'number');
        if (exclude !== undefined && !isIds) {
            throw new TypeError("getConnection: options.exclude must be an array of numbers");
        }
        // null stands for no signal, as undefined does
        const signal = options?.signal ?? undefined;
        if (signal !== undefined && !GaleraCluster._isAbortSignal(signal)) {
            throw new TypeError("getConnection: options.signal must be an AbortSignal");
        }
        // before a node is looked for: an aborted call asks none, also when none is left
        if (signal?.aborted) throw abortReason(signal);

        const pool = this._validPools(exclude ?? [])[0];
        if (!pool) throw GaleraCluster._noNode("No valid node is left to take a connection from");

        // the pool sets `aborted` on it when the abort ended the call, not an error of the node
        const outcome: AbortOutcome = {};
        let connection: PoolConnection;
        try {
            connection = await pool.getConnection(signal, outcome);
        } catch (error) {
            // the reason of the signal belongs to the app. It goes back as it is
            if (outcome.aborted) throw error;
            throw GaleraCluster._fromNode(error, pool.id);
        }
        return { connection, nodeId: pool.id };
    }

    /**
     * The error query() and getConnection() reject with when no valid node is left
     * @private
     */
    private static _noNode(message: string): Error {
        return Object.assign(new Error(message), { code: 'MDC_NO_NODE_AVAILABLE' });
    }

    /**
     * Sets `errors` on the error a failed query() rejects with: the nodes tried before the
     * last one, as `{ nodeId, error }`. An error the app handed failWaiting() is one object
     * that many queries can meet, so an entry that leads back to the error, itself or
     * through the lists of earlier queries, is left out. The errors keep no cycle and can
     * be turned into JSON. An error that has an `errors` of its own, such as the
     * AggregateError of a host name whose every address refused, keeps it. A frozen error,
     * one that is no object, or one whose errors cannot be read, gets no list
     * @param error the error of the node tried last
     * @param earlier the error of each node tried before it, in the order they were tried
     */
    private static _listEarlier(error: any, earlier: { nodeId: number, error: any }[]): void {
        if (!error || typeof error !== 'object') return;
        try {
            // read in the try: a getter or a Proxy that throws here must not reject the call
            const own = error.errors;
            if (Array.isArray(own) && !GaleraCluster._lists.has(own)) return;
            const list = earlier.filter(entry => !GaleraCluster._leadsTo(entry.error, error));
            error.errors = list;
            GaleraCluster._lists.add(list);
        } catch {
            // a frozen error, or one whose errors cannot be read, goes to the caller without
            // the list
        }
    }

    // the lists _listEarlier() set, told apart from an errors array of the error's own
    private static _lists = new WeakSet<object>();

    // whether `target` is `from` or can be reached from it through the lists _listEarlier() set
    private static _leadsTo(from: any, target: any, seen = new Set<any>()): boolean {
        if (from === target) return true;
        if (!from || typeof from !== 'object' || seen.has(from)) return false;
        seen.add(from);
        try {
            const list = from.errors;
            if (!Array.isArray(list) || !GaleraCluster._lists.has(list)) return false;
            return list.some(entry => GaleraCluster._leadsTo(entry.error, target, seen));
        } catch {
            // errors that cannot be read lead nowhere
            return false;
        }
    }

    /**
     * The text of a failed attempt for its log line: the message, then the code and the errno
     * when the error has them. An error without a message, such as the AggregateError of a
     * host name whose every address refused, is named by its text. Nothing here may throw: a
     * getter that throws, or a value that cannot be made text, is left out
     * @param error what the node's call was rejected with
     * @private
     */
    private static _failureText(error: any): string {
        const text = (read: () => unknown): string => {
            try {
                return String(read() ?? '');
            } catch {
                return '';
            }
        };
        const message = text(() => error?.message) || text(() => error);
        const details = [['code', text(() => error?.code)], ['errno', text(() => error?.errno)]]
            .filter(([, value]) => value !== '')
            .map(([name, value]) => `${name} ${value}`)
            .join(', ');
        return [message, details && `(${details})`].filter(part => part).join(' ');
    }

    /**
     * The error of a node as the caller gets it: the error of mysql2 itself, so its code,
     * errno and message stay as mysql2 made them. Only the id of the node is added
     * @param error what the node's call was rejected with
     * @param nodeId id of the node
     * @returns the same error
     * @private
     */
    private static _fromNode<E>(error: E, nodeId: number): E {
        try {
            (error as any).nodeId = nodeId;
        } catch {
            // a frozen error, or one that is no object, goes to the caller without the node
        }
        return error;
    }

    /**
     * An AbortSignal, told by what the package uses of it and not by its class: a signal of a
     * polyfill, or of another realm such as a vm context, is one too
     * @private
     */
    private static _isAbortSignal(value: unknown): value is AbortSignal {
        const signal = value as AbortSignal;
        return typeof signal?.aborted === 'boolean'
            && typeof signal.addEventListener === 'function'
            && typeof signal.removeEventListener === 'function';
    }

    /**
     * Fail every request that waits for a connection of one node, the queued queries of the
     * cluster itself included. Connections in use and logins that still run are left alone
     * @param nodeId id of the node, as nodes() reports it
     * @param error error the waiting requests are failed with
     * @returns how many requests were failed. 0 for an unknown node or a pool not created yet
     */
    public failWaiting(nodeId: number, error: Error): number {
        // without an error a waiting request would read its missing connection as handed out
        if (!GaleraCluster._isError(error)) {
            throw new TypeError("failWaiting: error must be an Error");
        }
        const pool = this._pools.find(candidate => candidate.id === nodeId);
        return pool ? pool.failWaiting(error) : 0;
    }

    /**
     * Connection counts of the pool of every node
     */
    public getPoolStats(): INodePoolStats[] {
        return this._pools.map(pool => ({
            nodeId: pool.id, ...pool.stats(), limit: pool.connectionLimit
        }));
    }

    /**
     * The nodes of the cluster as they are now. New plain objects on every call
     */
    public nodes(): INodeInfo[] {
        return this._pools.map(pool => ({
            id: pool.id,
            name: pool.name,
            host: pool.host,
            port: pool.port,
            isValid: pool.status.isValid,
            loadScore: pool.status.loadScore,
            ...GaleraCluster._withCheckError(pool.checkError)
        }));
    }
}

// The object Pool.connect() fills for its caller: how the health check of that connect ended.
// Named here, below the class, so the import lines above keep their line numbers
type CheckOutcome = Parameters<Pool['connect']>[0];
// The object Pool.getConnection() fills for its caller: whether an abort ended the call
type AbortOutcome = Parameters<Pool['getConnection']>[1];
