export class IdleConnectionReaper {
    private readonly _minConnections: number;
    private readonly _idleTimeout: number;
    private readonly _idleCheckInterval: number;
    private _pool: { _freeConnections: { length: number } } | null = null;
    private _timer: ReturnType<typeof setInterval> | null = null;
    private _idleConnections: Map<any, number> = new Map();

    constructor(minConnections: number, idleTimeout: number, idleCheckInterval: number) {
        this._minConnections = minConnections;
        this._idleTimeout = idleTimeout;
        this._idleCheckInterval = idleCheckInterval;
    }

    start(pool: { _freeConnections: { length: number } }): void {
        this._pool = pool;
        this._timer = setInterval(() => this._tick(), this._idleCheckInterval);
    }

    stop(): void {
        if (this._timer !== null) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._idleConnections.clear();
    }

    onRelease(connection: any): void {
        this._idleConnections.set(connection, Date.now());
    }

    onAcquire(connection: any): void {
        this._idleConnections.delete(connection);
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
}
