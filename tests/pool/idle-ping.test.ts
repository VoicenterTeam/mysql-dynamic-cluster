jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: {
        recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn(),
        recordHealthCheck: jest.fn()
    }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));
// A mysql2 that opens nothing. Its pool is an emitter with the three lists of mysql2, which
// a test fills by hand, and every connection it creates is one the test drives by hand
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => {
            const { EventEmitter } = jest.requireActual('events');
            return Object.assign(new EventEmitter(), {
                end: jest.fn(), getConnection: jest.fn(),
                _allConnections: [], _freeConnections: [], _connectionQueue: []
            });
        }),
        createConnection: jest.fn(() => {
            const { EventEmitter } = jest.requireActual('events');
            return Object.assign(new EventEmitter(), {
                changeUser: jest.fn(), query: jest.fn(), end: jest.fn(), destroy: jest.fn(),
                stream: { destroy: jest.fn() }
            });
        })
    }
}));

import mysql from 'mysql2';
import { IdleConnectionReaper } from '../../src/pool/IdleConnectionReaper';
import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Events from '../../src/utils/Events';
import Logger from '../../src/utils/Logger';
import Metrics from '../../src/metrics/Metrics';

// The ping of the idle pooled connections of a node with a healthCheck block. The first
// half drives the reaper alone, with the fakes of reaper.test.ts plus a ping. The second
// half drives a Pool over a mysql2 the test plays. The clock is fake, and no socket opens
const INTERVAL = 10_000;
const IDLE = 30_000;
const LIMIT = 5_000;

// an idle connection as the reaper sees it. The test answers a ping by calling `answer`
const makeConn = () => {
    const connection = {
        destroy: jest.fn(), stream: { destroy: jest.fn() },
        ping: jest.fn(),
        // answer the ping that was sent last, or the one of `index`
        answer: (error?: any, index = connection.ping.mock.calls.length - 1) => {
            connection.ping.mock.calls[index][0](error);
        }
    };
    return connection;
};
const freeOf = (count: number) => ({ _freeConnections: { length: count } });
const lost = () => Object.assign(new Error('read ECONNRESET'),
    { code: 'ECONNRESET', errno: -104, syscall: 'read', fatal: true });

