import { IdleConnectionReaper } from '../../src/pool/IdleConnectionReaper';

// What the reaper forgets: a connection the age rule closed while its ping was out, and a
// connection mysql2 took out of its free list by itself. The fakes of idle-ping.test.ts.
// The clock is fake, and no socket opens
const makeConn = () => {
    const connection = {
        destroy: jest.fn(), stream: { destroy: jest.fn() },
        ping: jest.fn(),
        // answer the ping that was sent last
        answer: (error?: any) => {
            connection.ping.mock.calls[connection.ping.mock.calls.length - 1][0](error);
        }
    };
    return connection;
};
// A mysql2 pool with its free list: the length, and one entry at a time through get(), as
// the queue of mysql2 has them. The test takes a connection out as mysql2 does when the
// server closed it
const freeList = (connections: object[]) => ({
    _freeConnections: {
        get length() { return connections.length; },
        get: (index: number) => connections[index]
    }
});
const lost = () => Object.assign(new Error('read ECONNRESET'),
    { code: 'ECONNRESET', errno: -104, syscall: 'read', fatal: true });
// the connections the reaper takes for idle
const known = (reaper: IdleConnectionReaper): number => (reaper as any)._idleConnections.size;
const pings = (conns: { ping: jest.Mock }[]) => conns.map(conn => conn.ping.mock.calls.length);
const destroys = (conns: { destroy: jest.Mock }[]) => conns.map(conn => conn.destroy.mock.calls.length);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('a connection the age rule closes while its ping is out', () => {
    // [idleCheckInterval, idleTimeout, timeout of the ping, when the ping goes out, when the
    // age rule closes the connection]. Below 100 ms the ping waits 100 and the age rule
    // runs at its own pace. With the same wait a ping whose timeout is longer than a tick is
    // still out at the next one
    const cases: [string, number, number, number, number, number][] = [
        ['an idleCheckInterval below 100', 50, 120, 1000, 100, 150],
        ['the same wait and a ping timeout longer than a tick', 10_000, 25_000, 30_000, 10_000, 30_000]
    ];

    it.each(cases)('with %s: no line of a failed ping at its timeout',
        (_name, interval, idle, limit, pingAt, closeAt) => {
            const removed = jest.fn();
            const reaper = new IdleConnectionReaper(0, idle, interval, { timeout: limit, removed });
            const conn = makeConn();
            reaper.start(freeList([conn]) as any);
            reaper.onRelease(conn);

            jest.advanceTimersByTime(pingAt);
            const pinged = pings([conn]);
            jest.advanceTimersByTime(closeAt - pingAt);
            const closed = destroys([conn]);
            jest.advanceTimersByTime(limit);

            expect([pinged, closed, removed.mock.calls.length]).toEqual([[1], [1], 0]);
            expect([destroys([conn]), known(reaper)]).toEqual([[1], 0]);
            reaper.stop();
        });

    it.each(cases)('with %s: no line of a failed ping when mysql2 fails the ping after it',
        (_name, interval, idle, limit, _pingAt, closeAt) => {
            const removed = jest.fn();
            const reaper = new IdleConnectionReaper(0, idle, interval, { timeout: limit, removed });
            const conn = makeConn();
            reaper.start(freeList([conn]) as any);
            reaper.onRelease(conn);

            jest.advanceTimersByTime(closeAt);
            conn.answer(lost());

            expect([removed.mock.calls.length, destroys([conn])]).toEqual([0, [1]]);
            expect(jest.getTimerCount()).toBe(2);
            reaper.stop();
        });
});

describe('a connection mysql2 took out of its free list by itself, on a node without the ping', () => {
    it('is forgotten at the next tick, also when the pool is at minConnections', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const conns = [makeConn(), makeConn()];
        const free = [...conns];
        reaper.start(freeList(free) as any);
        conns.forEach(conn => reaper.onRelease(conn));

        // the server closed both, and mysql2 took them out of its lists
        free.splice(0);
        jest.advanceTimersByTime(10_000);

        expect([known(reaper), destroys(conns)]).toEqual([0, [0, 0]]);
        reaper.stop();
    });

    it('forgets only those: one mysql2 still holds stays known', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const [gone, kept] = [makeConn(), makeConn()];
        const free = [gone, kept];
        reaper.start(freeList(free) as any);
        [gone, kept].forEach(conn => reaper.onRelease(conn));

        free.splice(0, 1);
        jest.advanceTimersByTime(10_000);

        expect(known(reaper)).toBe(1);
        reaper.onAcquire(kept);
        expect(known(reaper)).toBe(0);
        reaper.stop();
    });

    // the next ping fails on such a connection and forgets it, with its debug line
    it('a reaper with a ping leaves it to the ping', () => {
        const removed = jest.fn();
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000, { timeout: 5_000, removed });
        const conn = makeConn();
        const free = [conn];
        reaper.start(freeList(free) as any);
        reaper.onRelease(conn);

        free.splice(0);
        jest.advanceTimersByTime(10_000);
        const pinged = pings([conn]);
        conn.answer(lost());

        expect([pinged, removed.mock.calls.length, known(reaper)]).toEqual([[1], 1, 0]);
        reaper.stop();
    });

    it('a free list that has no get() is not read entry by entry: nothing is forgotten', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const conns = [makeConn(), makeConn()];
        reaper.start({ _freeConnections: { length: 0 } } as any);
        conns.forEach(conn => reaper.onRelease(conn));

        jest.advanceTimersByTime(10_000);

        expect(known(reaper)).toBe(2);
        reaper.stop();
    });
});
