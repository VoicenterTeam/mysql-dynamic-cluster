/**
 * Created by Bohdan on Sep, 2021
 */

import mysql from "mysql2";
import Logger from "../utils/Logger";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import MetricNames from "../metrics/MetricNames";
import { QueryOptions, QueryResult } from "../types/PoolInterfaces";
import Events from "../utils/Events";
import Redis from "../utils/Redis";
import { UserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";

// AKA galera node
export class Pool {
    private readonly _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }

    public readonly id: number;
    public readonly name: string;
    public readonly host: string;
    public readonly port: string;
    // max connection count in pool
    public readonly connectionLimit: number;

    private readonly _user: string;
    private readonly _password: string;
    private readonly _database: string;
    private readonly _queryTimeout: number;
    private readonly _slowQueryTime: number;

    private _pool: mysql.Pool;

    /**
     * @param settings pool settings
     * @param clusterName cluster name used for prefix
     */
    constructor(settings: UserPoolSettings, clusterName: string) {
        this.id = settings.id;
        this.host = settings.host;
        this.port = settings.port;
        this.name = settings.name ? settings.name : `${this.host}:${this.port}`
        Logger.debug(`Configure pool named ${this.name}`);

        this._user = settings.user;
        this._password = settings.password;
        this._database = settings.database;
        this._queryTimeout = settings.queryTimeout;
        this._slowQueryTime = settings.slowQueryTime;

        this.connectionLimit = settings.connectionLimit;

        this._status = new PoolStatus(this, settings, false, this.connectionLimit);

        Logger.info("configuration pool finished in host: " + this.host);
    }

    /**
     * Create pool connection
     * @param callback error callback when all status will not valid
     */
    public async connect(callback: (err: Error) => void) {
        Logger.debug("Creating pool in host: " + this.host);
        this._pool = mysql.createPool({
            host: this.host,
            user: this._user,
            password: this._password,
            database: this._database,
            connectionLimit: this.connectionLimit
        })

        this.status.active = true;
        this._connectEvents();
        await this.status.checkStatus();

        if (this.status.isValid) {
            Logger.info('Pool is connected');
            Events.emit('pool_connected');
            callback(null);
        } else {
            callback(new Error("pool in host " + this.host + " is not valid"));
        }
    }

    /**
     * Connect events in pool
     * @private
     */
    private _connectEvents() {
        this._pool.on("connection", (connection) => {
            this.status.availableConnectionCount--;
            Logger.debug("Open connection");
            Events.emit('connection', connection);
        })

        this._pool.on("release", (connection) => {
            this.status.availableConnectionCount++;
            Logger.debug("Connection closed");
            Events.emit('release', connection);
        })

        this._pool.on('acquire', (connection) => {
            Logger.debug("Connection is acquire");
            Events.emit('acquire', connection);
        })
    }

    /**
     * Close pool connection
     */
    public disconnect() {
        Logger.debug("closing pool in host: " + this.host);
        this._pool.end((error) => {
            if (error) {
                Logger.error(error.message);
            }
        });
        this.status.active = false;
        this.status.stopTimerCheck();
        Events.emit('pool_disconnected');

        Logger.info("pool named " + this.name + " closed");
    }

    /**
     * Pool query
     * @param sql mysql query string
     * @param queryOptions query options like timeout, database, multipleStatements etc
     */
    public async query<T extends QueryResult>(sql: string, queryOptions?: QueryOptions): Promise<T | T[]> {
        return new Promise(async (resolve, reject) => {
            queryOptions = {
                timeout: this._queryTimeout,
                database: this._database,
                redis: false,
                ...queryOptions
            }
            const poolMetricOption = {
                pool: {
                    id: this.id,
                    name: this.name
                }
            }
            const queryTimer = new QueryTimer(MetricNames.pool.queryTime);

            Metrics.inc(MetricNames.pool.allQueries, poolMetricOption);
            Metrics.mark(MetricNames.pool.queryPerMinute, poolMetricOption);

            if (queryOptions.redis) {
                const redisResult = await Redis.get(sql);
                if (redisResult) {
                    Logger.debug("Get result of query from redis");
                    resolve(JSON.parse(redisResult));
                    return;
                }
            }

            queryTimer.start();

            this._pool.getConnection((err, conn) => {
                if (err) {
                    Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                    conn?.release();
                    reject(err);
                }

                if (!conn) {
                    Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                    conn?.release();
                    reject(new Error("Can't find connection. Maybe it was unexpectedly closed."));
                }

                // change database
                Logger.debug("Changing database to " + queryOptions.database);
                conn?.changeUser({ database: queryOptions.database }, (error) => {
                    if (error) {
                        Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                        conn.release();
                        reject(error);
                    }
                })

                Logger.debug(`Query in pool by host ${this.host}`);
                conn?.query({ sql, timeout: queryOptions.timeout }, (error, result: T) => {
                    if (error) {
                        Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                        conn.release();
                        reject(error);
                    }
                    conn.release();

                    queryTimer.end();
                    queryTimer.save(poolMetricOption);
                    if (queryTimer.get() >= this._slowQueryTime) {
                        Logger.warn(`Query in pool named ${this.name} takes ${queryTimer.get()} sec`);
                    }

                    Metrics.inc(MetricNames.pool.successfulQueries, poolMetricOption);

                    if (queryOptions.redis) Redis.set(sql, JSON.stringify(result));
                    resolve(result);
                });
            })
        })
    }

    /**
     * Pool query by mysql transaction
     * @param sqls array of sql queries
     * @param queryOptions query options like timeout, database etc.
     */
    public async multiStatementQuery<T extends QueryResult>(sqls: string[], queryOptions: QueryOptions): Promise<T[]> {
        return new Promise((resolve, reject) => {
            queryOptions = {
                timeout: this._queryTimeout,
                database: this._database,
                ...queryOptions
            }
            const poolMetricOption = {
                pool: {
                    id: this.id,
                    name: this.name
                }
            }

            Metrics.inc(MetricNames.pool.allQueries, poolMetricOption);
            Metrics.mark(MetricNames.pool.queryPerMinute, poolMetricOption);
            const results: T[] = [];

            this._pool.getConnection((err, conn) => {
                if (err) {
                    Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                    reject(err);
                }

                if (!conn) {
                    Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                    reject(new Error("Can't find connection. Maybe it was unexpectedly closed."));
                }

                // change database
                Logger.debug("Changing database to " + queryOptions.database);
                conn?.changeUser({ database: queryOptions.database }, (error) => {
                    if (error) {
                        Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                        conn.release();
                        reject(error);
                    }
                })

                Logger.debug("Start transaction in pool by host " + this.host);
                conn?.beginTransaction(error => {
                    if (error) {
                        Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                        conn.release();
                        reject(error);
                    }

                    sqls.forEach(sql => {
                        conn.query({ sql, timeout: queryOptions.timeout }, (errorQ, result: T) => {
                            if (errorQ) {
                                conn.rollback(() => 0);
                                Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                                conn.release();
                                reject(errorQ);
                            }
                            results.push(result);
                            Metrics.inc(MetricNames.pool.successfulQueries, poolMetricOption);
                        });
                    })

                    Logger.debug("Commit transaction in pool by host " + this.host);
                    conn.commit(errorC => {
                        if (errorC) {
                            conn.rollback(() => 0);
                            Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                            conn.release();
                            reject(errorC);
                        }
                    });

                    conn.release();
                    resolve(results);
                })
            })
        })
    }
}