// a reaper that pings, started over a pool with `free` idle connections, all released now
const pinging = (free: number, min = 1, limit = LIMIT) => {
    const removed = jest.fn();
    const reaper = new IdleConnectionReaper(min, IDLE, INTERVAL, { timeout: limit, removed });
    const conns = Array.from({ length: free }, makeConn);
    reaper.start(freeOf(free) as any);
    conns.forEach(conn => reaper.onRelease(conn));
    return { reaper, conns, removed };
};
const pings = (conns: { ping: jest.Mock }[]) => conns.map(conn => conn.ping.mock.calls.length);
const destroys = (conns: { destroy: jest.Mock }[]) => {
    return conns.map(conn => conn.destroy.mock.calls.length);
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('IdleConnectionReaper without a ping: a node without the block', () => {
    it('sends no ping to an idle connection, at any tick', () => {
        const reaper = new IdleConnectionReaper(1, IDLE, INTERVAL);
        const conn = makeConn();
        reaper.start(freeOf(1) as any);
        reaper.onRelease(conn);

        jest.advanceTimersByTime(5 * INTERVAL);

        expect([pings([conn]), destroys([conn]), jest.getTimerCount()]).toEqual([[0], [0], 1]);
        reaper.stop();
    });
});

describe('IdleConnectionReaper with a ping: which connections get one', () => {
    it('every idle connection gets one ping at a tick, and none before it', () => {
        const { reaper, conns } = pinging(2);

        jest.advanceTimersByTime(INTERVAL - 1);
        const before = pings(conns);
        jest.advanceTimersByTime(1);

        expect([before, pings(conns)]).toEqual([[0, 0], [1, 1]]);
        reaper.stop();
    });

    it('a connection whose ping was answered gets the next one at the next tick', () => {
        const { reaper, conns } = pinging(1);

        jest.advanceTimersByTime(INTERVAL);
        conns[0].answer();
        jest.advanceTimersByTime(INTERVAL);

        expect(pings(conns)).toEqual([2]);
        reaper.stop();
    });

    it('the age rule comes first: a connection it closes gets no ping', () => {
        // two idle, a floor of one: the tick at 40 s closes the first and keeps the second
        const { reaper, conns } = pinging(2);
        for (let tick = 1; tick <= 3; tick++) {
            jest.advanceTimersByTime(INTERVAL);
            conns.forEach(conn => conn.answer());
        }
        jest.advanceTimersByTime(INTERVAL);

        expect([destroys(conns), pings(conns)]).toEqual([[1, 0], [3, 4]]);
        reaper.stop();
    });

    it('a connection the app holds gets none', () => {
        const { reaper, conns } = pinging(2);
        reaper.onAcquire(conns[0]);

        jest.advanceTimersByTime(INTERVAL);

        expect(pings(conns)).toEqual([0, 1]);
        reaper.stop();
    });

    it('with no idle connection a tick does nothing', () => {
        const { reaper, removed } = pinging(0);

        expect(() => jest.advanceTimersByTime(3 * INTERVAL)).not.toThrow();
        // the two timers of a reaper that pings: the age rule and the ping
        expect([removed.mock.calls.length, jest.getTimerCount()]).toEqual([0, 2]);
        reaper.stop();
    });

    it('a free list that cannot be read stops the age rule, and not the ping', () => {
        const { reaper, conns } = pinging(1);
        reaper.start({ get _freeConnections(): any { throw new Error('gone'); } } as any);

        expect(() => jest.advanceTimersByTime(INTERVAL)).not.toThrow();

        expect(pings(conns)).toEqual([1]);
        reaper.stop();
    });

    it('a connection whose ping is still out at the next tick gets no second one', () => {
        // the limit is longer than the wait between two ticks
        const { reaper, conns } = pinging(1, 1, 3 * INTERVAL);

        jest.advanceTimersByTime(2 * INTERVAL);

        expect([pings(conns), destroys(conns)]).toEqual([[1], [0]]);
        reaper.stop();
    });
});

describe('IdleConnectionReaper with a ping: what a ping ends with', () => {
    it('an answered ping keeps the connection, and leaves no timer of its own', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);

        conns[0].answer();
        jest.advanceTimersByTime(LIMIT);

        expect([destroys(conns), removed.mock.calls, jest.getTimerCount()]).toEqual([[0], [], 2]);
        reaper.stop();
    });

    it('a ping that fails closes the connection and its socket, and reports it once', () => {
        const { reaper, conns, removed } = pinging(1);
        const error = lost();
        jest.advanceTimersByTime(INTERVAL);

        conns[0].answer(error);

        expect([destroys(conns), conns[0].stream.destroy.mock.calls.length]).toEqual([[1], 1]);
        expect(removed.mock.calls).toEqual([[error]]);
        reaper.stop();
    });

    it('an error packet of the server for the ping closes the connection too', () => {
        const { reaper, conns, removed } = pinging(1);
        const error = Object.assign(new Error('Server shutdown in progress'), { errno: 1053 });
        jest.advanceTimersByTime(INTERVAL);

        conns[0].answer(error);

        expect([destroys(conns), removed.mock.calls]).toEqual([[1], [[error]]]);
        reaper.stop();
    });

    it('a connection that was closed after its ping gets no ping again', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);
        conns[0].answer(lost());

        jest.advanceTimersByTime(3 * INTERVAL);

        expect([pings(conns), destroys(conns), removed.mock.calls.length]).toEqual([[1], [1], 1]);
        reaper.stop();
    });

    it('only the connection whose ping failed is closed', () => {
        const { reaper, conns } = pinging(3);
        jest.advanceTimersByTime(INTERVAL);

        conns[0].answer();
        conns[1].answer(lost());
        conns[2].answer();

        expect(destroys(conns)).toEqual([0, 1, 0]);
        reaper.stop();
    });

    it('a ping with no answer is given its limit, to the millisecond', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);

        jest.advanceTimersByTime(LIMIT - 1);
        const before = destroys(conns);
        jest.advanceTimersByTime(1);

        expect([before, destroys(conns), removed.mock.calls.length]).toEqual([[0], [1], 1]);
        reaper.stop();
    });

    it('a ping that ran into its limit is reported with the code of a timeout', () => {
        const { reaper, conns, removed } = pinging(1);

        jest.advanceTimersByTime(INTERVAL + LIMIT);

        const [error] = removed.mock.calls[0];
        expect([error instanceof Error, error.code]).toEqual([true, 'PROTOCOL_SEQUENCE_TIMEOUT']);
        expect(conns[0].stream.destroy).toHaveBeenCalledTimes(1);
        reaper.stop();
    });

    it('an answer one millisecond before the limit keeps the connection', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL + LIMIT - 1);

        conns[0].answer();
        jest.advanceTimersByTime(LIMIT);

        expect([destroys(conns), removed.mock.calls]).toEqual([[0], []]);
        reaper.stop();
    });

    it('an answer or an error after the limit changes nothing more', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL + LIMIT);

        conns[0].answer(lost());
        conns[0].answer();

        expect([destroys(conns), removed.mock.calls.length]).toEqual([[1], 1]);
        reaper.stop();
    });

    it('a ping that throws is a failed ping, and nothing is thrown from the tick', () => {
        const { reaper, conns, removed } = pinging(1);
        const thrown = new Error('no ping here');
        conns[0].ping.mockImplementation(() => { throw thrown; });

        expect(() => jest.advanceTimersByTime(INTERVAL)).not.toThrow();

        expect([destroys(conns), removed.mock.calls]).toEqual([[1], [[thrown]]]);
        reaper.stop();
    });

    it('a destroy that throws after a failed ping is not thrown on', () => {
        const { reaper, conns, removed } = pinging(1);
        conns[0].destroy.mockImplementation(() => { throw new Error('gone already'); });
        jest.advanceTimersByTime(INTERVAL);

        expect(() => conns[0].answer(lost())).not.toThrow();

        expect(removed).toHaveBeenCalledTimes(1);
        reaper.stop();
    });
});

