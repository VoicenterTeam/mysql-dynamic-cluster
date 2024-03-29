/**
 * Created by Bohdan on Sep, 2021
 */

import { IUserSettings } from "../types/SettingsInterfaces";
import { IQueryOptions, QueryValues, ClusterEvent, QueryResult } from '../types/PoolInterfaces'
import Logger from "../utils/Logger";

import { format as MySQLFormat } from 'mysql2';
import { Pool } from "../pool/Pool";
import { ClusterHashing } from "./ClusterHashing";
import MetricNames from "../metrics/MetricNames";
import Metrics from "../metrics/Metrics";
import Events from "../utils/Events";
import Redis from "../Redis/Redis";
import { IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";
import ServiceNames from "../utils/ServiceNames";
import { IRedisData } from "../types/RedisInterfaces";

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

    /**
     * @param userSettings global user settings
     */
    constructor(userSettings: IUserSettings) {
        Logger.debug("Configuring cluster...");

        this._useClusterHashing = userSettings.useClusterHashing;
        this._clusterName = userSettings.clusterName;
        this._errorRetryCount = userSettings.errorRetryCount;
        this._useRedis = userSettings.useRedis;
        const poolIds: number[] = this._sortPoolIds(userSettings.hosts);

        userSettings.hosts.forEach(poolSettings => {
            if (!poolSettings.id) {
                poolSettings.id = poolIds.length <= 0 ? 0 : poolIds[poolIds.length - 1] + 1;
                poolIds.push(poolSettings.id);
            }

            this._pools.push(
                new Pool(poolSettings, this._clusterName)
            )
        })

        this._serviceNames = new ServiceNames(this, userSettings.serviceMetrics);
        this._clusterHashing = new ClusterHashing(this, this._clusterName, userSettings.clusterHashing);

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
        return new Promise((resolve, reject) => {
            Logger.debug("Connecting all pools");
            this._pools.forEach((pool) => {
                pool.connect().then(async () => {
                    if (this.connected) return;

                    this.connected = true;
                    if (this._useClusterHashing) await this._enableHashing();

                    Events.emit('connected');
                    Logger.info('Cluster connected');

                    resolve();
                }).catch(err => {
                    Logger.error(err.message);
                    reject(err.message);
                });
            })
        })
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
     * Cluster mysql query
     * @param sql MySQL query
     * @param values values what passed in sql string
     * @param queryOptions params for configure query
     */
    public async query<T extends QueryResult>(sql: string, values?: QueryValues, queryOptions?: IQueryOptions): Promise<T> {
        queryOptions = {
            redis: this._useRedis,
            maxRetry: this._errorRetryCount,
            ...queryOptions
        }

        let activePools: Pool[]; // available pools for query what passed the validator
        let retryCount; // max retry query count after error
        let serviceId = queryOptions?.serviceId;

        Metrics.mark(MetricNames.cluster.queryPerMinute);
        Metrics.inc(MetricNames.cluster.allQueries);

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
            Metrics.inc(MetricNames.cluster.errorQueries);
            throw new Error(e);
        }

        sql = this._formatSQL(sql, values);
        let redisData: IRedisData = null;
        if (queryOptions.redis) {
            const redisLatency = new QueryTimer(MetricNames.redis.latency);
            redisLatency.start();

            Metrics.inc(MetricNames.redis.uses);
            const redisResult = await Redis.get(sql);

            redisLatency.end();
            redisLatency.save();

            if (redisResult) {
                Logger.debug("Get result of query from redis");
                redisData = JSON.parse(redisResult);
                if (redisData.expired > Date.now()) {
                    Metrics.inc(MetricNames.cluster.successfulQueries);
                    return redisData.data;
                }

                Metrics.inc(MetricNames.redis.expired);
            }
        }

        const errorList: {
            error: any,
            pool: Pool
        }[] = [];

        for (let i = 0; i < retryCount; i++) {
            try {
                Logger.debug("Query use host: " + activePools[i].host);
                const res = await this._queryRequest(sql, activePools[i], queryOptions) as T;
                Metrics.inc(MetricNames.cluster.successfulQueries);
                return res;
            } catch (e) {
                errorList.push({
                    error: e,
                    pool: activePools[i],
                });
                Logger.error(e.message);
                if (i + 1 < retryCount) {
                    Logger.debug("Retrying query...");
                }
            }
        }

        let errorMessage: string = "";
        errorList.forEach(err => {
            errorMessage += `Pool: ${err.pool.name}; Error: ${err.error.message}\n`;
        })

        Logger.error("All pools have error. Error messages: \n" + errorMessage);
        if (redisData) {
            Logger.warn("Use old data from Redis");
            Metrics.inc(MetricNames.cluster.successfulQueries);
            return redisData.data;
        }

        Metrics.inc(MetricNames.cluster.errorQueries);
        throw new Error(errorMessage);
    }

    /**
     * Query request to pool
     * @param sql MySQL query string
     * @param pool active pool
     * @param queryOptions options to configure query
     * @private
     */
    private async _queryRequest<T extends QueryResult>(sql: string, pool: Pool, queryOptions: IQueryOptions): Promise<T> {
        const queryTimer = new QueryTimer(MetricNames.cluster.queryTime);
        try {
            queryTimer.start();

            const result = await pool.query(sql, queryOptions) as T;

            queryTimer.end();
            queryTimer.save();

            if (queryOptions?.serviceId && this._clusterHashing.connected) {
                await this._clusterHashing?.updateNodeForService(queryOptions?.serviceId, pool.id);
            }
            return result;
        } catch (e) {
            queryTimer.end();
            queryTimer.save();
            throw new Error("Query error: " + e.message);
        }
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
        retryCount = Math.min(retryCount, activePoolsLength);
        return retryCount;
    }

    /**
     * Mix together values and sql string
     * @param sql MySQL query
     * @param values values to mix with sql
     * @private
     */
    private _formatSQL(sql: string, values: QueryValues): string {
        if (values) {
            if (Array.isArray(values)) {
                return MySQLFormat(sql, values);
            } else if (typeof values === 'string') {
                return MySQLFormat(sql, values);
            } else {
                return sql.replace(/:(\w+)/g, (txt, key) => {
                    return values.hasOwnProperty(key) ? values[key] : txt
                })
            }
        }

        return sql;
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

        activePools = this._pools.filter(pool => {
            return pool.status.isValid && pool.id !== poolIdService;
        })
        activePools.sort((a, b) => a.status.loadScore - b.status.loadScore)

        if (poolIdService >= 0) {
            const servicePool = this._pools.find(pool => pool.id === poolIdService);
            if (servicePool) activePools.unshift(servicePool);
        }

        if (activePools.length < 1) {
            throw new Error("There is no pool that satisfies the parameters");
        }

        return activePools;
    }
}
