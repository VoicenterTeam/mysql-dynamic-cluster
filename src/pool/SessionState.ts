import mysql from "mysql2";
import Logger from "../utils/Logger";
import { PoolStatus } from "./PoolStatus";
import { drop } from "./ServerFlags";

// What the pool knows of the session of one of its connections
interface ISession {
    // the default database of the session. Undefined when the pool cannot know it: the app
    // had the connection
    database?: string,
    // the session may hold what the next user must not get, such as an open transaction.
    // It stays dirty until a reset
    dirty: boolean,
    // a reset failed and destroyed the connection: nothing is done with it any more
    dropped?: boolean
}

// status flags of the header of an OK reply
const IN_TRANSACTION = 1;
const AUTOCOMMIT = 2;
const SESSION_STATE_CHANGED = 0x4000;

/**
 * The session of the connections of one pool: which database each is on, and whether it is
 * dirty. The pool sends no change of user. A query for another database sends USE first, and
 * a dirty connection is reset before anyone uses it again. The rule for dirty and the reset
 * with its time limit live here and nowhere else
 */
export class SessionState {
    private readonly _sessions = new WeakMap<object, ISession>();

    /**
     * @param pool name of the pool, for the log
     * @param database the database mysql2 logs every connection of the pool in with
     * @param resetTimeout time in ms a reset may take before the connection is destroyed
     */
    constructor(
        private readonly _pool: string,
        private readonly _database: string,
        private readonly _resetTimeout: number
    ) {}

    /**
     * The app takes the connection. The pool sees neither the USE nor the transaction it may
     * send, so the next statement of the pool on it gets a reset and a USE first
     */
    public lend(connection: object): void {
        this._sessions.set(connection, { database: undefined, dirty: true });
    }

    /**
     * Get a connection ready for a statement on `database`: a reset when it is dirty, then
     * USE when it is on another database. Calls back with nothing when the statement can go,
     * at once when nothing has to be sent. An error means the statement was not sent: a
     * reset that failed or ran out of time has destroyed the connection by then, and a USE
     * that failed left it dirty
     * @param database left out or empty: the one of the pool, as the change of user of 4.x
     * took it
     * @param timeout timeout of the USE, the one of the query. 0 means none
     */
    public prepare(
        connection: mysql.PoolConnection, database: string | undefined, timeout: number,
        done: (error?: any) => void
    ): void {
        const session = this._session(connection);
        database = database || this._database;
        const use = () => {
            if (session.database === database) return done();
            const sql = 'USE ' + mysql.escapeId(database);
            connection.query({ sql, timeout }, (error) => {
                this.observe(connection, error);
                if (!error) session.database = database;
                done(error);
            });
        };
        if (!session.dirty) return use();
        this._reset(connection, session, error => error ? done(error) : use());
    }

    /**
     * Apply the dirty rule to the reply of a statement. The connection is dirty after an error
     * reply, since an error reply carries no status flags, or after a header with a
     * transaction open or autocommit off. Every header of a reply of many results counts. A
     * reply of rows only has no header, and cannot open a transaction while autocommit is on.
     * A header that says the session state changed makes the database of the connection
     * unknown, so the next statement sends USE first
     * @param error the error the statement failed with
     * @param result the reply of mysql2
     */
    public observe(connection: object, error?: unknown, result?: unknown): void {
        const flags = SessionState._flags(result);
        const dirty = !!error ||
            flags.some(status => (status & IN_TRANSACTION) !== 0 || (status & AUTOCOMMIT) === 0);
        // A statement of the app can change the database itself: a USE it sends through
        // query(), or one in a multi-statement. The header tells only through session
        // tracking, which mysql2 asks for and MySQL 8 has on by default. Without it such a
        // USE goes unseen
        const changed = flags.some(status => (status & SESSION_STATE_CHANGED) !== 0);
        if (!dirty && !changed) return;
        const session = this._session(connection);
        if (dirty) session.dirty = true;
        if (changed) session.database = undefined;
    }

    /**
     * Give a connection back to the pool. A clean one goes back at once. A dirty one is reset
     * first and goes back clean, and one whose reset fails or runs out of time is destroyed.
     * A connection a failed reset destroyed already is left alone
     * @param broken the socket is dead or still runs a statement: destroyed, never reset
     */
    public release(connection: mysql.PoolConnection, broken = false): void {
        const session = this._sessions.get(connection);
        if (session?.dropped) return;
        if (broken) return connection.destroy();
        if (!session?.dirty) return connection.release();
        this._reset(connection, session, error => {
            if (!error) return connection.release();
            Logger.warn("Pool " + this._pool + ": the reset of a connection before its release " +
                "failed, the connection was closed", { pool: this._pool, code: error?.code });
        });
    }

    /**
     * What the pool knows of the session of a connection. A connection it sees for the first
     * time is on the database it logged in with, and clean
     * @private
     */
    private _session(connection: object): ISession {
        let session = this._sessions.get(connection);
        if (!session) {
            session = { database: this._database, dirty: false };
            this._sessions.set(connection, session);
        }
        return session;
    }

    /**
     * Reset a connection, within resetTimeout: mysql2 has no time limit for a reset, and a
     * Galera node outside the primary component never answers one. After a reset the session
     * is clean and on the same database. One that fails or runs out of time destroys the
     * connection with its socket
     * @private
     */
    private _reset(
        connection: mysql.PoolConnection, session: ISession, done: (error?: any) => void
    ): void {
        let finished = false;
        const finish = (error?: any) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (error) {
                session.dropped = true;
                drop(connection);
            } else {
                session.dirty = false;
            }
            done(error);
        };
        const timer = setTimeout(() => {
            // the code is the one mysql2 has for a timeout, so the connection counts as broken
            const error = PoolStatus.ownError(new Error("Reset timeout"));
            finish(Object.assign(error, { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }));
        }, this._resetTimeout);
        // the socket keeps the process alive while the reset runs. This timer alone does not
        timer.unref();
        connection.reset(error => finish(error ?? undefined));
    }

    /**
     * The status flags of every header of a reply. Rows have none, and neither has the header
     * of a server that sends no flags
     * @private
     */
    private static _flags(result: unknown): number[] {
        const parts = Array.isArray(result) ? result : [result];
        return parts
            // a header is an object of mysql2's class, as its typings say. A row is not, also
            // when it has a column named serverStatus
            .filter(part => part?.constructor?.name === 'ResultSetHeader')
            .map(part => part.serverStatus)
            .filter((status): status is number => typeof status === 'number');
    }
}