describe('IdleConnectionReaper with a ping: a connection the app draws meanwhile', () => {
    it('is not closed when its ping fails after that: mysql2 tells the app itself', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);

        reaper.onAcquire(conns[0]);
        conns[0].answer(lost());

        expect([destroys(conns), removed.mock.calls]).toEqual([[0], []]);
        reaper.stop();
    });

    it('is not closed at the limit of that ping, and the timer of the ping is gone', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);

        reaper.onAcquire(conns[0]);
        const timers = jest.getTimerCount();
        jest.advanceTimersByTime(LIMIT);

        expect([timers, destroys(conns), removed.mock.calls]).toEqual([2, [0], []]);
        reaper.stop();
    });

    it('once released it is pinged again, and the old ping decides nothing', () => {
        // the limit is longer than two ticks, so the first ping can still be out
        const { reaper, conns, removed } = pinging(1, 1, 3 * INTERVAL);
        jest.advanceTimersByTime(INTERVAL);
        reaper.onAcquire(conns[0]);
        reaper.onRelease(conns[0]);
        jest.advanceTimersByTime(INTERVAL);

        conns[0].answer(lost(), 0);
        const afterOld = destroys(conns);
        conns[0].answer(lost(), 1);

        expect([pings(conns), afterOld, destroys(conns)]).toEqual([[2], [0], [1]]);
        expect(removed).toHaveBeenCalledTimes(1);
        reaper.stop();
    });
});

