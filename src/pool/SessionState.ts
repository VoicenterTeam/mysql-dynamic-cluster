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
    // the node answered 1047, not ready: it answers no reset either, so the connection is
    // dropped instead
    notReady?: boolean,
    // a reset failed and destroyed the connection: nothing is done with it any more
    dropped?: boolean,
    // the last header on the connection had NO_BACKSLASH_ESCAPES: the server reads a
    // backslash in a string as a character, so a value escaped into the text is not safe.
    // Unknown after a reset, which counts as off, as for a new connection
    noBackslashEscapes?: boolean,
    // The texts execute() sent on the connection since its last reset or USE, the one used
    // last at the end. mysql2 keeps a prepared statement per text, whatever the database,
    // and the server runs it in the database it was prepared in
    statements?: Set<string>,
    // the database those statements were prepared in
    statementsIn?: string,
    // the replies the connection got since its last reset, see resetAfterStatements
    sinceReset: number
}

// status flags of the header of an OK reply
const IN_TRANSACTION = 1;
const AUTOCOMMIT = 2;
const SESSION_STATE_CHANGED = 0x4000;
const NO_BACKSLASH_ESCAPES = 512;
// the errno of a Galera node that is not ready, outside the primary component
const NOT_READY = 1047;

/**
 * The session of the connections of one pool: which database each is on, and whether it is
 * dirty. The pool sends no change of user. A query for another database sends USE first, and
 * a dirty connection is reset before anyone uses it again. The rule for dirty, the cap on
 * statements between two resets and the reset with its time limit live here and nowhere
 * else, and so does the sql_mode bit a query() with values reads, see noBackslashEscapes()
 */
export class SessionState {
    private readonly _sessions = new WeakMap<object, ISession>();

    /**
     * @param poolName name of the pool, for the log
     * @param database the database mysql2 logs every connection of the pool in with
     * @param resetTimeout time in ms a reset may take before the connection is destroyed
     * @param maxStatements the maxPreparedStatements of the pool: how many texts are kept
     * @param _resetAfterStatements the replies after which a connection counts as dirty, so
     * its release resets it: prepared statements a procedure left on it cannot pile up
     */
    constructor(
        private readonly _poolName: string,
        private readonly _database: string,
        private readonly _resetTimeout: number,
        private readonly _maxStatements: number,
        private readonly _resetAfterStatements: number
    ) {}

