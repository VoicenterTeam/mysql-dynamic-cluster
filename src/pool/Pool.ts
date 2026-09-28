/**
 * Created by Bohdan on Sep, 2021
 */

import mysql from "mysql2";
import Logger from "../utils/Logger";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import MetricNames from "../metrics/MetricNames";
import { IQueryOptions, QueryResult } from "../types/PoolInterfaces";
import Events from "../utils/Events";
import { IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";
import { IMetricOptions } from "../types/MetricsInterfaces";
import Redis from "../Redis/Redis";
import { IRedisData } from "../types/RedisInterfaces";
import { IdleConnectionReaper } from './IdleConnectionReaper';

// AKA galera node
export class Pool {
    private readonly _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }

    public readonly id: number;
    public readonly name: string;
    public readonly host: string;
    public readonly port: number;
    // max connection count in pool
    public readonly connectionLimit: number;

    private readonly _user: string;
    private readonly _password: string;
    private readonly _database: string;
    private readonly _queryTimeout: number;
    private readonly _slowQueryTime: number;
    private readonly _redisFactor: number;
    private readonly _redisExpire: number;

    private _pool: mysql.Pool;
    private readonly _reaper: IdleConnectionReaper;

    /**
     * @param settings pool settings
     * @param clusterName cluster name used for prefix
     */
    constructor(settings: IUserPoolSettings, clusterName: string) {
        this.id = settings.id;
        this.host = settings.host;
        this.port = settings.port;
        this.name = settings.name ? settings.name : `${this.host}:${this.port}`
        Logger.debug(`Configure pool named ${this.name} ${this.host}:${this.port}`);

        this._user = settings.user;
        this._password = settings.password;
        this._database = settings.database;
        this._queryTimeout = settings.queryTimeout;
        this._slowQueryTime = settings.slowQueryTime;
        this._redisFactor = settings.redisFactor;
        this._redisExpire = settings.redisExpire;

        this.connectionLimit = settings.connectionLimit;

        this._reaper = new IdleConnectionReaper(
            settings.minConnections,
            settings.idleTimeout,
            settings.idleCheckInterval
        );

        this._status = new PoolStatus(this, settings, false, this.connectionLimit);

        Logger.info("configuration pool finished in host: " + this.host);
    }

    /**
     * Create pool connection
     */
    public async connect() {
        Logger.debug("Creating pool in host: " + this.host);
        this._pool = mysql.createPool({
            host: this.host,
            port: this.port,
            user: this._user,
            password: this._password,
            database: this._database,
            connectionLimit: this.connectionLimit
        })

        this._reaper.start(this._pool as any);
        this.status.active = true;
        this._connectEvents();
        await this.status.checkStatus();

        if (this.status.isValid) {
            Logger.info('Pool is connected');
            Events.emit('pool_connected', this.id);
        } else {
            throw new Error("pool in host " + this.host + " is not valid");
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
            Events.emit('connection', connection, this.id);
        })

        this._pool.on("release", (connection) => {
            this.status.availableConnectionCount++;
            this._reaper.onRelease(connection);
            Logger.debug("Connection closed");
            Events.emit('release', connection, this.id);
        })

        this._pool.on('acquire', (connection) => {
            this._reaper.onAcquire(connection);
            Logger.debug("Connection is acquire");
            Events.emit('acquire', connection, this.id);
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
        this._reaper.stop();
        Events.emit('pool_disconnected', this.id);

        Logger.info("pool named " + this.name + " closed");
    }

    /**
     * Pool query
     * @param sql mysql query string
     * @param queryOptions query options like timeout, database, multipleStatements etc
     */
    public async query<T extends QueryResult>(sql: string, queryOptions?: IQueryOptions): Promise<T | T[]> {
        return new Promise(async (resolve, reject) => {
            queryOptions = {
                timeout: this._queryTimeout,
                database: this._database,
                redisFactor: this._redisFactor,
                redisExpire: this._redisExpire,
                ...queryOptions
            }
            const poolMetricOption: IMetricOptions = {
                pool: {
                    id: this.id,
                    name: this.name
                }
            }
            if (queryOptions?.serviceId) {
                poolMetricOption.service = {
                    id: queryOptions.serviceId,
                    name: queryOptions?.serviceName ? queryOptions.serviceName : String(queryOptions.serviceId)
                }
            }

            const queryTimer = new QueryTimer(MetricNames.pool.queryTime);

            Metrics.inc(MetricNames.pool.allQueries, poolMetricOption);
            Metrics.mark(MetricNames.pool.queryPerMinute, poolMetricOption);
            queryTimer.start();

            // mysql2 can call back twice (timeout, then a late server error), settle only once
            let settled = false;
            const fail = (error: any, conn?: mysql.PoolConnection) => {
                if (settled) return;
                settled = true;
                Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                queryTimer.end();
                queryTimer.save(poolMetricOption);
                Pool._handBack(conn, error);
                reject(error);
            }

            this._pool.getConnection((err, conn) => {
                if (err) return fail(err);
                if (!conn) return fail(new Error("Can't find connection. Maybe it was unexpectedly closed."));

                // change database
                Logger.debug("Changing database to " + queryOptions.database);
                Pool._changeUser(conn, queryOptions.database, queryOptions.timeout, (error) => {
                    if (error) return fail(error, conn);

                    Logger.debug(`Query in pool by host ${this.host}`);
                    conn.query({ sql, timeout: queryOptions.timeout }, (error, result: T) => {
                        if (error) return fail(error, conn);
                        if (settled) return;
                        settled = true;
                        conn.release();

                        queryTimer.end();
                        queryTimer.save(poolMetricOption);
                        if (queryTimer.get() >= this._slowQueryTime) {
                            Logger.warn(`Query in pool named ${this.name} takes ${queryTimer.get()} sec`);
                        }

                        Metrics.inc(MetricNames.pool.successfulQueries, poolMetricOption);

                        if (queryOptions.redis) {
                            const redisExpired = new Date().getTime() + queryTimer.get() * 1000 * queryOptions.redisFactor;
                            const redisData: IRedisData = {
                                data: result,
                                expired: redisExpired
                            }
                            Redis.set(sql, JSON.stringify(redisData), queryOptions.redisExpire);
                        }

                        resolve(result);
                    });
                })
            })
        })
    }

    /**
     * Pool query by mysql transaction
     * @param sqls array of sql queries
     * @param queryOptions query options like timeout, database etc.
     */
    public async multiStatementQuery<T extends QueryResult>(sqls: string[], queryOptions: IQueryOptions): Promise<T[]> {
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

            let settled = false;
            const fail = (error: any, conn?: mysql.PoolConnection, rollback: boolean = false) => {
                if (settled) return;
                settled = true;
                Metrics.inc(MetricNames.pool.errorQueries, poolMetricOption);
                // a broken connection can't roll back; destroying it makes the server discard the transaction
                if (rollback && !Pool._isBroken(error)) {
                    conn.query({ sql: 'ROLLBACK', timeout: queryOptions.timeout }, (errorR) => {
                        if (errorR) {
                            Logger.error("Rollback failed in pool by host " + this.host + ": " + errorR.message);
                            conn.destroy();
                        } else {
                            conn.release();
                        }
                        reject(error);
                    });
                    return;
                }
                Pool._handBack(conn, error);
                reject(error);
            }

            this._pool.getConnection((err, conn) => {
                if (err) return fail(err);
                if (!conn) return fail(new Error("Can't find connection. Maybe it was unexpectedly closed."));

                // queries run one after another; commit only after the last one succeeded
                const runQuery = (index: number) => {
                    if (index >= sqls.length) {
                        Logger.debug("Commit transaction in pool by host " + this.host);
                        conn.commit(errorC => {
                            if (errorC) return fail(errorC, conn, true);
                            if (settled) return;
                            settled = true;

                            Metrics.inc(MetricNames.pool.successfulQueries, poolMetricOption);
                            conn.release();
                            resolve(results);
                        });
                        return;
                    }

                    conn.query({ sql: sqls[index], timeout: queryOptions.timeout }, (errorQ, result: T) => {
                        if (errorQ) return fail(errorQ, conn, true);
                        results.push(result);
                        runQuery(index + 1);
                    });
                }

                // change database
                Logger.debug("Changing database to " + queryOptions.database);
                Pool._changeUser(conn, queryOptions.database, queryOptions.timeout, (error) => {
                    if (error) return fail(error, conn);

                    Logger.debug("Start transaction in pool by host " + this.host);
                    conn.beginTransaction(errorT => {
                        if (errorT) return fail(errorT, conn);
                        runQuery(0);
                    })
                })
            })
        })
    }

    /**
     * Change connection database with a timeout. mysql2 ignores the timeout option of changeUser,
     * and a query's own timeout only starts after changeUser finished
     * @param conn connection
     * @param database database to change to
     * @param timeout time in ms before failing with PROTOCOL_SEQUENCE_TIMEOUT
     * @param callback called once, with an error on failure or timeout
     * @private
     */
    private static _changeUser(conn: mysql.PoolConnection, database: string, timeout: number, callback: (error?: any) => void) {
        let done = false;
        const timer = setTimeout(() => {
            done = true;
            callback(Object.assign(new Error("Change database timeout"), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }));
        }, timeout);

        conn.changeUser({ database }, (error) => {
            clearTimeout(timer);
            if (done) return;
            done = true;
            callback(error);
        });
    }

    /**
     * Dead socket, or one still running a timed-out statement
     * @param error error from mysql
     * @private
     */
    private static _isBroken(error: any): boolean {
        return error?.fatal || error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT';
    }

    /**
     * Hand connection back to the pool, or destroy it if it's broken so it's never reused
     * @param conn connection to hand back
     * @param error error from mysql
     * @private
     */
    private static _handBack(conn: mysql.PoolConnection, error?: any) {
        if (Pool._isBroken(error)) {
            conn?.destroy();
        } else {
            conn?.release();
        }
    }
}