describe('IdleConnectionReaper with a ping: stop and start', () => {
    it('no ping is sent after stop()', () => {
        const { reaper, conns } = pinging(1);
        reaper.stop();

        jest.advanceTimersByTime(3 * INTERVAL);

        expect([pings(conns), jest.getTimerCount()]).toEqual([[0], 0]);
    });

    // mysql2 queues the logout of disconnect() behind the ping, and would wait for an
    // answer that may never come
    it('stop() while a ping is out closes that connection and its socket, and no other', () => {
        const { reaper, conns, removed } = pinging(2);
        jest.advanceTimersByTime(INTERVAL);
        conns[0].answer();

        reaper.stop();

        expect([destroys(conns), conns[1].stream.destroy.mock.calls.length]).toEqual([[0, 1], 1]);
        expect(removed).not.toHaveBeenCalled();
    });

    it('stop() while a ping is out leaves no timer, and closes nothing more at the limit', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);

        reaper.stop();
        const timers = jest.getTimerCount();
        jest.advanceTimersByTime(LIMIT);

        expect([timers, destroys(conns), removed.mock.calls]).toEqual([0, [1], []]);
    });

    it('a ping that fails after stop() closes nothing more and reports nothing', () => {
        const { reaper, conns, removed } = pinging(1);
        jest.advanceTimersByTime(INTERVAL);
        reaper.stop();

        conns[0].answer(lost());

        expect([destroys(conns), removed.mock.calls]).toEqual([[1], []]);
    });

    it('a destroy that throws at stop() is not thrown on, and the next is still closed', () => {
        const { reaper, conns } = pinging(2);
        conns[0].destroy.mockImplementation(() => { throw new Error('gone already'); });
        jest.advanceTimersByTime(INTERVAL);

        expect(() => reaper.stop()).not.toThrow();

        expect([destroys(conns), jest.getTimerCount()]).toEqual([[1, 1], 0]);
    });

    it('a second start() without a stop() sends one ping per tick, not two', () => {
        const { reaper, conns } = pinging(1);
        reaper.start(freeOf(1) as any);

        jest.advanceTimersByTime(INTERVAL);

        // the age rule, the ping and the limit of the one ping that is out
        expect([pings(conns), jest.getTimerCount()]).toEqual([[1], 3]);
        reaper.stop();
    });

    it('stop() then start(): a connection released after it is pinged again', () => {
        const { reaper, conns } = pinging(1);
        reaper.stop();
        reaper.start(freeOf(1) as any);
        const next = makeConn();
        reaper.onRelease(next);

        jest.advanceTimersByTime(INTERVAL);

        // the one from before the stop is forgotten, as the stop closed its pool
        expect(pings([conns[0], next])).toEqual([0, 1]);
        reaper.stop();
    });
});

// The wait each timer of the reaper is armed with, by its idleCheckInterval. Node runs a
// timer whose wait is below 1 ms, or above 2147483647, after 1 ms. The age rule keeps that
// wait, as before. The ping has a timer of its own, never below 100 ms
describe('IdleConnectionReaper: the pace of the ping', () => {
    let intervals: jest.SpyInstance;
    beforeEach(() => {
        intervals = jest.spyOn(global, 'setInterval');
    });
    afterEach(() => intervals.mockRestore());
    // the wait of every interval timer that was started, in order
    const armed = (ping: boolean, idleCheckInterval: number) => {
        const options = ping ? { timeout: LIMIT, removed: jest.fn() } : undefined;
        const reaper = new IdleConnectionReaper(1, IDLE, idleCheckInterval, options);
        reaper.start(freeOf(0) as any);
        reaper.stop();
        return intervals.mock.calls.map(([, ms]) => ms);
    };
    const ODD: [string, number, number][] = [
        ['0', 0, 100], ['a negative number', -5, 100], ['a fraction below 1', 0.4, 100],
        ['2147483648, above the longest wait of a timer', 2147483648, 2147483647]
    ];

    it.each(ODD)('idleCheckInterval %s: the ping gets the nearest wait it may have',
        (_name, value, pace) => {
            expect(armed(true, value)).toEqual([value, pace]);
        });

    it.each(ODD)('idleCheckInterval %s without a ping: one timer, with that wait as before',
        (_name, value) => {
            expect(armed(false, value)).toEqual([value]);
        });

    it.each([
        ['99, just below the floor', 99, 100], ['100, the floor', 100, 100],
        ['the default', 10_000, 10_000], ['the longest wait of a timer', 2147483647, 2147483647],
        ['not a number', NaN, 100]
    ])('idleCheckInterval %s: the ping and the age rule', (_name, value, pace) => {
        expect(armed(true, value)).toEqual([value, pace]);
    });

    it('the timer of the age rule is started first, so it runs first at a shared tick', () => {
        const { reaper, conns } = pinging(1);
        const order: string[] = [];
        jest.spyOn(reaper as any, '_tick').mockImplementation(() => order.push('age rule'));
        conns[0].ping.mockImplementation(() => order.push('ping'));

        jest.advanceTimersByTime(INTERVAL);

        expect(order).toEqual(['age rule', 'ping']);
        reaper.stop();
    });
});

