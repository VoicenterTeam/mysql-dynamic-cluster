import mysql from "mysql2";
import { drop, logOut } from "./ServerFlags";
import Logger from "../utils/Logger";

/**
 * The connection the health check of a node with a healthCheck block asks on: one per
 * node, next to the pool of the app and never part of it. A check asks here, so it never
 * waits in the queue of a pool that is at its limit, and it takes no connection away
 * from the app. The connection is opened by the first query and kept between the checks.
 * One that broke is dropped, and the next query opens a new one
 */
export class CheckConnection {
    // the connection, and its login: resolved with the connection once the server took it.
    // `open` from then on
    private _held?: { connection: any, ready: Promise<any>, open: boolean };
    // The connection that was held when a check opened a new one beside it. Put aside
    // until the new one logged in or failed. See queryOnNew()
    private _kept?: { connection: any, ready: Promise<any>, open: boolean };
    private _closed: boolean = false;
    // The connection a second connect() put in the place of this one, when no disconnect()
    // came in between. See close()
    private _replacedBy?: CheckConnection;
    public get replacedBy(): CheckConnection | undefined {
        return this._replacedBy;
    }
    private readonly _options: object;
    private readonly _database: string;
    private readonly _name: string;

    /**
     * @param options what mysql2 opens the connection with: those of the pool of the node
     * @param database the database of the node, for the change of user ahead of a query
     * @param name the name of the pool of the node, for the log
     */
    constructor(options: object, database: string, name: string) {
        this._options = options;
        this._database = database;
        this._name = name;
    }

    /**
     * Whether a connection is held right now: open, or logging in. Only a connection that
     * was held before a check started can be one the path to the node forgot
     */
    public get held(): boolean {
        return !!this._held;
    }

    /**
     * Whether the connection that is held logged in. One that is still logging in is not
     */
    public get open(): boolean {
        return !!this._held?.open;
    }

    /**
     * Send one query, on the connection that is held or on a new one. As every query of
     * the package it changes the user first, which is a login: a server that refuses the
     * account refuses it on an open connection too. No timeout of mysql2 runs here. The
     * caller has its own timer and calls `asked.drop` when it gives up.
     * Rejects with the error of mysql2 as it is. A login refused on a new connection is
     * not fatal there, one refused at the change of user is
     * @param sql the query
     * @param asked gets `drop`: it drops the connection this query went to, with its
     * socket and the query, and no other. By then another one may be held
     */
    public async query<T>(sql: string, asked: { drop?: () => void } = {}): Promise<T> {
        if (this._closed) throw new Error("the check connection is closed");
        const held = this._held || this._open();
        asked.drop = () => this._drop(held);
        const connection = await held.ready;
        return new Promise<T>((resolve, reject) => {
            const fail = (error: any) => {
                // as the pool does with its own: a broken connection is not used again
                if (error?.fatal) this._drop(held);
                reject(error);
            };
            connection.changeUser({ database: this._database }, (errorU: any) => {
                if (errorU) return fail(errorU);
                connection.query({ sql }, (errorQ: any, result: T) => {
                    return errorQ ? fail(errorQ) : resolve(result);
                });
            });
        });
    }

    /**
     * Send one query on a new connection, while the one that is held stays open beside
     * it: that one answers although no new connection may reach the node. Once the new
     * one logged in it is the connection that is held, and the old one is logged out of.
     * When the new one does not get that far, `keeps` says by its error whether the old
     * one is held again. If not, the old one is logged out of as well.
     * With no connection held, or one that is still logging in, this is query(): that
     * connection is new already, and a second check that asks for a new one shares it
     * @param sql the query
     * @param keeps whether the old connection stays after the new one failed with this
     * @param asked as for query(). While the new one logs in, `drop` logs out of the old
     * one as well: the new one was not there in time
     */
    public async queryOnNew<T>(
        sql: string, keeps: (error: any) => boolean, asked: { drop?: () => void } = {}
    ): Promise<T> {
        if (!this._held?.open) {
            const answer = this.query<T>(sql, asked);
            // the connection query() asks on: one that still logs in, or one it opened
            const handOff = "Pool " + this._name + ": a check asked on a new connection, as " +
                "the node held no open one, and that one ";
            this._held?.ready.then(
                () => Logger.debug(handOff + "logged in",
                    { pool: this._name, newConnection: 'logged_in' }),
                (error: any) => Logger.debug(handOff + "failed",
                    { pool: this._name, newConnection: 'failed', code: error?.code })
            );
            return answer;
        }
        this._kept = this._held;
        const opened = this._open();
        asked.drop = () => {
            this._drop(opened);
            this._settle(false);
        };
        const pool = "Pool " + this._name + ": a check opened a new connection beside the " +
            "one it held, and that one ";
        // the old one is no longer put aside when it broke meanwhile and was dropped, or
        // when the timeout of the check or a close() logged out of it
        const closed = "The old one was closed already";
        try {
            await opened.ready;
        } catch (error) {
            const old = this._kept;
            this._settle(keeps(error));
            const kept = !!old && this._held === old;
            Logger.debug(pool + "failed. " + (!old ? closed
                : kept ? "The old one stays" : "The old one is logged out of as well"),
                { pool: this._name, newConnection: 'failed', code: error?.code, kept });
            throw error;
        }
        // the new one is the connection that is held now
        const old = this._kept;
        this._settle(false);
        Logger.debug(pool + "logged in. " + (old ? "The old one is logged out of" : closed),
            { pool: this._name, newConnection: 'logged_in' });
        return this.query<T>(sql, asked);
    }

    /**
     * Drop the connection that is held, with its socket and whatever was asked on it: no
     * answer comes for that any more. The next query opens a new connection
     */
    public drop(): void {
        this._drop(this._held);
    }

    /**
     * Log out and open no connection again. A query that is out gets its answer first
     * @param replacedBy the connection that takes the place of this one, if any
     */
    public close(replacedBy?: CheckConnection): void {
        this._closed = true;
        this._replacedBy = replacedBy;
        const held = this._held;
        this._held = undefined;
        if (held) logOut(held.connection);
        this._settle(false);
    }

    /**
     * The end of a connection that was put aside: held again, or logged out of. Nothing is
     * held when it is kept: the new one failed, and that dropped it
     */
    private _settle(keep: boolean): void {
        const kept = this._kept;
        this._kept = undefined;
        if (!kept) return;
        if (keep) this._held = kept;
        else logOut(kept.connection);
    }

    private _open() {
        const connection: any = mysql.createConnection(this._options);
        const held = { connection, ready: undefined as Promise<any>, open: false };
        held.ready = new Promise((resolve, reject) => {
            connection.once('connect', () => {
                held.open = true;
                resolve(connection);
            });
            // On, not once, and it stays after the login. mysql2 tells a connection that
            // nobody asks on of its loss with an error event, and an error event without
            // a listener would end the process
            connection.on('error', (error: any) => {
                this._drop(held);
                reject(error);
            });
        });
        this._held = held;
        return held;
    }

    private _drop(held?: { connection: any }) {
        if (!held) return;
        if (this._held === held) this._held = undefined;
        // one that broke while it was put aside is not held again
        if (this._kept === held) this._kept = undefined;
        drop(held.connection);
    }
}
