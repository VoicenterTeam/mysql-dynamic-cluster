import mysql, { PoolConnection } from "mysql2";
import Logger from "../utils/Logger";
import { IAbortOutcome } from "../types/PoolInterfaces";
import { PoolStatus } from "./PoolStatus";
import { SessionState } from "./SessionState";
import { IDrawn, IdleConnectionReaper } from "./IdleConnectionReaper";
import { abortReason, isBroken, whenAborted } from "../utils/Abort";

// What Borrow needs of the pool it takes connections from
export interface IBorrowPool {
    // the id and the name of the node, for errors and the log
    id: number,
    name: string,
    connectionLimit: number,
    status: PoolStatus,
    // the mysql2 pool of the last connect(), nothing before the first
    mysqlPool: () => mysql.Pool | undefined,
    // the error of a borrow before connect() created the mysql2 pool
    notConnected: () => Error
}

// The database and the time limit of the statement a connection is taken for, see take()
export interface IStatementTarget {
    database: string | undefined,
    timeout: number
}

// How take() takes a connection
export interface ITakeOptions {
    // ends the call when it aborts. A connection the call holds by then is destroyed
    signal?: AbortSignal,
    // the statement the connection is for. Without it the connection is handed out as it is
    target?: IStatementTarget,
    // false for the health check of a node without a block only, which must draw the
    // connections of the app as they are
    probe?: boolean
}

/**
 * The one place a connection of a pool is taken and given back: by query(), its execute form,
 * multiStatementQuery() and getConnection(). Taking it:
 * - one request to mysql2, which waits in its queue while the pool is at its limit
 * - a connection idle longer than probeIdle answers a ping first, within probeTimeout, and
 *   so does one the reaper's ping is still out on. One that fails is destroyed, passive
 *   health hears of it, and the next connection of the node is taken: at most
 *   connectionLimit + 1 tries, and a new connection needs no ping
 * - for a statement, a reset when the connection is dirty and USE when it is on another
 *   database, see SessionState
 * - a signal ends any of these steps
 *
 * A connection is given back through SessionState: at once when clean, reset first when dirty.
 * While a step, a statement or the reset at its release runs, and while the app holds a lent
 * connection, packets out of order destroy the connection: mysql2 only warns of them and goes
 * on waiting
 */
export class Borrow {
    // the release() of mysql2 of every connection a lend replaced it on, see lend()
    private readonly _releases = new WeakMap<object, () => void>();
    // the 'warn' listener on each connection Borrow watches, see watch()
    private readonly _watching = new WeakMap<object, (warning: any) => void>();
    // the mysql2 pools whose queue could not be searched, each reported once
    private readonly _unsearchable = new WeakSet<object>();

    /**
     * @param _probeIdle time in ms a connection may be idle before it is probed
     * @param _probeTimeout time in ms a probe may take before the connection is destroyed
     */
    constructor(
        private readonly _pool: IBorrowPool,
        private readonly _session: SessionState,
        private readonly _reaper: IdleConnectionReaper,
        private readonly _probeIdle: number,
        private readonly _probeTimeout: number
    ) {}

    /**
     * Take a connection, see the class. Rejects with the error of mysql2 when no connection
     * came, with the error of the last probe when no connection passed, with the error of the
     * reset or the USE, or with the reason of the signal. Passive health was told by then of
     * what it hears of, and the statement was not sent
     * @param options the signal, the statement and whether to probe, see ITakeOptions
     * @param outcome gets `aborted: true` when the signal ended the call
     */
    public async take(
        options: ITakeOptions = {}, outcome: IAbortOutcome = {}
    ): Promise<PoolConnection> {
        const { signal, target, probe = true } = options;
        // a new connection needs no probe, so the loop ends with one. This bounds it besides.
        // A pool with no limit, connectionLimit 0, has a limited number of idle connections
        const most = this._pool.connectionLimit ? this._pool.connectionLimit + 1 : Infinity;
        for (let tries = 1; ; tries++) {
            const connection = await this._request(signal, outcome);
            const drawn = this._reaper.drawn(connection);
            // a ping of the reaper that is still out is waited for, within probeTimeout, also
            // on a connection used within probeIdle: mysql2 would queue the statement behind it
            // with no time limit
            if (probe && (drawn?.ping || this._idle(drawn))) {
                try {
                    await this._probe(connection, drawn, signal, outcome);
                } catch (error) {
                    if (outcome.aborted || tries >= most) throw error;
                    continue;
                }
            }
            return target ? this._prepare(connection, target, signal, outcome) : connection;
        }
    }

    /**
     * Give a connection back, see SessionState.release(). Packets out of order during the reset
     * of a dirty connection drop it (#94 saw them on such a command of a node that was not
     * Primary). The listener goes when the connection is back in the pool or destroyed
     * @param broken the socket is dead or still runs a statement: destroyed
     */
    public giveBack(connection: PoolConnection, broken = false): void {
        this.watch(connection, () => undefined);
        this._session.release(connection, broken, () => {
            this._unwatch(connection);
            this._putBack(connection);
        }, () => this._unwatch(connection));
    }