// The same on the real clock of Node, where such a wait really is 1 ms: 300 ticks of the
// age rule take 300 ms or more. A ping is answered at once, so only the pace holds it back
describe('IdleConnectionReaper on the real clock: an idleCheckInterval Node runs every ms', () => {
    let ticks: jest.SpyInstance;
    let warned: jest.SpyInstance;
    beforeEach(() => {
        jest.useRealTimers();
        ticks = jest.spyOn(IdleConnectionReaper.prototype as any, '_tick');
        // Node says once per process that it took 1 ms for such a wait. Not this suite's line
        warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    });
    afterEach(() => [ticks, warned].forEach(spy => spy.mockRestore()));
    const TICKS = 300;
    const run = async (idleCheckInterval: number, ping: boolean) => {
        const conn = makeConn();
        conn.ping.mockImplementation((done: () => void) => done());
        const options = ping ? { timeout: LIMIT, removed: jest.fn() } : undefined;
        const reaper = new IdleConnectionReaper(1, IDLE, idleCheckInterval, options);
        const began = Date.now();
        reaper.start(freeOf(1) as any);
        reaper.onRelease(conn);
        // gives up after 4000 turns, 20 s or more, and says what it saw
        for (let turn = 0; turn < 4000 && ticks.mock.calls.length < TICKS; turn++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        reaper.stop();
        const seen = { ticks: ticks.mock.calls.length, pings: conn.ping.mock.calls.length };
        if (seen.ticks < TICKS) throw new Error('gave up waiting for 300 ticks: ' + seen.ticks);
        return { ...seen, ms: Date.now() - began, closed: conn.destroy.mock.calls.length };
    };

    it.each([
        ['0', 0], ['a negative number', -5], ['a fraction below 1', 0.4]
    ])('idleCheckInterval %s: a ping every 100 ms, not at every tick', async (_name, value) => {
        const { pings, ms } = await run(value, true);

        expect(pings).toBeGreaterThanOrEqual(1);
        expect(pings).toBeLessThanOrEqual(Math.floor(ms / 100) + 1);
    });

    it('idleCheckInterval 2147483648: no ping in those 300 ticks', async () => {
        expect((await run(2147483648, true)).pings).toBe(0);
    });

    it.each([
        ['0', 0], ['a negative number', -5], ['a fraction below 1', 0.4],
        ['2147483648', 2147483648]
    ])('idleCheckInterval %s without a ping: 300 ticks, and nothing is sent or closed',
        async (_name, value) => {
            const { pings, closed } = await run(value, false);

            expect([pings, closed]).toEqual([0, 0]);
        });
});

// the error names the argument that is wrong. Its wording is not held
describe('IdleConnectionReaper: the ping argument is checked', () => {
    const build = (ping: any) => () => new IdleConnectionReaper(1, IDLE, INTERVAL, ping);
    const removed = () => undefined;
    const refusal = (build: () => unknown): [boolean, string] => {
        try {
            build();
        } catch (thrown) {
            return [thrown instanceof TypeError, thrown.message];
        }
        return [false, 'nothing was thrown'];
    };

    it.each([
        ['zero', 0], ['a negative number', -1], ['NaN', NaN], ['Infinity', Infinity],
        ['a string', '5000'], ['undefined', undefined], ['null', null]
    ])('a timeout that is %s is refused by name', (_name, timeout) => {
        expect(refusal(build({ timeout, removed }))).toEqual(
            [true, expect.stringContaining('ping.timeout')]);
    });

    it.each([
        ['missing', undefined], ['a string', 'log'], ['null', null]
    ])('a removed that is %s is refused by name', (_name, value) => {
        expect(refusal(build({ timeout: LIMIT, removed: value }))).toEqual(
            [true, expect.stringContaining('ping.removed')]);
    });

    it.each([
        ['null', null], ['a number', 5000], ['a string', 'yes'], ['true', true]
    ])('a ping that is %s is refused', (_name, ping) => {
        expect(refusal(build(ping))).toEqual([true, expect.stringMatching(/\bping\b(?!\.)/)]);
    });

    it('left out, it builds a reaper', () => {
        expect(build(undefined)).not.toThrow();
    });
});

// A Pool over the mysql2 above. flags are set, so connect() asks no server. No validators:
// an answered check is a valid node
const createPool = mysql.createPool as unknown as jest.Mock;
const createConnection = mysql.createConnection as unknown as jest.Mock;
const recordOperation = Metrics.recordOperation as unknown as jest.Mock;
const recordHealthCheck = Metrics.recordHealthCheck as unknown as jest.Mock;
const debug = Logger.debug as unknown as jest.Mock;
const louder = [Logger.warn, Logger.error] as unknown as jest.Mock[];
const CHECK_TIMEOUT = 2_000;
const LONG = 600_000;
const WITH_BLOCK = { healthCheck: { interval: LONG, timeout: CHECK_TIMEOUT } };
// the legacy check, ten minutes apart as well
const WITHOUT_BLOCK = { timerCheckRange: { start: LONG, end: LONG } };

const makePool = (settings: object): any => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: 'db.example', name: 'node-a' }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], validators: [],
            loadFactors: [], ...settings
        }
    } as any).hosts[0];
    return new Pool({ id: 1, ...host }, 'test');
};
const settle = async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};
const lastOf = (mock: jest.Mock) => mock.mock.results[mock.mock.results.length - 1].value;
// connect a pool. With the block its check logs in on the check connection and is answered
// there. Without it the check asks through query(), which the test answers
const connected = async (settings: object = WITH_BLOCK) => {
    const pool = makePool(settings);
    const block = 'healthCheck' in settings;
    if (!block) pool.query = jest.fn().mockResolvedValue([]);
    const connecting = pool.connect();
    if (block) {
        const check = lastOf(createConnection);
        check.emit('connect', {});
        await settle();
        check.changeUser.mock.calls[0][1](null);
        await settle();
        check.query.mock.calls[0][1](null, []);
    }
    await connecting;
    return pool;
};
// put one idle connection into the mysql2 pool the Pool created last, as mysql2 does when
// the app releases one. Its destroy() takes it out of the lists, as that of mysql2 does
const idleIn = (mysqlPool: any = lastOf(createPool)) => {
    const connection = makeConn();
    const leave = (list: any[]) => {
        if (list.includes(connection)) list.splice(list.indexOf(connection), 1);
    };
    connection.destroy.mockImplementation(() => {
        leave(mysqlPool._allConnections);
        leave(mysqlPool._freeConnections);
    });
    mysqlPool._allConnections.push(connection);
    mysqlPool._freeConnections.push(connection);
    mysqlPool.emit('release', connection);
    return connection;
};
// every event of the cluster that was emitted, by name. The emitter is one per process
const emitted: string[] = [];
['connection', 'acquire', 'release', 'pool_check_failed', 'pool_disconnected'].forEach(name => {
    Events.on(name as any, () => emitted.push(name));
});

