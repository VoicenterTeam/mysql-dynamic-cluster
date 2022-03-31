/**
 * Created by Bohdan on Sep, 2021
 */

import mysql from "mysql2";
import Logger from "../utils/Logger";
import { UserPoolSettings } from "../types/SettingsInterfaces";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import MetricNames from "../metrics/MetricNames";
import { QueryOptions, QueryResult } from "../types/PoolInterfaces";
import Events from "../utils/Events";
import Redis from "../utils/Redis";

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

    private readonly user: string;
    private readonly password: string;
    private readonly database: string;
    private readonly queryTimeout: number;

    private _pool: mysql.Pool;

    /**
     * @param settings pool settings
     */
    constructor(settings: UserPoolSettings) {
        this.id = settings.id;
        this.host = settings.host;
        this.port = settings.port;
        this.name = settings.name ? settings.name : `${this.host}:${this.port}`
        Logger.debug("configure pool in host " + this.host);

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;
        this.queryTimeout = settings.queryTimeout;

        this.connectionLimit = settings.connectionLimit;

        this._status = new PoolStatus(this, settings, false, this.connectionLimit, 10000);

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
            user: this.user,
            password: this.password,
            database: this.database,
            connectionLimit: this.connectionLimit
        })

        this.status.active = true;
        Metrics.activateMetrics(MetricNames.pools);
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

        Logger.info("pool in host " + this.host + " closed");
    }

    /**
     * Pool query
     * @param sql mysql query string
     * @param queryOptions query options like timeout, database, multipleStatements etc
     */
    public async query<T extends QueryResult>(sql: string, queryOptions?: QueryOptions): Promise<T | T[]> {
        return new Promise(async (resolve, reject) => {
            queryOptions = {
                timeout: this.queryTimeout,
                database: this.database,
                redis: false,
                ...queryOptions
            }

            Metrics.inc(MetricNames.pools.allQueries);
            Metrics.mark(MetricNames.pools.queryPerSecond);

            if (queryOptions.redis) {
                const redisResult = await Redis.get(sql);
                if (redisResult) {
                    Logger.debug("Get result of query from redis");
                    resolve(JSON.parse(redisResult));
                    return;
                }
            }

            this._pool.getConnection((err, conn) => {
                if (err) {
                    Metrics.inc(MetricNames.pools.errorQueries);
                    conn?.release();
                    reject(err);
                }

                if (!conn) {
                    Metrics.inc(MetricNames.pools.errorQueries);
                    conn?.release();
                    reject(new Error("Can't find connection. Maybe it was unexpectedly closed."));
                }

                // change database
                Logger.debug("Changing database to " + queryOptions.database);
                conn?.changeUser({ database: queryOptions.database }, (error) => {
                    if (error) {
                        Metrics.inc(MetricNames.pools.errorQueries);
                        conn.release();
                        reject(error);
                    }
                })

                Logger.debug(`Query in pool by host ${this.host}`);
                conn?.query({ sql, timeout: queryOptions.timeout }, (error, result: T) => {
                    if (error) {
                        Metrics.inc(MetricNames.pools.errorQueries);
                        conn.release();
                        reject(error);
                    }
                    conn.release();
                    Metrics.inc(MetricNames.pools.successfulQueries);
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
    public async multiStatementQuery<T extends QueryResult>(sqls: string[], queryOptions: QueryOptions = { timeout: this.queryTimeout, database: this.database }): Promise<T[]> {
        return new Promise((resolve, reject) => {
            Metrics.inc(MetricNames.pools.allQueries);
            Metrics.mark(MetricNames.pools.queryPerSecond);
            const results: T[] = [];

            this._pool.getConnection((err, conn) => {
                if (err) {
                    Metrics.inc(MetricNames.pools.errorQueries);
                    reject(err);
                }

                if (!conn) {
                    Metrics.inc(MetricNames.pools.errorQueries);
                    reject(new Error("Can't find connection. Maybe it was unexpectedly closed."));
                }

                // change database
                Logger.debug("Changing database to " + queryOptions.database);
                conn?.changeUser({ database: queryOptions.database }, (error) => {
                    if (error) {
                        Metrics.inc(MetricNames.pools.errorQueries);
                        conn.release();
                        reject(error);
                    }
                })

                Logger.debug("Start transaction in pool by host " + this.host);
                conn?.beginTransaction(error => {
                    if (error) {
                        Metrics.inc(MetricNames.pools.errorQueries);
                        conn.release();
                        reject(error);
                    }

                    sqls.forEach(sql => {
                        conn.query({ sql, timeout: queryOptions.timeout }, (errorQ, result: T) => {
                            if (errorQ) {
                                conn.rollback(() => 0);
                                Metrics.inc(MetricNames.pools.errorQueries);
                                conn.release();
                                reject(errorQ);
                            }
                            results.push(result);
                            Metrics.inc(MetricNames.pools.successfulQueries);
                        });
                    })

                    Logger.debug("Commit transaction in pool by host " + this.host);
                    conn.commit(errorC => {
                        if (errorC) {
                            conn.rollback(() => 0);
                            Metrics.inc(MetricNames.pools.errorQueries);
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
