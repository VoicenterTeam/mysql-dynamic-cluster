/**
 * Created by Bohdan on Sep, 2021
 */

import { PoolSettings, UserSettings } from "../types/SettingsInterfaces";
import { QueryOptions, QueryValues, ClusterEvent } from '../types/PoolInterfaces'
import Logger from "../utils/Logger";
import defaultSettings from "../configs/DefaultSettings";

import { EventEmitter } from 'events'
import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { format as MySQLFormat } from 'mysql2';
import { Pool } from "../pool/Pool";
import { Settings } from "../utils/Settings";
import { ClusterHashing } from "./ClusterHashing";
import MetricNames from "../metrics/MetricNames";
import Metrics from "../metrics/Metrics";

export class GaleraCluster {
    private _pools: Pool[] = [];
    public get pools(): Pool[] {
        return this._pools;
    }
    private readonly _clusterHashing: ClusterHashing;
    private _queryTime: number = 1000;
    private readonly errorRetryCount: number; // retry count after query error
    private _eventEmitter = new EventEmitter();
    public connected: boolean = false;

    /**
     * @param userSettings global user settings
     */
    constructor(userSettings: UserSettings) {
        // enable amqp logger when user enable it in the settings
        if (userSettings.use_amqp_logger ? userSettings.use_amqp_logger : defaultSettings.use_amqp_logger) {
            Logger.enableAMQPLogger(userSettings.amqp_logger);
        }

        Logger.debug("Configuring cluster...");

        this.errorRetryCount = userSettings.errorRetryCount ? userSettings.errorRetryCount : defaultSettings.errorRetryCount;
        const poolIds: number[] = this._sortPoolIds(userSettings.hosts);

        userSettings.hosts.forEach(poolSettings => {
            poolSettings = Settings.mixPoolSettings(poolSettings, userSettings);
            if (!poolSettings.id) {
                poolSettings.id = poolIds.length <= 0 ? 0 : poolIds[poolIds.length - 1] + 1;
                poolIds.push(poolSettings.id);
            }

            this._pools.push(
                new Pool(poolSettings)
            )
        })


        this._clusterHashing = new ClusterHashing(this);

        Logger.info("Cluster configuration finished");
    }

    /**
     * Sort pool ids for mix userSettings and autogenerated ids
     * @param pools pools passed in userSettings
     * @private
     */
    private _sortPoolIds(pools: PoolSettings[]): number[] {
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
    public connect(): Promise<void> {
        return new Promise(resolve => {
            Logger.debug("connecting all pools");
            Metrics.activateMetrics(MetricNames.cluster);
            Metrics.activateMetrics(MetricNames.services);
            this._pools.forEach((pool) => {
                pool.connect((err) => {
                    if (err) Logger.error(err.message)
                    else  {
                        if (this.connected) return;
                        Logger.info('Cluster connected');
                        this.connected = true;
                        this._emit('connected');
                        resolve();
                    }
                });
            })
        })
    }

    /**
     * Enable hashing for cluster
     */
    public async enableHashing() {
        await this._clusterHashing.connect();
        Logger.info("Cluster hashing enabled");
    }

    /**
     * Disconnect all cluster pools
     */
    public async disconnect() {
        Logger.debug("disconnecting all pools");
        this.connected = false;
        this._clusterHashing?.stop();
        this._pools.forEach((pool) => {
            pool.disconnect();
        })
        this._emit('disconnected');
    }

    /**
     * Connect to the event
     * @param event event name
     * @param callback function what will be called after emit
     */
    public on(event: ClusterEvent, callback: (...args: any[]) => void) {
        this._eventEmitter.on(event, callback);
    }

    /**
     * Emit the event. Call all functions what connected to the event
     * @param event event name
     * @param args arguments what will be passed to the callback function
     * @private
     */
    private _emit(event: ClusterEvent, ...args: any[]) {
        this._eventEmitter.emit(event, args);
    }

    /**
     * Cluster mysql query
     * @param sql MySQL query
     * @param values values what passed in sql string
     * @param queryOptions params for configure query
     */
    public async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: QueryValues, queryOptions?: QueryOptions): Promise<T> {
        let activePools: Pool[]; // available pools for query what passed the validator
        let retryCount; // max retry query count after error
        try {
            activePools = await this._getActivePools(queryOptions?.serviceId);
            retryCount = this._maxRetryCount(queryOptions?.maxRetry, activePools.length);
        } catch (e) {
            throw new Error(e);
        }

        sql = this._formatSQL(sql, values);
        let error;

        for (let i = 0; i < retryCount; i++) {
            try {
                Logger.debug("Query use host: " + activePools[i].host);
                Metrics.mark(MetricNames.cluster.queryPerSecond);
                return await this._queryRequest(sql, activePools[i], queryOptions);
            } catch (e) {
                error = e;
                Logger.error(e.message);
                if (i + 1 < retryCount) {
                    Logger.debug("Retrying query...");
                }
            }
        }

        throw new Error("All pools have a error. Error message: " + error.message);
    }

    /**
     * Query request to pool
     * @param sql MySQL query string
     * @param pool active pool
     * @param queryOptions options to configure query
     * @private
     */
    private async _queryRequest<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, pool: Pool, queryOptions: QueryOptions): Promise<T> {
        try {
            Metrics.inc(MetricNames.cluster.allQueries);
            const timeBefore = new Date().getTime();

            if (queryOptions?.serviceId) {
                Metrics.inc(MetricNames.services.allQueries);
            }

            const result = await pool.query(sql, queryOptions) as T;

            const timeAfter = new Date().getTime();
            this._queryTime = Math.abs(timeAfter - timeBefore) / 1000;
            Metrics.set(MetricNames.cluster.queryTime, this._queryTime);
            Metrics.inc(MetricNames.cluster.successfulQueries);
            if (queryOptions?.serviceId) {
                Metrics.inc(MetricNames.services.successfulQueries);
                this._clusterHashing?.updateServiceForNode(queryOptions.serviceId, pool.id);
            }
            return result;
        } catch (e) {
            if (queryOptions?.serviceId) {
                Metrics.inc(MetricNames.services.errorQueries);
                this._clusterHashing?.updateServiceForNode(queryOptions.serviceId, pool.id);
            }
            Metrics.inc(MetricNames.cluster.errorQueries);
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
        let retryCount = maxRetry && maxRetry > 0 ? maxRetry : this.errorRetryCount;
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
        const activePools: Pool[] = this._pools.filter(pool => {
            if (serviceId && !pool.status.isValid) {
                this._clusterHashing?.updateServiceForNode(serviceId, pool.id);
            }
            return pool.status.isValid;
        })
        activePools.sort((a, b) => a.status.loadScore - b.status.loadScore)

        if (activePools.length < 1) {
            throw new Error("There is no pool that satisfies the parameters");
        }

        return activePools;
    }
}
