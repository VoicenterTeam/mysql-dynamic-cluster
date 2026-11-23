import { drop } from './ServerFlags';
import { timeoutError } from '../utils/Abort';

// The ping of the idle connections. Only a node with a healthCheck block has one
export interface IIdlePing {
    // time in ms a ping may take before its connection is closed
    timeout: number,
    // called once per connection a ping took out of the pool, with the error of that ping
    removed: (error: any) => void
}

// What the reaper knew of a connection when the pool drew it, see drawn()
export interface IDrawn {
    // when the connection was last seen alive: its release into the pool, or the last ping of
    // the reaper it answered since. Unknown for a connection that was never idle in the pool
    aliveAt?: number,
    // the ping of the reaper that was still out on it: calls back once with its answer
    ping?: (answered: (error?: any) => void) => void
}

// A ping of the reaper that is out on a connection
interface IPingOut {
    // ends the ping while the connection is idle, see _pingIdle()
    timer: ReturnType<typeof setTimeout>,
    // the pool drew the connection and waits for the answer, see drawn()
    waiting?: (error?: any) => void,
    // the answer came: with the error of the ping, or with nothing
    answer?: { error?: any }
}

// A ping is never paced below this, whatever idleCheckInterval is
const PING_PACE_MIN = 100;
// The longest wait a timer of Node takes. A longer one, as one below 1 ms, runs after 1 ms
const TIMER_MAX = 2147483647;

// The free list of mysql2: its length, and its entries one at a time where get() reads them,
// as the queue of mysql2 3 does
interface IFreeList {
    length: number,
    get?: (index: number) => any
}

export class IdleConnectionReaper {
    private readonly _minConnections: number;
    private readonly _idleTimeout: number;
    private readonly _idleCheckInterval: number;
    private readonly _ping?: IIdlePing;
    private _pool: { _freeConnections: IFreeList } | null = null;
    private _timer: ReturnType<typeof setInterval> | null = null;
    // the timer of the ping, apart from that of the age rule: see _pingPace()
    private _pingTimer: ReturnType<typeof setInterval> | null = null;
    private _idleConnections: Map<any, number> = new Map();
    // the pings that are out on idle connections
    private _pings: Map<any, IPingOut> = new Map();
    // when each connection last answered a ping
    private _answered = new WeakMap<object, number>();
    // what onAcquire() knew of each connection the pool drew, until drawn() takes it
    private _drawn = new WeakMap<object, IDrawn>();

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

    start(pool: { _freeConnections: IFreeList }): void {
        // a connect() without a disconnect() starts again: its timer takes the place of
        // the one before, which would keep the process alive after a disconnect()
        if (this._timer !== null) clearInterval(this._timer);
        if (this._pingTimer !== null) clearInterval(this._pingTimer);
        this._pool = pool;
        this._timer = setInterval(() => this._tick(), this._idleCheckInterval);
        // Started after the timer of the age rule, so where the two have the same wait the
        // age rule runs first at a tick they share. With idleCheckInterval below 100 ms
        // they do not, see _pingPace()
        const ping = this._ping;
        if (ping) this._pingTimer = setInterval(() => this._pingIdle(ping), this._pingPace());
    }

    /**
     * The wait between two rounds of pings: idleCheckInterval, but never below 100 ms and
     * never above the longest wait a timer takes. Node runs a timer with a wait below 1 ms
     * or above that limit every millisecond. For the age rule that is a walk over a map,
     * and it is left as it was. A ping is a round trip to the server per idle connection
     */
    private _pingPace(): number {
        // also for a wait that is no number
        if (!(this._idleCheckInterval >= PING_PACE_MIN)) return PING_PACE_MIN;
        return Math.min(this._idleCheckInterval, TIMER_MAX);
    }