    /**
     * Destroy a connection with its socket. A release of it after this does nothing
     * @param error what a command still out on it fails with
     */
    public drop(connection: PoolConnection, error?: Error): void {
        this._unwatch(connection);
        this._session.drop(connection, error);
    }

    /**
     * Listen for packets out of order on the connection until it is given back or dropped:
     * the warning of mysql2 that has a whole-number `expected` and `received`. Then the
     * connection is dropped, a command still out on it fails with the warning of mysql2, and
     * `outOfOrder` gets an error with code MDC_PACKETS_OUT_OF_ORDER, the two numbers and
     * `nodeId`. One listener per connection: a second call replaces the first
     */
    public watch(connection: PoolConnection, outOfOrder: (error: Error) => void): void {
        this._unwatch(connection);
        const listener = (warning: any) => {
            // mysql2 emits other warnings too, such as one for end() on a pooled connection
            if (!Number.isInteger(warning?.expected) || !Number.isInteger(warning?.received)) {
                return;
            }
            this.drop(connection, warning);
            outOfOrder(this._outOfOrder(warning));
        };
        this._watching.set(connection, listener);
        connection.on('warn', listener);
    }

    /**
     * The app takes the connection through getConnection() of the cluster. SessionState marks
     * it dirty with an unknown database, so its release() resets it before it goes back: the
     * app's own release() goes through giveBack(), once. A second call does nothing until the
     * connection is lent again. While the app holds it, packets out of order drop it, and the
     * command of the app that is out fails with the warning of mysql2
     */
    public lend(connection: PoolConnection): void {
        this._session.lend(connection);
        // a lend before this one replaced it already: the one of mysql2 is kept from the first
        if (!this._releases.has(connection)) this._releases.set(connection, connection.release);
        this.watch(connection, () => undefined);
        let lent = true;
        connection.release = () => {
            if (!lent) return;
            lent = false;
            this.giveBack(connection);
        };
    }

