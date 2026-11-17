/**
 * Created by Bohdan on Sep, 2021
 */

import mysql, { PoolConnection } from "mysql2";
import Logger from "../utils/Logger";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import { IQueryOptions, QueryResult } from "../types/PoolInterfaces";
import Events from "../utils/Events";
import { IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";
import { IOperationMetricOptions } from "../types/MetricsInterfaces";
import Redis from "../Redis/Redis";
import { IRedisData } from "../types/RedisInterfaces";
import { IdleConnectionReaper } from './IdleConnectionReaper';
import { flagsForServer, IServerGreeting, IServerProbe, probeServer } from './ServerFlags';

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
    private readonly _flags?: string | string[];

    private _pool: mysql.Pool;
    // counts connect() and disconnect() calls: a connect() that comes back from asking the server
    // opens a pool only when no other call came in between
    private _connectAttempt = 0;
    // the login that asks the server for its version, while it runs
    private _probe?: IServerProbe;
    private readonly _reaper: IdleConnectionReaper;

    /**
     * Connections that can still be handed out: limit minus connections in use.
     * Read from mysql2's own lists, so destroyed connections are counted right
     */
    public get availableConnectionCount(): number {
        const pool = this._pool as any;
        if (!this.connectionLimit) return Infinity; // mysql2: 0 means no limit
        if (!pool?._allConnections) return this.connectionLimit;
        return this.connectionLimit - pool._allConnections.length + pool._freeConnections.length;
    }

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
        this._flags = settings.flags;

        this.connectionLimit = settings.connectionLimit;

        this._reaper = new IdleConnectionReaper(
            settings.minConnections,
            settings.idleTimeout,
            settings.idleCheckInterval
        );

        this._status = new PoolStatus(this, settings, false);

        Logger.info("configuration pool finished in host: " + this.host);
    }

    /**
     * Create pool connection
     */
    public async connect() {
        const attempt = ++this._connectAttempt;
        // flags of the settings are used as they are. Without them the server decides
        const flags = this._flags === undefined ? await this._flagsFromServer() : this._flags;
        if (attempt !== this._connectAttempt) {
            throw new Error("pool in host " + this.host + " was closed or connected again while connecting");
        }

        const flagsMeta = flags === undefined ? undefined : { flags };
        Logger.debug("Creating pool in host: " + this.host, flagsMeta);
        this._pool = mysql.createPool({
            ...this._connectionOptions(),
            connectionLimit: this.connectionLimit,
            // left out when unset, so mysql2 keeps its default flags. mysql2 takes a string too
            ...(flags === undefined ? {} : { flags: flags as string[] })
        })

        this._reaper.start(this._pool as any);
        this.status.startTimerCheck(); // marks the status active, and undoes the stop of a disconnect()
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
     * What a connection to this node needs. The pool and the login that asks the server
     * for its version both use it, so an option added here reaches both
     * @private
     */
    private _connectionOptions() {
        return {
            host: this.host,
            port: this.port,
            user: this._user,
            password: this._password,
            database: this._database
        };
    }

    /**
     * Log in once to read the server's greeting and pick the flags this node needs.
     * A failed login is not an error here: the pool is created anyway and reports the node itself
     * @private
     */
    private async _flagsFromServer(): Promise<string[] | undefined> {
        const probe = probeServer(this._connectionOptions());
        this._probe = probe;

        let greeting: IServerGreeting | undefined;
        let error: string | undefined;
        try {
            greeting = await probe.greeting;
        } catch (e) {
            // the code names the cause. The message stays out: for a refused login it holds the user name
            error = e?.code || (e?.errno ? "errno " + e.errno : "unknown");
        }
        // disconnect() or a later connect() took over: connect() rejects, nothing to decide or log
        if (this._probe !== probe) return undefined;
        this._probe = undefined;

        const decision = flagsForServer(greeting);
        const meta = {
            pool: this.name,
            serverVersion: greeting?.serverVersion,
            reason: decision.reason,
            ...(decision.flags ? { flags: decision.flags } : {}),
            ...(error ? { error } : {})
        };
        const pool = "Pool " + this.name + ": ";

        if (!greeting) {
            Logger.warn(pool + "could not read the server version, connecting with " + decision.flags, meta);
        } else if (decision.reason === 'version_unreadable') {
            Logger.warn(pool + "server version is not readable, connecting with " + decision.flags, meta);
        } else if (decision.flags) {
            Logger.info(pool + "server " + greeting.serverVersion + " needs " + decision.flags +
                ", set flags in the settings to override", meta);
        } else {
            Logger.debug(pool + "server " + greeting.serverVersion + " keeps the default flags of mysql2", meta);
        }
        return decision.flags;
    }

    /**
     * The error of a query that reaches the pool before connect() created the mysql2 pool.
     * The cluster sends queries of a pinned service to its node without looking at the status
     * @private
     */
    private _notConnected(): Error {
        const error: any = new Error("pool in host " + this.host + " is not connected yet");
        error.code = 'POOL_NOT_CONNECTED';
        return error;
    }

    /**
     * Connect events in pool
     * @private
     */
    private _connectEvents() {
        this._pool.on("connection", (connection) => {
            Logger.debug("Open connection");
            Events.emit('connection', connection, this.id);
        })

        this._pool.on("release", (connection) => {
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
        // a connect() that still asks the server must not open a pool after this
        this._connectAttempt++;
        this._probe?.cancel();
        this._probe = undefined;
        this._pool?.end((error) => {
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
            const poolMetricOption: IOperationMetricOptions = {
                ...this._metricOptions(queryOptions.database),
                sql
            }
            if (queryOptions?.serviceId) {
                poolMetricOption.serviceName = queryOptions?.serviceName
                    ? queryOptions.serviceName
                    : String(queryOptions.serviceId);
            }

            const queryTimer = new QueryTimer();
            queryTimer.start();

            // mysql2 can call back twice (timeout, then a late server error), settle only once
            let settled = false;
            const fail = (error: any, conn?: mysql.PoolConnection) => {
                if (settled) return;
                settled = true;
                queryTimer.end();
                Metrics.recordOperation(queryTimer.get(), { ...poolMetricOption, error });
                Pool._handBack(conn, error);
                reject(error);
            }

            if (!this._pool) return fail(this._notConnected());
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
                        Metrics.recordOperation(queryTimer.get(), poolMetricOption);
                        if (queryTimer.get() >= this._slowQueryTime) {
                            Logger.warn(`Query in pool named ${this.name} takes ${queryTimer.get()} sec`);
                        }

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
            // no sql: a transaction has no single operation name
            const poolMetricOption = this._metricOptions(queryOptions.database);

            const queryTimer = new QueryTimer();
            queryTimer.start();
            const results: T[] = [];

            let settled = false;
            const fail = (error: any, conn?: mysql.PoolConnection, rollback: boolean = false) => {
                if (settled) return;
                settled = true;
                queryTimer.end();
                Metrics.recordOperation(queryTimer.get(), { ...poolMetricOption, error });
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

            if (!this._pool) return fail(this._notConnected());
            this._pool.getConnection((err, conn) => {
                if (err) return fail(err);
                if (!conn) return fail(new Error("Can't find connection. Maybe it was unexpectedly closed."));

                // queries run one after another; commit only after the last one succeeded
                const runQuery = (index: number) => {
                    if (index >= sqls.length) {
                        Logger.debug("Commit transaction in pool by host " + this.host);
                        conn.query({ sql: 'COMMIT', timeout: queryOptions.timeout }, errorC => {
                            if (errorC) return fail(errorC, conn, true);
                            if (settled) return;
                            settled = true;

                            queryTimer.end();
                            Metrics.recordOperation(queryTimer.get(), poolMetricOption);
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
                    conn.query({ sql: 'START TRANSACTION', timeout: queryOptions.timeout }, errorT => {
                        if (errorT) return fail(errorT, conn);
                        runQuery(0);
                    })
                })
            })
        })
    }

    /**
     * Metric attributes of a query attempt in this pool
     * @param database database the query runs in
     * @private
     */
    private _metricOptions(database: string): IOperationMetricOptions {
        return {
            poolName: this.name,
            host: this.host,
            port: this.port,
            database
        }
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
        // mysql2: timeout 0 means no timeout
        if (!timeout) return conn.changeUser({ database }, callback);

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

    /**
     * Take one connection out of the pool and hand it to the caller as it is: no database
     * change, no timeout, no metric. One request to mysql2, which waits when the pool is at
     * its limit. Rejects with the error object of mysql2
     */
    public getConnection(): Promise<PoolConnection> {
        return new Promise((resolve, reject) => {
            if (!this._pool) return reject(this._notConnected());
            this._pool.getConnection((error, connection) => {
                return error ? reject(error) : resolve(connection);
            });
        });
    }

    /**
     * Fail every request that waits for a connection of this pool. Connections in use and
     * logins that are still running are left alone
     * @param error error the waiting requests are failed with
     * @returns how many requests were failed. 0 before connect() created the mysql2 pool
     */
    public failWaiting(error: Error): number {
        // mysql2 keeps the callbacks of the waiting requests here, called as (error, connection)
        const queue = (this._pool as any)?._connectionQueue;
        if (!queue) return 0;

        // taken out first: a callback that asks again waits in the queue, it is not failed here
        const waiting: ((error: Error) => void)[] = [];
        while (queue.length > 0) waiting.push(queue.shift());
        waiting.forEach(callback => {
            try {
                callback(error);
            } catch (thrown) {
                // the requests behind it are already out of the queue and must still be failed
                Logger.error("A request that waited in pool by host " + this.host +
                    " threw while it was failed: " + (thrown?.message || thrown));
            }
        });
        return waiting.length;
    }

    /**
     * Connection counts read from mysql2's own lists. All zeros before connect() created the
     * mysql2 pool. A connection that still logs in counts as used
     */
    public stats(): { used: number, idle: number, pending: number } {
        const pool = this._pool as any;
        if (!pool?._allConnections) return { used: 0, idle: 0, pending: 0 };
        return {
            used: pool._allConnections.length - pool._freeConnections.length,
            idle: pool._freeConnections.length,
            pending: pool._connectionQueue.length
        };
    }
}
