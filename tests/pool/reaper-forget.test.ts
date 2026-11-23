import { IdleConnectionReaper } from '../../src/pool/IdleConnectionReaper';

// What the reaper forgets: a connection the age rule closed while its ping was out, and a
// connection mysql2 took out of its free list by itself. The fakes of idle-ping.test.ts,
// with the pool mysql2 keeps on a connection: an object while the connection is in a pool.
// The clock is fake, and no socket opens
const makeConn = () => {
    const connection = {
        _pool: {} as object | null,
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
// the queue of mysql2 has them
const freeList = (connections: object[]) => ({
    _freeConnections: {
        get length() { return connections.length; },
        get: (index: number) => connections[index]
    }
});
// what mysql2 does when the server closed an idle connection: it takes the connection out
// of its free list and out of its pool, whose place on the connection it sets to null
const closedByMysql2 = (conn: any, free: object[]) => {
    free.splice(free.indexOf(conn), 1);
    conn._pool = null;
};
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
    // dropped as well: harmless for a connection mysql2 closed already
    it('is forgotten and dropped at the next tick, also when the pool is at minConnections', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const conns = [makeConn(), makeConn()];
        const free = [...conns];
        reaper.start(freeList(free) as any);
        conns.forEach(conn => reaper.onRelease(conn));

        conns.forEach(conn => closedByMysql2(conn, free));
        jest.advanceTimersByTime(10_000);

        expect([known(reaper), destroys(conns)]).toEqual([0, [1, 1]]);
        reaper.stop();
    });

    it('forgets only those: one mysql2 still holds stays known', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const [gone, kept] = [makeConn(), makeConn()];
        const free = [gone, kept];
        reaper.start(freeList(free) as any);
        [gone, kept].forEach(conn => reaper.onRelease(conn));

        closedByMysql2(gone, free);
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

        closedByMysql2(conn, free);
        jest.advanceTimersByTime(10_000);
        const pinged = pings([conn]);
        conn.answer(lost());

        expect([pinged, removed.mock.calls.length, known(reaper)]).toEqual([[1], 1, 0]);
        reaper.stop();
    });

    // An idle connection of the mysql2 pool of an earlier start(), as after a second
    // connect(), is in neither free list and still open. It is left to the age rule, as
    // before 4.1.1, which closes it and keeps minConnections of the pool of this start()
    it('one of another mysql2 pool is still open: the age rule closes it, as before', () => {
        const reaper = new IdleConnectionReaper(1, 30_000, 10_000);
        const [a1, a2] = [makeConn(), makeConn()];
        reaper.start(freeList([a1, a2]) as any);
        [a1, a2].forEach(conn => reaper.onRelease(conn));
        const [b1, b2, b3] = [makeConn(), makeConn(), makeConn()];
        reaper.start(freeList([b1, b2, b3]) as any);
        [b1, b2, b3].forEach(conn => reaper.onRelease(conn));

        jest.advanceTimersByTime(10_000);
        const atFirstTick = [known(reaper), destroys([a1, a2])];
        jest.advanceTimersByTime(30_000);

        expect(atFirstTick).toEqual([5, [0, 0]]);
        expect([destroys([a1, a2]), destroys([b1, b2, b3]), known(reaper)])
            .toEqual([[1, 1], [0, 0, 0], 3]);
        reaper.stop();
    });

    it('a free list whose get() throws: nothing is forgotten, and the age rule goes on', () => {
        const reaper = new IdleConnectionReaper(0, 30_000, 10_000);
        const conns = [makeConn(), makeConn()];
        reaper.start({
            _freeConnections: { length: 2, get: () => { throw new Error('unreadable'); } }
        } as any);
        conns.forEach(conn => reaper.onRelease(conn));

        jest.advanceTimersByTime(10_000);
        const atFirstTick = known(reaper);
        jest.advanceTimersByTime(30_000);

        expect([atFirstTick, destroys(conns), known(reaper)]).toEqual([2, [1, 1], 0]);
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