let pools: any[];
beforeEach(() => {
    pools = [];
    [createPool, createConnection, recordOperation, recordHealthCheck, debug].forEach(mock => {
        mock.mockClear();
    });
});
afterEach(() => pools.forEach(pool => pool.disconnect()));
const started = async (settings?: object) => {
    const pool = await connected(settings);
    pools.push(pool);
    emitted.length = 0;
    [recordOperation, recordHealthCheck, debug, ...louder].forEach(mock => mock.mockClear());
    return pool;
};
// The debug lines about a ping that took a connection out: their fields, never their
// wording. `idlePing` is the field only these lines have
const removals = () => debug.mock.calls.map(([, meta]) => meta).filter(meta => meta?.idlePing);

describe('a node with a healthCheck block: its idle pooled connections are pinged', () => {
    it('one ping per idle connection every idleCheckInterval', async () => {
        await started({ ...WITH_BLOCK, idleCheckInterval: 3_000 });
        const conns = [idleIn(), idleIn()];

        jest.advanceTimersByTime(2_999);
        const before = pings(conns);
        jest.advanceTimersByTime(1);

        expect([before, pings(conns)]).toEqual([[0, 0], [1, 1]]);
    });

    it('a ping has the timeout of the block to be answered', async () => {
        await started();
        const conn = idleIn();
        jest.advanceTimersByTime(INTERVAL);

        jest.advanceTimersByTime(CHECK_TIMEOUT - 1);
        const before = destroys([conn]);
        jest.advanceTimersByTime(1);

        expect([before, destroys([conn])]).toEqual([[0], [1]]);
    });

    it('a ping is no query of the app: no event, no metric record, the counts as before',
        async () => {
            const pool = await started();
            const conn = idleIn();
            emitted.length = 0;
            const before = [pool.stats(), pool.availableConnectionCount];

            jest.advanceTimersByTime(INTERVAL);
            const during = [pool.stats(), pool.availableConnectionCount];
            conn.answer();

            const counts = [{ used: 0, idle: 1, pending: 0 }, 10];
            expect([before, during]).toEqual([counts, counts]);
            expect([emitted, recordOperation.mock.calls, recordHealthCheck.mock.calls])
                .toEqual([[], [], []]);
        });

    it('an answered ping logs nothing about it', async () => {
        await started();
        const conn = idleIn();

        jest.advanceTimersByTime(INTERVAL);
        conn.answer();

        expect(removals()).toEqual([]);
    });
});

