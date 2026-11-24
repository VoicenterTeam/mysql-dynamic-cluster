/**
 * Created by Bohdan on Sep, 2021
 */

import mysql, { PoolConnection } from "mysql2";
import Logger from "../utils/Logger";
import { ILogger } from "../types/LoggerInterfaces";
import { IClusterContext } from "../types/ClusterContextInterfaces";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import {
    IAbortOutcome, IAttemptTiming, ICheckOutcome, IQueryOptions, IQueryOutcome, QueryResult,
    QueryValues
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
import { Reply, SessionState } from './SessionState';
import { Borrow } from './Borrow';
import { abortReason, isBroken, timeoutError, whenAborted } from '../utils/Abort';
import { LONGEST_TIMER } from '../configs/schema';

// What the cluster and the health check hand Pool.query() beside the options of the app. In
// no type of the package's public interface
export interface IPoolCall {
    // the values the server binds, with the option `execute`. Not read without it
    values?: QueryValues,
    // the cluster wrote values into sql. The pool refuses to send such a statement on a
    // connection with NO_BACKSLASH_ESCAPES: MDC_UNSAFE_SQL_MODE, `sent: false`
    valuesInText?: boolean,
    // false for the health check of a node without a block only: it draws the connection
    // with no probe, and a node that goes down does not fail its request that waits for a
    // connection, see Borrow
    probe?: boolean,
    // filled by the pool for the onTiming and onStep options of the cluster: the step the call
    // ended in and the time it waited for a connection
    timing?: IAttemptTiming
}

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
    // the statements of execute() mysql2 keeps per connection, see SessionState.executed()
    private readonly _maxPreparedStatements: number;

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
    // the database and the dirty mark of each connection of the pool
    private readonly _session: SessionState;
    // where every connection of the pool is taken and given back
    private readonly _borrow: Borrow;
    // the logger and the metrics name of the cluster of this pool (#86)
    private readonly _context: IClusterContext;
    private readonly _logger: ILogger;

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
     * @param context the logger and the metrics name of the cluster. Left out: the module
     * logger, and the name of Metrics.init
     */
    constructor(
        settings: IUserPoolSettings,
        clusterName: string,
        context: IClusterContext = { logger: Logger }
    ) {
        this._context = context;
        this._logger = context.logger;
        this.id = settings.id;
        this.host = settings.host;
        this.port = settings.port;
        this.name = settings.name ? settings.name : `${this.host}:${this.port}`
        this._logger.debug(`Configure pool named ${this.name} ${this.host}:${this.port}`);

        this._user = settings.user;
        this._password = settings.password;
        this._database = settings.database;
        this._queryTimeout = settings.queryTimeout;
        this._slowQueryTime = settings.slowQueryTime;
        this._redisFactor = settings.redisFactor;
        this._redisExpire = settings.redisExpire;
        this._flags = settings.flags;

        this.connectionLimit = settings.connectionLimit;
        // a Pool built without the settings schema still keeps its statements, probes its
        // idle connections and resets a connection after many statements
        this._maxPreparedStatements = settings.maxPreparedStatements ?? 100;
        this._session = new SessionState(
            this.name, this._database, settings.resetTimeout ?? 1000, this._maxPreparedStatements,
            settings.resetAfterStatements ?? 1000, this._logger
        );

        this._reaper = new IdleConnectionReaper(
            settings.minConnections,
            settings.idleTimeout,
            settings.idleCheckInterval, this._idlePing(settings.healthCheck as IHealthCheck)
        );

        this._checksApart = !!settings.healthCheck;
        this._status = new PoolStatus(this, settings, false, () => this._nodeWentDown(), context);
        this._borrow = new Borrow({
            id: this.id,
            name: this.name,
            connectionLimit: this.connectionLimit,
            status: this._status,
            mysqlPool: () => this._pool,
            notConnected: () => this._notConnected()
        }, this._session, this._reaper, settings.probeIdle ?? 1000, settings.probeTimeout ?? 1000,
            this._logger);

        this._logger.info("configuration pool finished in host: " + this.host);
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
        this._logger.debug("Creating pool in host: " + this.host, flagsMeta);
        // left out when unset, so mysql2 keeps its default flags. mysql2 takes a string too
        const flagsOption = flags === undefined ? {} : { flags: flags as string[] };
        this._pool = mysql.createPool({
            ...this._connectionOptions(),
            connectionLimit: this.connectionLimit,
            maxPreparedStatements: this._maxPreparedStatements,
            ...flagsOption
        })
        // Nothing is opened here: the check below opens the connection, within its own
        // timeout. One that a connect() without a disconnect() left is closed, and a
        // query that is still out on it is told where to ask instead
        const replaced = this._check;
        this._check = this._checksApart
            ? new CheckConnection(
                { ...this._connectionOptions(), ...flagsOption }, this._database, this.name,
                this._logger)
            : undefined;
        replaced?.close(this._check);

        this._reaper.start(this._pool as any);
        this.status.startTimerCheck(); // marks the status active, and undoes the stop of a disconnect()
        this._connectEvents();
        await this.status.checkStatus(outcome);

        if (this.status.isValid) {
            // A disconnect() or a later connect() came during the check: this connect()
            // tells nothing, so no pool_connected comes after a pool_disconnected
            if (attempt !== this._connectAttempt) return;
            this._logger.info('Pool is connected');
            this._emitToApp('pool_connected', this.id);
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
            this._logger.warn(pool + "could not read the server version, connecting with " + decision.flags, meta);
        } else if (decision.reason === 'version_unreadable') {
            this._logger.warn(pool + "server version is not readable, connecting with " + decision.flags, meta);
        } else if (decision.flags) {
            this._logger.info(pool + "server " + greeting.serverVersion + " needs " + decision.flags +
                ", set flags in the settings to override", meta);
        } else {
            this._logger.debug(pool + "server " + greeting.serverVersion + " keeps the default flags of mysql2", meta);
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
            this._logger.debug("Open connection");
            this._emitToApp('connection', connection, this.id);
        })

        this._pool.on("release", (connection) => {
            this._reaper.onRelease(connection);
            this._logger.debug("Connection closed");
            this._emitToApp('release', connection, this.id);
        })

        this._pool.on('acquire', (connection) => {
            this._reaper.onAcquire(connection);
            this._logger.debug("Connection is acquire");
            this._emitToApp('acquire', connection, this.id);
        })
    }

    /**
     * Emit an event of this pool to the listeners of the app. Those of a connection run
     * inside a handler of mysql2, where a throw would lose the connection or leave a query
     * pending for ever. Those of pool_connected and pool_disconnected run inside connect()
     * and disconnect(), which a throw would reject or cut short. So a listener that throws
     * is logged at warn, and the throw goes no further
     * @param args what the listeners get, the id of the pool last
     * @private
     */
    private _emitToApp(
        event: 'connection' | 'acquire' | 'release' | 'pool_connected' | 'pool_disconnected',
        ...args: unknown[]
    ) {
        try {
            Events.emit(event, ...args);
        } catch (thrown) {
            let error: unknown;
            try {
                error = thrown?.message || thrown;
            } catch {
                // a revoked proxy, a message getter that throws
                error = 'unreadable error';
            }
            this._logger.warn("Pool " + this.name + ": a listener of the " + event + " event threw",
                { nodeId: this.id, pool: this.name, error });
        }
    }

    /**
     * Close pool connection
     */
    public disconnect() {
        this._logger.debug("closing pool in host: " + this.host);
        // a connect() that still asks the server must not open a pool after this
        this._connectAttempt++;
        this._probe?.cancel();
        this._probe = undefined;
        this._check?.close();
        this._check = undefined;
        this._pool?.end((error) => {
            if (error) {
                this._logger.error(error.message);
            }
        });
        this.status.active = false;
        this.status.stopTimerCheck();
        this._reaper.stop();
        this._emitToApp('pool_disconnected', this.id);

        this._logger.info("pool named " + this.name + " closed");
    }

    /**
     * Pool query
     * @param sql mysql query string
     * @param queryOptions query options like timeout, database, multipleStatements etc
     * @param outcome gets `sent`: whether the statement went to the server. A failed call
     * also writes it on its error, when the error can take it. Gets `aborted: true` when the
     * signal of the options ended the call, which then rejects with the reason of the signal
     * as it is: nothing is written on it, and passive health is not told
     * @param call the values, valuesInText, probe and timing, see IPoolCall
     */
    public async query<T extends QueryResult>(
        sql: string, queryOptions?: IQueryOptions, outcome: IQueryOutcome = {},
        call: IPoolCall = {}
    ): Promise<T | T[]> {
        const { values, valuesInText = false, probe = true, timing = {} } = call;
        return new Promise((resolve, reject) => {
            outcome.sent = false;
            timing.step = 'queue';
            timing.queuedMs = 0;
            queryOptions = {
                timeout: this._queryTimeout,
                database: this._database,
                redisFactor: this._redisFactor,
                redisExpire: this._redisExpire,
                ...queryOptions
            }
            const signal = queryOptions.signal;
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

            // An abort or packets out of order settle the call before mysql2 calls back, if it
            // ever does. Settle only once
            let settled = false;
            // the connection of the call, from its arrival until the call settled
            let held: mysql.PoolConnection | undefined;
            // the listener of the signal while the statement runs
            let stopAbort: (() => void) | undefined;
            // every way the call settles comes here. The timer of the statement goes with its
            // reply, or with the connection, see SessionState.send()
            const stopListening = () => stopAbort?.();
            const fail = (error: any, conn?: mysql.PoolConnection) => {
                if (settled) return;
                settled = true;
                stopListening();
                queryTimer.end();
                Metrics.recordOperation(queryTimer.get(), {
                    ...poolMetricOption, error, step: timing.step,
                    waitSeconds: timing.queuedMs / 1000
                });
                // Before the caller hears of it, so every call after this one sees the node
                // as it is now. An error that came without a connection was told by the
                // borrow. The check of a node with a healthCheck block is not here: it asks on
                // its own connection. That of a node without one is, and passive health skips it
                if (conn) this._status.realFailure(error, false);
                this._handBack(conn, error);
                Pool._writeSent(error, outcome.sent);
                reject(error);
            }
            // the signal ended the call: its reason as it is, recorded as the error of the
            // attempt. The abort is never told to passive health
            const abort = (reason: unknown) => {
                settled = true;
                outcome.aborted = true;
                queryTimer.end();
                Metrics.recordOperation(queryTimer.get(), {
                    ...poolMetricOption, error: reason || {}, step: timing.step,
                    waitSeconds: timing.queuedMs / 1000
                });
                reject(reason);
            }
            // The signal of the app calls this inside its abort(). Nothing may be thrown there.
            // The reset, the USE or the statement may still run on the connection, so it is
            // destroyed, never handed back: the pool opens a new one in its place
            const onAbort = () => {
                if (settled) return;
                // before the connection is destroyed, so no callback destroy() runs can win
                settled = true;
                outcome.aborted = true;
                stopListening();
                try {
                    this._borrow.drop(held);
                } catch (thrown) {
                    this._logger.warn("Pool " + this.name + ": could not destroy the connection of " +
                        "an aborted query", { nodeId: this.id, pool: this.name,
                        error: thrown?.message || thrown });
                }
                abort(abortReason(signal));
            };

            // The borrow takes the connection, probes it after idle, resets it when dirty,
            // sends USE for another database and DO 0 when the guard below needs the sql_mode.
            // An abort meanwhile is the borrow's as well
            const asked: IAbortOutcome = {};
            const { database, execute } = queryOptions;
            const timeout = Pool._withinTimer(queryOptions.timeout);
            const target = { database, timeout, valuesInText: valuesInText && !execute };
            this._borrow.take({ signal, target, probe }, asked, timing).then(conn => {
                held = conn;
                // the signal aborted after the borrow took its listener off
                if (signal?.aborted) return onAbort();
                stopAbort = whenAborted(signal, onAbort);
                // packets out of order: the borrow has dropped the connection by now
                this._borrow.watch(conn, error => fail(error, conn));
                const bound = queryOptions.execute;
                // values in the text, where the server reads a backslash as a character. The
                // borrow made the sql_mode known for such a call
                if (!bound && valuesInText && this._session.noBackslashEscapes(conn)) {
                    return fail(Pool._unsafeSqlMode(), conn);
                }

                this._logger.debug(`Query in pool by host ${this.host}`);
                // from here on the statement can run on the server, whatever comes back
                const before = timing.step;
                timing.step = 'statement';
                outcome.sent = true;
                const onReply = (error: mysql.QueryError | null, result: T) => {
                    this._session.observe(conn, error, result);
                    if (error) return fail(error, conn);
                    if (settled) return;
                    settled = true;
                    stopListening();
                    this._borrow.giveBack(conn);

                    queryTimer.end();
                    Metrics.recordOperation(queryTimer.get(), {
                        ...poolMetricOption, step: timing.step, waitSeconds: timing.queuedMs / 1000
                    });
                    if (queryTimer.get() >= this._slowQueryTime) {
                        this._logger.warn(`Query in pool named ${this.name} takes ` +
                            `${queryTimer.get()} sec`);
                    }

                    if (queryOptions.redis) {
                        const redisExpired = new Date().getTime() +
                            queryTimer.get() * 1000 * queryOptions.redisFactor;
                        const redisData: IRedisData = {
                            data: result,
                            expired: redisExpired
                        }
                        Redis.set(sql, JSON.stringify(redisData), queryOptions.redisExpire);
                    }

                    resolve(result);
                };
                try {
                    // the only step a bound statement does differently. The timer of the pool
                    // covers its prepare too
                    if (bound) {
                        this._session.executed(conn, sql);
                        const ask = (sent: Reply) => conn.execute({ sql, values }, sent);
                        this._session.send(conn, timeout, ask, onReply, Pool._boundTimedOut);
                    } else {
                        const ask = (sent: Reply) => conn.query({ sql }, sent);
                        this._session.send(conn, timeout, ask, onReply);
                    }
                } catch (thrown) {
                    // mysql2 refused the call before it wrote anything, such as values
                    // with undefined in them: the statement never reached the connection
                    outcome.sent = false;
                    timing.step = before;
                    return fail(thrown, conn);
                }
                // mysql2 has the statement: from here onStep counts it as sent
                timing.enter?.('statement');
            }, error => {
                if (asked.aborted) return abort(error);
                fail(error);
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
            // for every command of the transaction, the USE and the ROLLBACK
            queryOptions.timeout = Pool._withinTimer(queryOptions.timeout);
            // no sql: a transaction has no single operation name
            const poolMetricOption = this._metricOptions(queryOptions.database);

            const queryTimer = new QueryTimer();
            queryTimer.start();
            const results: T[] = [];
            // every command of the transaction within the timeout, see SessionState.send()
            const send = (conn: PoolConnection, sql: string, reply: Reply) => {
                const ask = (sent: Reply) => conn.query({ sql }, sent);
                this._session.send(conn, queryOptions.timeout, ask, reply);
            };

            let settled = false;
            const fail = (error: any, conn?: mysql.PoolConnection, rollback: boolean = false) => {
                if (settled) return;
                settled = true;
                queryTimer.end();
                Metrics.recordOperation(queryTimer.get(), { ...poolMetricOption, error });
                // passive health and the dirty rule, as in query(): an error reply leaves the
                // session dirty, and a 1047 drops the connection at its release
                if (conn) {
                    this._status.realFailure(error, false);
                    this._session.observe(conn, error);
                }
                // a broken connection can't roll back; destroying it makes the server discard the transaction
                if (rollback && !isBroken(error)) {
                    send(conn, 'ROLLBACK', (errorR, resultR) => {
                        if (errorR) {
                            this._logger.error("Rollback failed in pool by host " + this.host + ": " + errorR.message);
                            // the connection may have been lost under the rollback
                            this._status.realFailure(errorR, false);
                            this._borrow.giveBack(conn, true);
                        } else {
                            // clean, unless the transaction turned autocommit off
                            this._session.observe(conn, undefined, resultR);
                            this._borrow.giveBack(conn);
                        }
                        reject(error);
                    });
                    return;
                }
                this._handBack(conn, error);
                reject(error);
            }

            // A reset when the connection is dirty, a USE when it is on another database.
            // The transaction ends with its own COMMIT or ROLLBACK, so a clean reply of it
            // sends the connection back with no reset
            const { database, timeout } = queryOptions;
            this._borrow.take({ target: { database, timeout } }).then(conn => {
                // queries run one after another; commit only after the last one succeeded
                const runQuery = (index: number) => {
                    if (index >= sqls.length) {
                        this._logger.debug("Commit transaction in pool by host " + this.host);
                        send(conn, 'COMMIT', (errorC, resultC) => {
                            if (errorC) return fail(errorC, conn, true);
                            if (settled) return;
                            settled = true;

                            queryTimer.end();
                            Metrics.recordOperation(queryTimer.get(), poolMetricOption);
                            // clean, unless the transaction turned autocommit off
                            this._session.observe(conn, undefined, resultC);
                            this._borrow.giveBack(conn);
                            resolve(results);
                        });
                        return;
                    }

                    send(conn, sqls[index], (errorQ, result: T) => {
                        if (errorQ) return fail(errorQ, conn, true);
                        // every header here says a transaction is open: the database rule only
                        this._session.observeDatabase(conn, result);
                        results.push(result);
                        runQuery(index + 1);
                    });
                }

                this._logger.debug("Start transaction in pool by host " + this.host);
                send(conn, 'START TRANSACTION', errorT => {
                    if (errorT) return fail(errorT, conn);
                    runQuery(0);
                })
            }, error => fail(error))
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
            database,
            clusterName: this._context.clusterName
        }
    }

    /**
     * The error of a bound statement that ran out of its timeout, see SessionState.send(): the
     * package's own, as when only the pool timed the prepare. The code is the one mysql2 gives
     * a timeout, so the connection counts as broken and is destroyed
     * @private
     */
    private static _boundTimedOut(): Error {
        return PoolStatus.ownError(timeoutError("Query inactivity timeout"));
    }

    /**
     * The timeout of a call, within the longest wait of a timer: a longer one would make the
     * timer of a command fire after 1 ms, and destroy the connection.
     * Undefined and 0, no timeout, stay as they are
     * @param timeout the timeout option of the call
     * @private
     */
    private static _withinTimer(timeout: number): number {
        return timeout > LONGEST_TIMER ? LONGEST_TIMER : timeout;
    }

    /**
     * The error of a query() whose values are in its text, on a connection with
     * NO_BACKSLASH_ESCAPES: the escaping of mysql2 does not protect a value there
     * @private
     */
    private static _unsafeSqlMode(): Error {
        const error: any = new Error("The server has NO_BACKSLASH_ESCAPES on for this " +
            "connection: values written into the SQL text are not safe, so the statement was " +
            "not sent. Use execute() to send the values bound by the server");
        error.code = 'MDC_UNSAFE_SQL_MODE';
        return error;
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
     * Hand connection back to the pool, or destroy it if it's broken so it's never reused.
     * A dirty one is reset first, see Borrow
     * @param conn connection to hand back
     * @param error error from mysql
     * @private
     */
    private _handBack(conn: mysql.PoolConnection, error?: any) {
        if (conn) this._borrow.giveBack(conn, isBroken(error));
    }

    /**
     * Take one connection out of the pool and lend it to the app: probed on the way out when
     * it was idle longer than probeIdle, with no database change, no timeout and no metric.
     * One request to mysql2, which waits when the pool is at its limit. The pool sees neither
     * the database nor the transaction the app leaves on it, so the release() of the app resets
     * it before it goes back, a second release() does nothing, and a query of the pool that
     * gets it sends USE first, see Borrow.lend(). Rejects with the error object of mysql2, or
     * with the error of the last probe when no connection passed.
     * With a signal the wait ends when the signal aborts: the call rejects with the reason of
     * the signal, its request leaves the queue of mysql2, and a connection that still arrives
     * for it is released. No listener stays on the signal once the call settled. See Borrow
     * @param signal ends the wait when it aborts
     * @param outcome filled with `aborted: true` when the call was rejected by the abort
     */
    public async getConnection(
        signal?: AbortSignal, outcome: IAbortOutcome = {}
    ): Promise<PoolConnection> {
        const connection = await this._borrow.take({ signal }, outcome);
        this._borrow.lend(connection);
        return connection;
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

        const failed = this._failQueue(queue, () => error);
        this._logger.info("Pool " + this.name + ": failed " + failed + " requests that " +
            "waited for a connection in host " + this.host,
            { nodeId: this.id, pool: this.name, failed });
        return failed;
    }

    /**
     * The node went down: fail every request that waits for one of its connections, as
     * failWaiting() does, each with an MDC_NODE_DOWN error of its own. The status query of the
     * legacy check that waits keeps its place, so the check counts no failure for it.
     * Connections in use and logins that are still running are left alone. PoolStatus calls it.
     * One info line when a request was failed. A queue that is not the one mysql2 3 keeps is
     * left as it is, with one warn line
     * @private
     */
    private _nodeWentDown(): void {
        const queue = (this._pool as any)?._connectionQueue;
        if (!queue) return;
        if (typeof queue.shift !== 'function' || typeof queue.push !== 'function') {
            this._logger.warn("Pool " + this.name + " went down, but the queue of this mysql2 " +
                "cannot be read: the requests that wait for a connection stay in it",
                { nodeId: this.id, pool: this.name });
            return;
        }
        const failed = this._failQueue(
            queue, () => this._nodeDownError(), callback => this._borrow.isCheck(callback)
        );
        if (!failed) return;
        this._logger.info("Pool " + this.name + " went down: failed " + failed + " requests that " +
            "waited for a connection in host " + this.host,
            { nodeId: this.id, pool: this.name, failed });
    }

    /**
     * The error of a request that waited for a connection of this node when it went down: a
     * new object for each request. No statement was sent. The package's own, so passive health
     * and a check never count it
     * @private
     */
    private _nodeDownError(): Error {
        const error = new Error("The node " + this.host + ":" + this.port +
            " went down while the request waited for a connection");
        return this._borrow.markNodeDown(Object.assign(PoolStatus.ownError(error), {
            code: 'MDC_NODE_DOWN', sent: false, nodeId: this.id
        }));
    }

    /**
     * Fail the requests that wait in the queue of mysql2, each with what errorFor() returns.
     * A request that `spared` names keeps its place in the queue
     * @param queue the queue of the mysql2 pool, with the callbacks of the waiting requests,
     * called as (error, connection)
     * @returns how many requests were failed
     * @private
     */
    private _failQueue(
        queue: any, errorFor: () => Error, spared: (callback: unknown) => boolean = () => false
    ): number {
        // taken out first: a callback that asks again waits in the queue, it is not failed here
        const waiting: ((error: Error) => void)[] = [];
        for (let left = queue.length; left > 0; left--) {
            const callback = queue.shift();
            if (spared(callback)) queue.push(callback);
            else waiting.push(callback);
        }
        waiting.forEach(callback => {
            try {
                callback(errorFor());
            } catch (thrown) {
                // the requests behind it are already out of the queue and must still be failed
                this._logger.error("A request that waited in pool by host " + this.host +
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
     * Whether the check connection the node holds right now logged in. One that is still
     * logging in is not open. False for a node without a healthCheck block. Only PoolStatus
     * reads it
     * @internal
     */
    public get holdsOpenCheckConnection(): boolean {
        return !!this._check?.open;
    }

    /**
     * One query of a health check on the check connection of this node, which is opened
     * when none is held. Never through the pool, so it waits for no connection of the app
     * and is no query of the app to passive health. It sends a change of user to the database
     * of the node first, which query() does not, and has no timeout: the check has its own
     * timer and calls `asked.drop` when it gives up.
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
            removed: error => this._logger.debug(
                "Pool " + this.name + ": an idle connection failed its ping and was closed",
                { pool: this.name, idlePing: 'failed', code: error?.code }
            )
        };
    }
}