    stop(): void {
        if (this._timer !== null) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._pingTimer !== null) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        this._idleConnections.clear();
        // A ping that is still out decides nothing any more, and leaves no timer. Its
        // connection is closed with the socket: mysql2 queued the logout of disconnect()
        // behind the ping, and would wait there for an answer that may never come
        const out = [...this._pings];
        this._pings.clear();
        for (const [connection, { timer }] of out) {
            clearTimeout(timer);
            try {
                drop(connection);
            } catch {
                // ignore errors from already-dead connections
            }
        }
    }

    onRelease(connection: any): void {
        this._idleConnections.set(connection, Date.now());
    }

    onAcquire(connection: any): void {
        const releasedAt = this._idleConnections.get(connection);
        this._idleConnections.delete(connection);
        // The pool has the connection now, and a ping that is out on it is the pool's to
        // wait for, see drawn(). mysql2 sends what comes next after the ping, and fails it
        // with the error of the ping when the connection is lost. The reaper closes no
        // connection the pool lent
        const out = this._pings.get(connection);
        if (out) clearTimeout(out.timer);
        this._pings.delete(connection);
        const answeredAt = this._answered.get(connection);
        const aliveAt = releasedAt === undefined ? undefined
            : Math.max(releasedAt, answeredAt ?? releasedAt);
        this._drawn.set(connection, {
            aliveAt,
            ping: out && (answered => IdleConnectionReaper._wait(out, answered))
        });
    }

    /**
     * What the reaper knew of a connection when the pool drew it from its idle ones: since
     * when it is known to be alive, and the ping that was still out on it. Undefined for a
     * connection mysql2 handed on without drawing it, as it does from one caller to the next
     * that waits. Each draw is told once: a second call returns undefined
     */
    drawn(connection: object): IDrawn | undefined {
        const drawn = this._drawn.get(connection);
        this._drawn.delete(connection);
        return drawn;
    }

    // call back with the answer of a ping, at once when it came already
    private static _wait(out: IPingOut, answered: (error?: any) => void): void {
        if (out.answer) return answered(out.answer.error);
        out.waiting = answered;
    }

    private _tick(): void {
        if (!this._pool) return;

        let freeCount: number;
        try {
            freeCount = this._pool._freeConnections.length;
        } catch {
            return; // degrade gracefully if mysql2 changes private API
        }

        // The connections in the free list, read one at a time where it can be. Not for a
        // node with the ping, see below. A list that cannot be read so leaves the age rule
        // as it is
        let free: Set<any> | undefined;
        if (!this._ping) {
            try {
                const list = this._pool._freeConnections;
                if (typeof list.get === 'function') {
                    free = new Set();
                    for (let index = 0; index < freeCount; index++) free.add(list.get(index));
                }
            } catch {
                free = undefined;
            }
        }

        // A connection mysql2 took out of its free list and its pool by itself, as after
        // the server closed it, is forgotten. The age rule stops at minConnections and would
        // keep it. It is dropped as well, which does nothing to one that is closed already.
        // One that is in another mysql2 pool, as after a second connect(), is still open and
        // is left to the age rule. With the ping, the next ping fails on a closed one and
        // forgets it with its debug line
        if (free) {
            for (const connection of this._idleConnections.keys()) {
                // mysql2 sets the pool of a connection to null when it takes it out
                if (free.has(connection) || connection._pool !== null) continue;
                this._forget(connection);
                try {
                    drop(connection);
                } catch {
                    // ignore errors from already-dead connections
                }
            }
        }

        const now = Date.now();
        for (const [connection, releasedAt] of this._idleConnections) {
            if (freeCount <= this._minConnections) break;
            if (now - releasedAt > this._idleTimeout) {
                // first, so a ping that is out on it decides nothing and logs nothing
                this._forget(connection);
                try {
                    drop(connection);
                } catch {
                    // ignore errors from already-dead connections
                }
                freeCount--;
            }
        }
    }

    /**
     * Forget an idle connection, and end the ping that is out on it: its answer and its
     * timeout decide nothing any more
     */
    private _forget(connection: any): void {
        this._idleConnections.delete(connection);
        const out = this._pings.get(connection);
        if (out) clearTimeout(out.timer);
        this._pings.delete(connection);
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
                // the pool drew the connection, or stop() ran: this ping decides nothing
                if (this._pings.get(connection) !== out) return;
                clearTimeout(out.timer);
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
            const out: IPingOut = {
                timer: setTimeout(() => ended(timeoutError("Ping timeout")), ping.timeout)
            };
            // the answer of mysql2: seen alive, and told to the pool when it drew the connection
            const answered = (error?: any) => {
                if (!error) this._answered.set(connection, Date.now());
                out.answer = { error };
                out.waiting?.(error);
                ended(error);
            };
            this._pings.set(connection, out);
            try {
                connection.ping((error: any) => answered(error ?? undefined));
            } catch (thrown) {
                answered(thrown);
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