describe('a node with a healthCheck block: a ping that fails', () => {
    it('takes its connection out of the pool, so the app cannot draw it', async () => {
        const pool = await started();
        const conn = idleIn();
        jest.advanceTimersByTime(INTERVAL);

        conn.answer(lost());

        expect([destroys([conn]), pool.stats()]).toEqual([[1], { used: 0, idle: 0, pending: 0 }]);
    });

    it('is one debug line with the pool and the code, and no other level', async () => {
        await started();
        const conn = idleIn();
        jest.advanceTimersByTime(INTERVAL);

        conn.answer(lost());
        jest.advanceTimersByTime(INTERVAL);

        expect(removals()).toEqual([{ pool: 'node-a', idlePing: 'failed', code: 'ECONNRESET' }]);
        expect(louder.map(mock => mock.mock.calls)).toEqual([[], []]);
    });

    it('a ping with no answer is logged with the code of a timeout', async () => {
        await started();
        idleIn();

        jest.advanceTimersByTime(INTERVAL + CHECK_TIMEOUT);

        expect(removals()).toEqual([
            { pool: 'node-a', idlePing: 'failed', code: 'PROTOCOL_SEQUENCE_TIMEOUT' }
        ]);
    });

    it('takes no node down and starts no check', async () => {
        const pool = await started();
        const conn = idleIn();
        // the logins of the check connection, and the checks that began on it: each
        // begins with a change of user
        const asked = () => {
            const check = lastOf(createConnection);
            return [createConnection.mock.calls.length, check.changeUser.mock.calls.length];
        };
        const before = asked();
        jest.advanceTimersByTime(INTERVAL);

        conn.answer(lost());
        // a check that passive health starts runs on a timer of 0 ms
        jest.advanceTimersByTime(1);
        await settle();

        expect([pool.status.isValid, pool.checkError]).toEqual([true, undefined]);
        expect([before, asked()]).toEqual([[1, 1], [1, 1]]);
    });

    it('emits no event and records no metric', async () => {
        await started();
        const conn = idleIn();
        emitted.length = 0;
        jest.advanceTimersByTime(INTERVAL);

        conn.answer(lost());
        await settle();

        expect([emitted, recordOperation.mock.calls, recordHealthCheck.mock.calls])
            .toEqual([[], [], []]);
    });

    it('opens no connection in its place', async () => {
        await started();
        const conn = idleIn();
        jest.advanceTimersByTime(INTERVAL);

        conn.answer(lost());
        jest.advanceTimersByTime(INTERVAL);

        expect(lastOf(createPool).getConnection).not.toHaveBeenCalled();
    });
});

