/**
 * Created by Bohdan on Sep, 2021
 */

import mysql, { PoolConnection } from "mysql2";
import Logger from "../utils/Logger";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import {
    IAbortOutcome, ICheckOutcome, IQueryOptions, IQueryOutcome, QueryResult
} from "../types/PoolInterfaces";
import Events from "../utils/Events";
import { IHealthCheck, IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";
import { IOperationMetricOptions } from "../types/MetricsInterfaces";
import Redis from "../Redis/Redis";
import { IRedisData } from "../types/RedisInterfaces";
import { IdleConnectionReaper, IIdlePing } from './IdleConnectionReaper';
import { CheckConnection } from './CheckConnection';
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
    // Whether the health check of this node asks on a connection of its own: a node with
    // a healthCheck block. The legacy check asks through the pool
    private readonly _checksApart: boolean;
    // that connection, from connect() to disconnect()
    private _check?: CheckConnection;

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
            settings.idleCheckInterval, this._idlePing(settings.healthCheck as IHealthCheck)
        );

        this._checksApart = !!settings.healthCheck;
        this._status = new PoolStatus(this, settings, false);

        Logger.info("configuration pool finished in host: " + this.host);
    }

    /**
     * Create pool connection
     */
    public async connect(outcome: ICheckOutcome = {}) {
        const attempt = this._newAttempt(outcome);
        // flags of the settings are used as they are. Without them the server decides
        const flags = this._flags === undefined ? await this._flagsFromServer() : this._flags;
        if (attempt !== this._connectAttempt) {
            throw new Error("pool in host " + this.host + " was closed or connected again while connecting");
        }

        const flagsMeta = flags === undefined ? undefined : { flags };
        Logger.debug("Creating pool in host: " + this.host, flagsMeta);
        // left out when unset, so mysql2 keeps its default flags. mysql2 takes a string too
        const flagsOption = flags === undefined ? {} : { flags: flags as string[] };
        this._pool = mysql.createPool({
            ...this._connectionOptions(),
            connectionLimit: this.connectionLimit,
            ...flagsOption
        })
        // Nothing is opened here: the check below opens the connection, within its own
        // timeout. One that a connect() without a disconnect() left is closed, and a
        // query that is still out on it is told where to ask instead
        const replaced = this._check;
        this._check = this._checksApart
            ? new CheckConnection({ ...this._connectionOptions(), ...flagsOption }, this._database)
            : undefined;
        replaced?.close(this._check);

        this._reaper.start(this._pool as any);
        this.status.startTimerCheck(); // marks the status active, and undoes the stop of a disconnect()
        this._connectEvents();
        await this.status.checkStatus(outcome);

        if (this.status.isValid) {
            Logger.info('Pool is connected');
            Events.emit('pool_connected', this.id);
        } else {
            throw new Error("pool in host " + this.host + " is not valid");
        }
    }

    /**
     * What a connection to this node needs. The pool, the login that asks the server for
     * its version and the check connection all use it, so an option added here reaches all
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
        return PoolStatus.ownError(error);
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
        this._check?.close();
        this._check = undefined;
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
     * @param outcome gets `sent`: whether the statement went to the server. A failed call
     * also writes it on its error, when the error can take it
     */
    public async query<T extends QueryResult>(
        sql: string, queryOptions?: IQueryOptions, outcome: IQueryOutcome = {}
    ): Promise<T | T[]> {
        return new Promise(async (resolve, reject) => {
            outcome.sent = false;
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
                // Before the caller hears of it, so every call after this one sees the node
                // as it is now. Without a connection the error came instead of one. The
                // check of a node with a healthCheck block is not here: it asks on its own
                // connection. That of a node without one is, and passive health skips it
                this._status.realFailure(error, !conn);
                Pool._handBack(conn, error);
                Pool._writeSent(error, outcome.sent);
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
                    // from here on the statement can run on the server, whatever comes back
                    outcome.sent = true;
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
                // passive health, as in query()
                this._status.realFailure(error, !conn);
                // a broken connection can't roll back; destroying it makes the server discard the transaction
                if (rollback && !Pool._isBroken(error)) {
                    conn.query({ sql: 'ROLLBACK', timeout: queryOptions.timeout }, (errorR) => {
                        if (errorR) {
                            Logger.error("Rollback failed in pool by host " + this.host + ": " + errorR.message);
                            // the connection may have been lost under the rollback
                            this._status.realFailure(errorR, false);
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
            // the code is the one mysql2 has for a timeout, but this timer is the package's own
            const error = PoolStatus.ownError(new Error("Change database timeout"));
            callback(Object.assign(error, { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }));
        }, timeout);

        conn.changeUser({ database }, (error) => {
            clearTimeout(timer);
            if (done) return;
            done = true;
            callback(error);
        });
    }

    /**
     * Write on the error of a failed query() whether its statement was sent. A frozen error,
     * or one that is no object, goes to the caller without it: the outcome says it too
     * @param error what the query is rejected with
     * @param sent whether the statement went to the server
     * @private
     */
    private static _writeSent(error: any, sent: boolean): void {
        try {
            error.sent = sent;
        } catch {
            // the outcome of the call carries it
        }
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
     * its limit. Rejects with the error object of mysql2.
     * With a signal the wait ends when the signal aborts: the call rejects with the reason of
     * the signal, its request leaves the queue of mysql2, and a connection that still arrives
     * for it is released. No listener stays on the signal once the call settled
     * @param signal ends the wait when it aborts
     * @param outcome filled with `aborted: true` when the call was rejected by the abort
     */
    public getConnection(
        signal?: AbortSignal, outcome: IAbortOutcome = {}
    ): Promise<PoolConnection> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                outcome.aborted = true;
                return reject(Pool.abortReason(signal));
            }
            if (!this._pool) return reject(this._notConnected());
            // the pool this request goes to. A later connect() puts another one in its place
            const mysqlPool = this._pool;

            // whichever comes first settles the call: the answer of mysql2, or the abort
            let answered = false;
            let aborted = false;
            const stopListening = () => signal?.removeEventListener('abort', onAbort);
            const callback = (error: Error, connection: PoolConnection) => {
                // Passive health hears of a connection that could not be opened, also when
                // the caller is gone by now. The abort itself is never told to it
                if (error) this._status.realFailure(error, true);
                // the caller is gone: a connection that still arrives goes back to the pool,
                // and the error of a login that failed is dropped
                if (aborted) return this._releaseLate(connection);
                answered = true;
                stopListening();
                return error ? reject(error) : resolve(connection);
            };
            // The signal of the app calls this inside its abort(). Nothing may be thrown there
            const onAbort = () => {
                if (answered) return;
                aborted = true;
                outcome.aborted = true;
                try {
                    stopListening();
                    this._leaveQueue(mysqlPool, callback);
                } catch (thrown) {
                    Logger.warn("Pool " + this.name + ": could not take an aborted request out " +
                        "of the queue, its connection is released when it arrives",
                        { nodeId: this.id, pool: this.name, error: thrown?.message || thrown });
                }
                reject(Pool.abortReason(signal));
            };

            // before the request: mysql2 can answer at once, and the answer takes it off again
            signal?.addEventListener('abort', onAbort);
            try {
                mysqlPool.getConnection(callback);
            } catch (thrown) {
                // a listener of an event of mysql2 threw. The call fails, as it did before
                answered = true;
                stopListening();
                reject(thrown);
            }
        });
    }

    /**
     * What a call is rejected with when its signal aborted: the reason of the signal as it is.
     * A signal without one, as on a Node that has no signal.reason yet, gives an Error
     * named AbortError
     * @param signal the signal that aborted
     */
    public static abortReason(signal: AbortSignal): unknown {
        if (signal.reason !== undefined) return signal.reason;
        // the name, the code and the message of the AbortError of Node itself
        return Object.assign(new Error("The operation was aborted"), {
            name: 'AbortError', code: 'ABORT_ERR'
        });
    }

    /**
     * Release a connection that arrived for a request its signal already ended. This runs in
     * a callback of mysql2, where a throw would be an uncaught exception, and release() runs
     * the release listeners of the app. mysql2 puts the connection back into the pool before
     * it calls them, so the connection is in the pool also when one of them threw
     * @param connection the connection that arrived, or nothing when its login failed
     * @private
     */
    private _releaseLate(connection?: PoolConnection): void {
        try {
            connection?.release();
        } catch (thrown) {
            Logger.warn("Pool " + this.name + ": the release of a connection that arrived " +
                "for an aborted request threw",
                { nodeId: this.id, pool: this.name, error: thrown?.message || thrown });
        }
    }

    // the mysql2 pools whose queue could not be searched, each reported once
    private readonly _unsearchable = new WeakSet<object>();

    /**
     * Take the callback of one waiting request out of the queue of mysql2. The requests around
     * it keep their place. It does nothing when the callback is not there: the connection of
     * the request still logs in, or mysql2 queued a wrapper of the callback, as it does while
     * its pool is traced. A queue that is not the one mysql2 3 keeps is left alone too, and
     * that is logged once for the mysql2 pool: no aborted request can leave such a queue
     * @param mysqlPool the mysql2 pool the request was sent to
     * @param callback the callback handed to mysql2
     * @private
     */
    private _leaveQueue(mysqlPool: mysql.Pool, callback: unknown): void {
        const queue = (mysqlPool as any)._connectionQueue;
        if (typeof queue?.get !== 'function' || typeof queue.removeOne !== 'function') {
            if (this._unsearchable.has(mysqlPool)) return;
            this._unsearchable.add(mysqlPool);
            Logger.warn("Pool " + this.name + ": the queue of this mysql2 cannot be searched. " +
                "An aborted request stays in it and its connection is released on its turn",
                { nodeId: this.id, pool: this.name });
            return;
        }
        for (let index = 0; index < queue.length; index++) {
            if (queue.get(index) !== callback) continue;
            queue.removeOne(index);
            return;
        }
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
        // the error is the app's. A health check that waits must not report its code as the
        // server's
        PoolStatus.ownError(error);

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

    /**
     * What the last health check failed with, as PoolStatus.checkError keeps it: reduced to
     * code, errno and sqlState, a new object on every read, undefined when the last check got
     * its answer. The cluster reads it for nodes(). The results of ready and firstReady take
     * the outcome of their own connect() instead
     */
    public get checkError(): PoolStatus['checkError'] {
        return this._status.checkError;
    }

    /**
     * Whether the node holds its check connection right now: open, or logging in. False
     * for a node without a healthCheck block, and before the first check of a connect()
     */
    public get holdsCheckConnection(): boolean {
        return !!this._check?.held;
    }

    /**
     * One query of a health check on the check connection of this node, which is opened
     * when none is held. Never through the pool, so it waits for no connection of the app
     * and is no query of the app to passive health. It sends a change of user first, as
     * query() does, and has no timeout: the check has its own timer and calls
     * `asked.drop` when it gives up.
     * The attempt is one record of the operation metric, as a check through query() is.
     * Rejects with the error of mysql2, or with POOL_NOT_CONNECTED outside connect() and
     * disconnect()
     * @param sql the status query
     * @param keeps when given, the query goes out on a new connection beside the one the
     * node holds, which stays until the new one logged in. It says by the error of a new
     * one that did not log in whether the held one stays after that, too
     * @param asked gets `drop`, which drops the connection the query went to and no other:
     * a second connect() may have put a new one in its place by then
     */
    public checkQuery<T>(
        sql: string, keeps?: (error: any) => boolean, asked: { drop?: () => void } = {}
    ): Promise<T> {
        const metricOptions = { ...this._metricOptions(this._database), sql };
        const queryTimer = new QueryTimer();
        queryTimer.start();
        return this._askCheckConnection<T>(sql, this._check, keeps, asked).then(result => {
            queryTimer.end();
            Metrics.recordOperation(queryTimer.get(), metricOptions);
            return result;
        }, error => {
            queryTimer.end();
            Metrics.recordOperation(queryTimer.get(), { ...metricOptions, error });
            throw error;
        });
    }

    /**
     * Send the query on the check connection of this connect(). A second connect() without
     * a disconnect() closes that connection and holds a new one, also while a check logs
     * in or asks on the old one. A query that fails on a connection that was replaced
     * that way is asked again on the one that took its place. Not after a disconnect():
     * a check from before it is dropped, and asks nothing of a later connect()
     * @param check the connection to ask on
     * @param keeps see checkQuery()
     * @param asked see checkQuery()
     * @private
     */
    private _askCheckConnection<T>(
        sql: string, check = this._check, keeps?: (error: any) => boolean,
        asked: { drop?: () => void } = {}
    ): Promise<T> {
        if (!check) return Promise.reject<T>(this._notConnected());
        const answer = keeps ? check.queryOnNew<T>(sql, keeps, asked) : check.query<T>(sql, asked);
        return answer.catch(error => {
            if (!check.replacedBy) throw error;
            return this._askCheckConnection<T>(sql, check.replacedBy, undefined, asked);
        });
    }

    /**
     * Drop the check connection the node holds, so the next check opens a new one. A check
     * that gives up does not call this: it drops the connection it asked on, through the
     * `asked` of checkQuery()
     */
    public dropCheckConnection(): void {
        this._check?.drop();
    }

    /**
     * Count a connect() call, and tell its caller that no health check of that call is recorded
     * yet. The first check of the call says so when it is recorded. A call that is given up
     * before its check, or whose check is dropped, leaves it at that
     * @param outcome the object the caller of connect() handed in
     * @returns the number of this connect() call
     * @private
     */
    private _newAttempt(outcome: ICheckOutcome): number {
        outcome.recorded = false;
        return ++this._connectAttempt;
    }

    /**
     * The ping the reaper sends on the idle connections of this pool, for a node with a
     * healthCheck block: its check asks on a connection of its own, so nothing else uses a
     * pooled connection while the app is quiet. A node without the block has no ping. Its
     * check draws from the pool.
     * A ping gets the timeout of the block. One that fails takes its connection out of the
     * pool and is one debug line. It is no check: it moves no node and counts toward nothing
     * @param block the healthCheck block of the node, with every key, or nothing
     * @private
     */
    private _idlePing(block?: IHealthCheck): IIdlePing | undefined {
        if (!block) return undefined;
        return {
            timeout: block.timeout,
            // the code names the cause. A connection mysql2 dropped before has none
            removed: error => Logger.debug(
                "Pool " + this.name + ": an idle connection failed its ping and was closed",
                { pool: this.name, idlePing: 'failed', code: error?.code }
            )
        };
    }
}