    /**
     * One request to mysql2, the queue and the abort while it waits there. With a signal the
     * wait ends when the signal aborts: the request leaves the queue of mysql2, and a
     * connection that still arrives for it goes back to the pool
     * @private
     */
    private _request(
        signal: AbortSignal | undefined, outcome: IAbortOutcome
    ): Promise<PoolConnection> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                outcome.aborted = true;
                return reject(abortReason(signal));
            }
            // the pool this request goes to. A later connect() puts another one in its place
            const mysqlPool = this._pool.mysqlPool();
            if (!mysqlPool) return reject(this._pool.notConnected());

            // whichever comes first settles the call: the answer of mysql2, or the abort
            let aborted = false;
            const callback = (error: Error, connection: PoolConnection) => {
                // Passive health hears of a connection that could not be opened, also when
                // the caller is gone by now. The abort itself is never told to it
                if (error) this._pool.status.realFailure(error, true);
                if (aborted) return this._releaseLate(connection);
                stopListening();
                if (error) return reject(error);
                if (!connection) {
                    const message = "Can't find connection. Maybe it was unexpectedly closed.";
                    return reject(new Error(message));
                }
                resolve(connection);
            };
            const stopListening = whenAborted(signal, () => {
                aborted = true;
                outcome.aborted = true;
                try {
                    this._leaveQueue(mysqlPool, callback);
                } catch (thrown) {
                    Logger.warn("Pool " + this._pool.name + ": could not take an aborted " +
                        "request out of the queue, its connection is released when it arrives",
                        { nodeId: this._pool.id, pool: this._pool.name,
                            error: thrown?.message || thrown });
                }
                reject(abortReason(signal));
            });

            try {
                mysqlPool.getConnection(callback);
            } catch (thrown) {
                // a listener of an event of mysql2 threw. The call fails, as it did before
                stopListening();
                reject(thrown);
            }
        });
    }

    /**
     * Whether a connection the pool drew was idle longer than probeIdle: since its release,
     * or since the last ping of the reaper it answered. A new connection was never idle, and
     * neither was one mysql2 handed straight from one caller to the next. A ping of the
     * reaper still out on it is waited for whatever this says, see take()
     * @private
     */
    private _idle(drawn?: IDrawn): boolean {
        return drawn?.aliveAt !== undefined && Date.now() - drawn.aliveAt > this._probeIdle;
    }

    /**
     * Ask a connection whether it is alive, within probeTimeout: a ping, or the answer to the
     * ping of the reaper that is still out on it. A probe that fails, gets no answer in time
     * or meets packets out of order destroys the connection, and passive health hears of it
     * as a lost connection. An abort destroys it too, and rejects with the reason
     * @private
     */
    private _probe(
        connection: PoolConnection, drawn: IDrawn | undefined, signal: AbortSignal | undefined,
        outcome: IAbortOutcome
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            // every way the probe ends comes here, first one wins
            const end = (error?: any) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                stopListening();
                this._unwatch(connection);
                if (!error) return resolve();
                this._dropSafely(connection);
                if (!outcome.aborted) this._pool.status.probeFailed(error);
                reject(error);
            };
            const timer = setTimeout(() => end(Borrow._probeTimeout()), this._probeTimeout);
            // the socket keeps the process alive while the ping runs. This timer alone does not
            timer.unref();
            const stopListening = whenAborted(signal, () => {
                outcome.aborted = true;
                end(abortReason(signal));
            });
            this.watch(connection, end);
            if (signal?.aborted) {
                outcome.aborted = true;
                return end(abortReason(signal));
            }
            const answered = (error?: any) => end(error || undefined);
            try {
                if (drawn?.ping) drawn.ping(answered);
                else connection.ping(answered);
            } catch (thrown) {
                end(thrown || new Error("Probe failed"));
            }
        });
    }

    /**
     * Get the connection ready for the statement, see SessionState.prepare(). An error there
     * is told to passive health and gives the connection back. An abort or packets out of
     * order destroy it
     * @private
     */
    private _prepare(
        connection: PoolConnection, target: IStatementTarget, signal: AbortSignal | undefined,
        outcome: IAbortOutcome
    ): Promise<PoolConnection> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const end = (error?: any) => {
                if (settled) return false;
                settled = true;
                stopListening();
                this._unwatch(connection);
                if (error) reject(error);
                else resolve(connection);
                return true;
            };
            const stopListening = whenAborted(signal, () => {
                outcome.aborted = true;
                this._dropSafely(connection);
                end(abortReason(signal));
            });
            this.watch(connection, end);
            if (signal?.aborted) {
                outcome.aborted = true;
                this._dropSafely(connection);
                return end(abortReason(signal));
            }
            this._session.prepare(connection, target.database, target.timeout, error => {
                if (!error) return end();
                if (!end(error)) return;
                this._pool.status.realFailure(error, false);
                this.giveBack(connection, isBroken(error));
            });
        });
    }

    /**
     * Drop a connection inside a listener of a signal or a callback of mysql2, where nothing
     * may be thrown
     * @private
     */
    private _dropSafely(connection: PoolConnection): void {
        try {
            this.drop(connection);
        } catch (thrown) {
            Logger.warn("Pool " + this._pool.name + ": could not destroy a connection",
                { nodeId: this._pool.id, pool: this._pool.name, error: thrown?.message || thrown });
        }
    }

    /**
     * Put a connection into the pool of mysql2 with the release() of mysql2. A connection
     * that was lent has its own release() for the app, see lend()
     * @private
     */
    private _putBack(connection: PoolConnection): void {
        (this._releases.get(connection) ?? connection.release).call(connection);
    }

    // take the listener of watch() off the connection
    private _unwatch(connection: PoolConnection): void {
        const listener = this._watching.get(connection);
        if (!listener) return;
        this._watching.delete(connection);
        connection.removeListener('warn', listener);
    }

    /**
     * The error of a call whose reply came with packets out of order, see watch()
     * @private
     */
    private _outOfOrder(warning: { expected: number, received: number }): Error {
        const error = new Error("The packets of a reply came out of order: expected " +
            warning.expected + " but received " + warning.received +
            ". The connection was destroyed");
        return Object.assign(PoolStatus.ownError(error), {
            code: 'MDC_PACKETS_OUT_OF_ORDER',
            expected: warning.expected,
            received: warning.received,
            nodeId: this._pool.id
        });
    }

    // the error of a probe that got no answer in time
    private static _probeTimeout(): Error {
        // the code is the one mysql2 has for a timeout, as for the ping of the reaper
        return Object.assign(new Error("Probe timeout"), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    }

    /**
     * Give back a connection that arrived for a request its signal already ended. Nobody used
     * it. This runs in a callback of mysql2, where a throw would be an uncaught exception, and
     * the release runs the release listeners of the app. mysql2 puts the connection back into
     * the pool before it calls them, so the connection is in the pool also when one of them
     * threw
     * @param connection the connection that arrived, or nothing when its login failed
     * @private
     */
    private _releaseLate(connection?: PoolConnection): void {
        if (!connection) return;
        // what the reaper knew of it is of no use to anybody now
        this._reaper.drawn(connection);
        try {
            this.giveBack(connection);
        } catch (thrown) {
            Logger.warn("Pool " + this._pool.name + ": the release of a connection that " +
                "arrived for an aborted request threw",
                { nodeId: this._pool.id, pool: this._pool.name, error: thrown?.message || thrown });
        }
    }

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
            Logger.warn("Pool " + this._pool.name + ": the queue of this mysql2 cannot be " +
                "searched. An aborted request stays in it and its connection is released on " +
                "its turn", { nodeId: this._pool.id, pool: this._pool.name });
            return;
        }
        for (let index = 0; index < queue.length; index++) {
            if (queue.get(index) !== callback) continue;
            queue.removeOne(index);
            return;
        }
    }
}