describe('a node without a healthCheck block', () => {
    it('sends no ping to an idle pooled connection, at any tick', async () => {
        await started(WITHOUT_BLOCK);
        const conn = idleIn();

        jest.advanceTimersByTime(5 * INTERVAL);

        expect([pings([conn]), destroys([conn]), removals()]).toEqual([[0], [0], []]);
    });
});

describe('the ping and the life of a pool', () => {
    it('no ping is sent after disconnect()', async () => {
        const pool = await connected();
        const conn = idleIn();
        pool.disconnect();

        jest.advanceTimersByTime(3 * INTERVAL);

        expect(pings([conn])).toEqual([0]);
    });

    it('disconnect() while a ping is out closes that connection, and logs nothing about ' +
        'a ping', async () => {
        const pool = await connected();
        const conn = idleIn();
        jest.advanceTimersByTime(INTERVAL);
        debug.mockClear();

        pool.disconnect();
        const closed = destroys([conn]);
        jest.advanceTimersByTime(CHECK_TIMEOUT);
        conn.answer(lost());

        expect([closed, destroys([conn]), removals()]).toEqual([[1], [1], []]);
    });

    it('disconnect() leaves an idle connection with no ping out to the logout of mysql2',
        async () => {
            const pool = await connected();
            const conn = idleIn();
            jest.advanceTimersByTime(INTERVAL);
            conn.answer();

            pool.disconnect();

            expect([destroys([conn]), lastOf(createPool).end.mock.calls.length]).toEqual([[0], 1]);
        });

    // The fake clock runs a timer of 2147483648 ms every millisecond, as Node does. One of
    // 0 ms it would never get past, so the waits below 1 ms are rows on the real clock
    it('idleCheckInterval 2147483648 on a node with the block is taken by the settings, ' +
        'and no ping comes in 10 s', async () => {
        await started({ ...WITH_BLOCK, idleCheckInterval: 2147483648 });
        const conn = idleIn();
        conn.ping.mockImplementation((done: () => void) => done());

        jest.advanceTimersByTime(10_000);

        expect(pings([conn])).toEqual([0]);
    });

    it('connect, disconnect, connect: the connections of the new pool are pinged', async () => {
        const pool = await connected();
        const old = idleIn();
        pool.disconnect();
        pools.push(pool);
        const connecting = pool.connect();
        lastOf(createConnection).emit('connect', {});
        await settle();
        lastOf(createConnection).changeUser.mock.calls[0][1](null);
        await settle();
        lastOf(createConnection).query.mock.calls[0][1](null, []);
        await connecting;
        const next = idleIn();

        jest.advanceTimersByTime(INTERVAL);

        expect(pings([old, next])).toEqual([0, 1]);
    });

    it('a second connect() without a disconnect(): one ping per tick, not two', async () => {
        const pool = await started();
        const connecting = pool.connect();
        lastOf(createConnection).emit('connect', {});
        await settle();
        lastOf(createConnection).changeUser.mock.calls[0][1](null);
        await settle();
        lastOf(createConnection).query.mock.calls[0][1](null, []);
        await connecting;
        const conn = idleIn();

        jest.advanceTimersByTime(INTERVAL);

        expect(pings([conn])).toEqual([1]);
    });
});
