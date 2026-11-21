import { drop } from './ServerFlags';

// The ping of the idle connections. Only a node with a healthCheck block has one
export interface IIdlePing {
    // time in ms a ping may take before its connection is closed
    timeout: number,
    // called once per connection a ping took out of the pool, with the error of that ping
    removed: (error: any) => void
}

export class IdleConnectionReaper {
    private readonly _minConnections: number;
    private readonly _idleTimeout: number;
    private readonly _idleCheckInterval: number;
    private readonly _ping?: IIdlePing;
    private _pool: { _freeConnections: { length: number } } | null = null;
    private _timer: ReturnType<typeof setInterval> | null = null;
    private _idleConnections: Map<any, number> = new Map();
    // the pings that are out: the idle connection, and the timer that ends its ping
    private _pings: Map<any, ReturnType<typeof setTimeout>> = new Map();

    /**
     * @param ping when given, every idle connection the age rule keeps gets a ping at each
     * tick, and one whose ping fails or is not answered in time is closed
     */
    constructor(
        minConnections: number, idleTimeout: number, idleCheckInterval: number, ping?: IIdlePing
    ) {
        this._minConnections = minConnections;
        this._idleTimeout = idleTimeout;
        this._idleCheckInterval = idleCheckInterval;
        this._ping = IdleConnectionReaper._checked(ping);
    }

    start(pool: { _freeConnections: { length: number } }): void {
        // a connect() without a disconnect() starts again: its timer takes the place of
        // the one before, which would keep the process alive after a disconnect()
        if (this._timer !== null) clearInterval(this._timer);
        this._pool = pool;
        this._timer = setInterval(() => {
            this._tick();
            if (this._ping) this._pingIdle(this._ping);
        }, this._idleCheckInterval);
    }

    stop(): void {
        if (this._timer !== null) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._idleConnections.clear();
        // a ping that is still out decides nothing any more, and leaves no timer
        this._pings.forEach(timer => clearTimeout(timer));
        this._pings.clear();
    }

    onRelease(connection: any): void {
        this._idleConnections.set(connection, Date.now());
    }

    onAcquire(connection: any): void {
        this._idleConnections.delete(connection);
        // The app has the connection now, and a ping that is out on it is the app's to
        // wait for: mysql2 sends what the app asks after the ping, and fails it with the
        // error of the ping when the connection is lost. The reaper closes no connection
        // the app holds
        clearTimeout(this._pings.get(connection));
        this._pings.delete(connection);
    }

    private _tick(): void {
        if (!this._pool) return;

        let freeCount: number;
        try {
            freeCount = this._pool._freeConnections.length;
        } catch {
            return; // degrade gracefully if mysql2 changes private API
        }

        const now = Date.now();
        for (const [connection, releasedAt] of this._idleConnections) {
            if (freeCount <= this._minConnections) break;
            if (now - releasedAt > this._idleTimeout) {
                try {
                    connection.destroy();
                } catch {
                    // ignore errors from already-dead connections
                }
                this._idleConnections.delete(connection);
                freeCount--;
            }
        }
    }

    /**
     * Ping every idle connection the age rule kept, each where it is: it stays in the
     * pool, shows as idle and can be drawn. The bytes keep a path with an idle timeout
     * from forgetting the connection. A ping that fails, or has no answer after
     * `ping.timeout`, closes its connection with the socket, unless the app drew the
     * connection or stop() ran in between
     */
    private _pingIdle(ping: IIdlePing): void {
        for (const connection of this._idleConnections.keys()) {
            // one ping at a time per connection: the limit of a ping may be longer than a tick
            if (this._pings.has(connection)) continue;

            const ended = (error?: any) => {
                // the app drew the connection, or stop() ran: this ping decides nothing
                if (this._pings.get(connection) !== timer) return;
                clearTimeout(timer);
                this._pings.delete(connection);
                if (!error) return;
                this._idleConnections.delete(connection);
                try {
                    drop(connection);
                } catch {
                    // ignore errors from already-dead connections
                }
                ping.removed(error);
            };
            // the code is the one mysql2 has for a timeout, but this timer is the package's own
            const timer = setTimeout(() => ended(Object.assign(
                new Error("Ping timeout"), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }
            )), ping.timeout);
            this._pings.set(connection, timer);
            try {
                connection.ping(ended);
            } catch (thrown) {
                ended(thrown);
            }
        }
    }

    private static _checked(ping?: IIdlePing): IIdlePing | undefined {
        if (ping === undefined) return undefined;
        if (ping === null || typeof ping !== 'object') {
            throw new TypeError("IdleConnectionReaper: ping must be an object or left out");
        }
        if (typeof ping.timeout !== 'number' || !(ping.timeout > 0) || !isFinite(ping.timeout)) {
            throw new TypeError("IdleConnectionReaper: ping.timeout must be a number above 0");
        }
        if (typeof ping.removed !== 'function') {
            throw new TypeError("IdleConnectionReaper: ping.removed must be a function");
        }
        return ping;
    }
}
