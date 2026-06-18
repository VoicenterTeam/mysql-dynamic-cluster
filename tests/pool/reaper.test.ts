import { IdleConnectionReaper } from '../../src/pool/IdleConnectionReaper';

const makeConn = () => ({ destroy: jest.fn() });

describe('IdleConnectionReaper', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('destroys a connection idle longer than idleTimeout when above minConnections', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const conn = makeConn();
        // 2 free connections, floor is 1 — reaper can evict 1
        const pool = { _freeConnections: { get length() { return 2; } } };
        reaper.start(pool as any);
        reaper.onRelease(conn);

        // With idleCheckInterval=10_000 and idleTimeout=30_000, the reaper fires at
        // t=10k, 20k, 30k (elapsed not > 30k), then t=40k (40k > 30k → evict).
        jest.advanceTimersByTime(40_001);

        expect(conn.destroy).toHaveBeenCalledTimes(1);
    });

    it('does not destroy when free count equals minConnections floor', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const conn = makeConn();
        // 1 free connection, floor is 1 — cannot evict
        const pool = { _freeConnections: { get length() { return 1; } } };
        reaper.start(pool as any);
        reaper.onRelease(conn);

        jest.advanceTimersByTime(30_001);

        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('does not destroy connections younger than idleTimeout', () => {
        const reaper = new IdleConnectionReaper(0, 30_000, 10_000);
        const conn = makeConn();
        const pool = { _freeConnections: { length: 1 } };
        reaper.start(pool as any);
        reaper.onRelease(conn);

        jest.advanceTimersByTime(29_999);

        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('does not destroy a connection that was re-acquired after release', () => {
        const reaper = new IdleConnectionReaper(0, 30_000, 10_000);
        const conn = makeConn();
        const pool = { _freeConnections: { length: 0 } };
        reaper.start(pool as any);
        reaper.onRelease(conn);
        reaper.onAcquire(conn); // back in use before tick fires

        jest.advanceTimersByTime(30_001);

        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('stops evicting after stop() is called', () => {
        const reaper = new IdleConnectionReaper(0, 30_000, 10_000);
        const conn = makeConn();
        const pool = { _freeConnections: { length: 1 } };
        reaper.start(pool as any);
        reaper.onRelease(conn);
        reaper.stop();

        jest.advanceTimersByTime(30_001);

        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('degrades gracefully when _freeConnections is inaccessible', () => {
        const reaper = new IdleConnectionReaper(0, 30_000, 10_000);
        const conn = makeConn();
        const pool = { get _freeConnections(): any { throw new Error('gone'); } };
        reaper.start(pool as any);
        reaper.onRelease(conn);

        expect(() => jest.advanceTimersByTime(30_001)).not.toThrow();
        expect(conn.destroy).not.toHaveBeenCalled();
    });
});