    /**
     * The app takes the connection. The pool sees neither the USE nor the transaction it may
     * send, so the next statement of the pool on it gets a reset and a USE first. The
     * statements execute() prepared are closed first: an execute() of the app with the same
     * text would run in the database they were prepared in
     */
    public lend(connection: mysql.PoolConnection): void {
        const session = this._sessions.get(connection);
        if (session) SessionState._closeStatements(connection, session);
        this._sessions.set(connection, { database: undefined, dirty: true, sinceReset: 0 });
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
            // A statement prepared in another database must not run in this one. Back in the
            // one they were prepared in, such as after a header with 0x4000, they stay
            if (session.statementsIn !== database) {
                SessionState._closeStatements(connection, session);
            }
            const sql = 'USE ' + mysql.escapeId(database);
            connection.query({ sql, timeout }, (error, result) => {
                this.observe(connection, error, result);
                if (!error) session.database = database;
                done(error);
            });
        };
        if (!session.dirty) return use();
        this._reset(connection, session, error => error ? done(error) : use());
    }

    /**
     * execute() is about to send this text on the connection. The texts are closed before the
     * next USE, see prepare(). Past maxPreparedStatements the one used longest ago is closed
     * at once, so mysql2 never keeps a statement this list lost
     * @param sql the text of the statement
     */
    public executed(connection: mysql.PoolConnection, sql: string): void {
        const session = this._session(connection);
        const texts = session.statements ??= new Set<string>();
        // prepare() just made it the database of the session
        session.statementsIn = session.database;
        // to the end: the order is the one of the last use, as in the cache of mysql2
        texts.delete(sql);
        texts.add(sql);
        if (texts.size <= this._maxStatements) return;
        const oldest = texts.values().next().value as string;
        texts.delete(oldest);
        SessionState._unprepare(connection, oldest);
    }

    /**
     * Apply the rules to the reply of a statement. The connection is dirty after an error
     * reply, since an error reply carries no status flags, or after a header with a
     * transaction open or autocommit off. Every header of a reply of many results counts. A
     * reply of rows only has no header, and cannot open a transaction while autocommit is on.
     * The rule for the database applies too, see observeDatabase(). The last header of the
     * reply sets noBackslashEscapes, or clears it. A reply without a header leaves it
     * @param error the error the statement failed with
     * @param result the reply of mysql2
     */
    public observe(connection: object, error?: unknown, result?: unknown): void {
        this.observeDatabase(connection, result);
        const flags = SessionState._flags(result);
        if (flags.length > 0) {
            const last = flags[flags.length - 1];
            this._session(connection).noBackslashEscapes = (last & NO_BACKSLASH_ESCAPES) !== 0;
        }
        const dirty = !!error || flags.some(status => {
            return (status & IN_TRANSACTION) !== 0 || (status & AUTOCOMMIT) === 0;
        });
        if (!dirty) return;
        const session = this._session(connection);
        session.dirty = true;
        if ((error as { errno?: unknown })?.errno === NOT_READY) session.notReady = true;
    }

    /**
     * The rule for the database alone: a header that says the session state changed makes
     * the database of the connection unknown, so the next statement sends USE first. Inside a
     * transaction of multiStatementQuery() only this rule applies, since every header there
     * says a transaction is open. Every reply counts toward resetAfterStatements: the reply
     * that reaches it makes the connection dirty
     * @param result the reply of mysql2
     */
    public observeDatabase(connection: object, result?: unknown): void {
        const session = this._session(connection);
        if (++session.sinceReset >= this._resetAfterStatements) session.dirty = true;
        // A statement of the app can change the database itself: a USE it sends through
        // query(), or one in a multi-statement. The header tells only through session
        // tracking, which mysql2 asks for and MySQL 8 has on by default. Without it such a
        // USE goes unseen
        const flags = SessionState._flags(result);
        if (!flags.some(status => (status & SESSION_STATE_CHANGED) !== 0)) return;
        session.database = undefined;
    }

    /**
     * Whether the last header on the connection had bit 512, NO_BACKSLASH_ESCAPES: the server
     * then reads a backslash in a string as a character, and the escaping of mysql2 does not
     * protect a value written into the text. False before the first header, and after a reset
     * until the next one: mysql2 does not show the header of the reply to a reset
     */
    public noBackslashEscapes(connection: object): boolean {
        return this._sessions.get(connection)?.noBackslashEscapes === true;
    }

    /**
     * Give a connection back to the pool. A clean one goes back at once. A dirty one is reset
     * first and goes back clean, and one whose reset fails or runs out of time is destroyed.
     * One the node answered 1047 on is destroyed with no reset. A connection that was dropped
     * already is left alone. Exactly one of the two callbacks runs, once the release is over
     * @param broken the socket is dead or still runs a statement: destroyed, never reset
     * @param putBack puts the connection into the pool of mysql2. Not connection.release():
     * the one of a lent connection is the app's, see Borrow
     * @param gone the connection was destroyed, or was already
     */
    public release(
        connection: mysql.PoolConnection, broken: boolean, putBack: () => void, gone: () => void
    ): void {
        const session = this._sessions.get(connection);
        if (session?.dropped) return gone();
        if (broken) {
            connection.destroy();
            return gone();
        }
        if (session?.notReady) {
            // the reset would get no answer and hold the slot for resetTimeout, see _reset()
            this.drop(connection);
            return gone();
        }
        if (!session?.dirty) return putBack();
        this._reset(connection, session, error => {
            if (!error) return putBack();
            const pool = this._poolName;
            Logger.warn("Pool " + pool + ": the reset of a connection before its release " +
                "failed, the connection was closed", { pool, code: error?.code });
            gone();
        });
    }

    /**
     * Destroy a connection with its socket. Nothing is done with it any more: a release of it
     * after this does nothing
     * @param error what a command still out on it fails with, see drop() of ServerFlags
     */
    public drop(connection: mysql.PoolConnection, error?: Error): void {
        this._session(connection).dropped = true;
        drop(connection, error);
    }

    /**
     * What the pool knows of the session of a connection. A connection it sees for the first
     * time is on the database it logged in with, and clean
     * @private
     */
    private _session(connection: object): ISession {
        let session = this._sessions.get(connection);
        if (!session) {
            session = { database: this._database, dirty: false, sinceReset: 0 };
            this._sessions.set(connection, session);
        }
        return session;
    }

    /**
     * Reset a connection, within resetTimeout: mysql2 has no time limit for a reset, and a
     * Galera node outside the primary component never answers one, also 8 s after it is
     * Primary again (measured in #93). After a reset the session is clean and on the same
     * database, and its sql_mode is the one of the server, which counts as no
     * NO_BACKSLASH_ESCAPES. One that fails or runs out of time destroys the connection with
     * its socket
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
            // dropped while the reset ran, by packets out of order: mysql2 warns, then still
            // runs the reset on that packet and reports it answered. It failed all the same
            if (!error && session.dropped) error = new Error("Dropped during the reset");
            if (error) {
                this.drop(connection);
            } else {
                session.dirty = false;
                session.sinceReset = 0;
                session.noBackslashEscapes = false;
                // mysql2 forgot its statements when the reset was answered, the server too
                session.statements?.clear();
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
        try {
            connection.reset(error => finish(error ?? undefined));
        } catch (thrown) {
            // a reset that could not be sent fails here, so no call waits for it
            finish(thrown || new Error("Reset failed"));
        }
    }

    /**
     * Close every statement execute() prepared on the connection, and forget the texts
     * @private
     */
    private static _closeStatements(connection: mysql.PoolConnection, session: ISession): void {
        session.statements?.forEach(text => SessionState._unprepare(connection, text));
        session.statements?.clear();
    }

    /**
     * Close the statement mysql2 keeps for a text: COM_STMT_CLOSE, which gets no reply. It
     * does nothing when mysql2 keeps none. A connection that takes no command any more makes
     * mysql2 emit an error with no listener here, which throws: the USE or the statement that
     * follows fails the same way, and fails the call
     * @private
     */
    private static _unprepare(connection: mysql.PoolConnection, sql: string): void {
        try {
            connection.unprepare(sql);
        } catch {
            // see above
        }
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
