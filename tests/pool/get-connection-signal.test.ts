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
// a mysql2 pool that opens nothing. The queue of waiting callbacks has the two methods of
// mysql2's own queue that take one entry out of the middle: get and removeOne
jest.mock('mysql2', () => {
    class Queue extends Array {
        get(index: number) { return this[index]; }
        removeOne(index: number) { return this.splice(index, 1)[0]; }
    }
    return {
        __esModule: true,
        default: {
            createPool: jest.fn(() => ({
                on: jest.fn(), end: jest.fn(), getConnection: jest.fn(),
                _allConnections: [], _freeConnections: [], _connectionQueue: new Queue()
            })),
            createConnection: jest.fn()
        }
    };
});

import { getEventListeners } from 'events';
import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Logger from '../../src/utils/Logger';

// nothing here waits for a clock or a socket: a test that hangs is a bug
jest.setTimeout(10000);

// flags are set, so connect() asks no server. No validators: an answered check is a valid pool
const makePool = (): any => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1' }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 5,
            validators: [], loadFactors: []
        }
    } as any).hosts[0];
    return new Pool({ id: 7, name: 'seven', ...host }, 'test');
};

// a connected pool runs a timer for its idle connections. disconnect() stops it
const pools: any[] = [];
afterEach(() => pools.splice(0).forEach(pool => pool.disconnect()));

// The pool with its mysql2 pool created, and that mysql2 pool. A request to it waits in the
// queue, as in a full pool, unless a test says otherwise
const connected = async (): Promise<{ pool: any, mysqlPool: any }> => {
    const pool = makePool();
    pools.push(pool);
    // the status check of connect() asks through this
    const query = pool.query;
    pool.query = jest.fn().mockResolvedValue([]);
    await pool.connect();
    pool.status.stopTimerCheck();
    pool.query = query;
    const mysqlPool = pool._pool;
    const queue = mysqlPool._connectionQueue;
    mysqlPool.getConnection.mockImplementation((cb: any) => { queue.push(cb); });
    return { pool, mysqlPool };
};

// mysql2 keeps the callback of a login that still runs to itself, in no list
const loggingIn = (mysqlPool: any): any[] => {
    const callbacks: any[] = [];
    mysqlPool.getConnection.mockImplementation((cb: any) => { callbacks.push(cb); });
    return callbacks;
};

const connection = (): any => ({ release: jest.fn(), destroy: jest.fn() });

// How a promise stands one turn of the event loop from now. No timer: a promise that is still
// pending then is one that waits for something the test has not done yet
const stateOf = (promise: Promise<any>): Promise<any> => Promise.race([
    promise.then(value => ({ resolved: value }), reason => ({ rejected: reason })),
    new Promise(resolve => setImmediate(() => resolve('pending')))
]);

// A request whose rejection always has a handler. Without one, an assertion that fails before
// the test reads the request leaves an unhandled rejection, which ends the worker instead of
// failing the test
const quiet = (request: Promise<any>): Promise<any> => {
    request.catch(() => undefined);
    return request;
};

// the listeners a signal holds now, and how often the pool added and removed one
const watch = (signal: AbortSignal) => {
    const added = jest.spyOn(signal, 'addEventListener');
    const removed = jest.spyOn(signal, 'removeEventListener');
    return { added, removed, held: () => getEventListeners(signal, 'abort').length };
};

// What a signal is in a small polyfill: no reason, as on a Node that has no signal.reason yet,
// and abort() calls every listener it held when it began, also one that was taken off since
const oldSignal = (): any => {
    const listeners: (() => void)[] = [];
    return {
        aborted: false,
        addEventListener: jest.fn((_type: string, listener: () => void) => {
            listeners.push(listener);
        }),
        removeEventListener: jest.fn((_type: string, listener: () => void) => {
            if (listeners.includes(listener)) listeners.splice(listeners.indexOf(listener), 1);
        }),
        abort() {
            this.aborted = true;
            [...listeners].forEach(listener => listener());
        },
        listeners
    };
};

beforeEach(() => jest.clearAllMocks());

describe('Pool.getConnection with a signal that does not abort', () => {
    it('resolves with the connection mysql2 hands out, asked once', async () => {
        const { pool, mysqlPool } = await connected();
        const handed = connection();
        mysqlPool.getConnection.mockImplementation((cb: any) => cb(null, handed));
        const outcome: any = {};

        expect(await pool.getConnection(new AbortController().signal, outcome)).toBe(handed);
        expect(mysqlPool.getConnection).toHaveBeenCalledTimes(1);
        expect(handed.release).not.toHaveBeenCalled();
        expect(outcome).toEqual({});
    });

    it('rejects with the error object of mysql2 and does not call it an abort', async () => {
        const { pool, mysqlPool } = await connected();
        const error = Object.assign(new Error('Pool is closed.'), { code: 'X' });
        mysqlPool.getConnection.mockImplementation((cb: any) => cb(error));
        const outcome: any = {};

        const failure = await pool.getConnection(new AbortController().signal, outcome)
            .catch((e: any) => e);
        expect(failure).toBe(error);
        expect(outcome).toEqual({});
    });

    it('rejects with POOL_NOT_CONNECTED before connect(), with no listener added', async () => {
        const { signal } = new AbortController();
        const listeners = watch(signal);

        const failure = await makePool().getConnection(signal).catch((e: any) => e);
        expect(failure.code).toBe('POOL_NOT_CONNECTED');
        expect(listeners.added).not.toHaveBeenCalled();
    });
});

describe('Pool.getConnection with a signal that is already aborted', () => {
    it('rejects with the reason and asks mysql2 for nothing', async () => {
        const { pool, mysqlPool } = await connected();
        const reason = new Error('too late');
        const outcome: any = {};

        const state = await stateOf(pool.getConnection(AbortSignal.abort(reason), outcome));
        expect(state.rejected).toBe(reason);
        expect(mysqlPool.getConnection).not.toHaveBeenCalled();
        expect(mysqlPool._connectionQueue).toHaveLength(0);
        expect(outcome).toEqual({ aborted: true });
    });

    it('adds no listener to the signal', async () => {
        const { pool } = await connected();
        const signal = AbortSignal.abort(new Error('too late'));
        const listeners = watch(signal);

        expect(await stateOf(pool.getConnection(signal))).toEqual({ rejected: signal.reason });
        expect(listeners.added).not.toHaveBeenCalled();
        expect(listeners.held()).toBe(0);
    });

    it('rejects with the reason before connect() too, not with POOL_NOT_CONNECTED', async () => {
        const reason = new Error('too late');

        expect(await makePool().getConnection(AbortSignal.abort(reason)).catch((e: any) => e))
            .toBe(reason);
    });
});

describe('Pool.getConnection aborted while its request waits in the queue', () => {
    it('rejects with the reason at the abort, before any connection arrives', async () => {
        const { pool } = await connected();
        const controller = new AbortController();
        const reason = new Error('gave up');
        const outcome: any = {};
        const request = quiet(pool.getConnection(controller.signal, outcome));
        expect(await stateOf(request)).toBe('pending');

        controller.abort(reason);
        expect((await stateOf(request)).rejected).toBe(reason);
        expect(outcome).toEqual({ aborted: true });
    });

    it('takes the request out of the queue, so stats() shows one waiter less', async () => {
        const { pool, mysqlPool } = await connected();
        const controller = new AbortController();
        pool.getConnection(controller.signal).catch(() => undefined);
        expect(pool.stats().pending).toBe(1);

        controller.abort();
        expect(pool.stats().pending).toBe(0);
        expect(mysqlPool._connectionQueue).toHaveLength(0);
    });

    it('leaves the other waiters in the queue, in their order', async () => {
        const { pool, mysqlPool } = await connected();
        const [first, last] = [jest.fn(), jest.fn()];
        const controller = new AbortController();
        mysqlPool._connectionQueue.push(first);
        pool.getConnection(controller.signal).catch(() => undefined);
        mysqlPool._connectionQueue.push(last);

        controller.abort();
        expect([...mysqlPool._connectionQueue]).toEqual([first, last]);
        expect(first).not.toHaveBeenCalled();
        expect(last).not.toHaveBeenCalled();
    });

    it('takes out its own request, not the one of another call with a signal', async () => {
        const { pool, mysqlPool } = await connected();
        const [mine, other] = [new AbortController(), new AbortController()];
        pool.getConnection(other.signal).catch(() => undefined);
        pool.getConnection(mine.signal).catch(() => undefined);
        const stays = mysqlPool._connectionQueue[0];

        mine.abort();
        expect([...mysqlPool._connectionQueue]).toEqual([stays]);
    });

    it('takes the request out of the pool it went to, when connect() made a new one', async () => {
        const { pool, mysqlPool } = await connected();
        const controller = new AbortController();
        pool.getConnection(controller.signal).catch(() => undefined);
        pool._pool = { ...mysqlPool, _connectionQueue: [] };

        controller.abort();
        expect(mysqlPool._connectionQueue).toHaveLength(0);
        pool._pool = mysqlPool;
    });

    it('rejects every call that waits on the same signal', async () => {
        const { pool, mysqlPool } = await connected();
        const controller = new AbortController();
        const reason = { why: 'shutdown' };
        const requests = [1, 2, 3].map(() => pool.getConnection(controller.signal));
        requests.forEach(request => request.catch(() => undefined));

        controller.abort(reason);
        const states = await Promise.all(requests.map(stateOf));
        states.forEach(state => expect(state.rejected).toBe(reason));
        expect(mysqlPool._connectionQueue).toHaveLength(0);
    });
});

describe('Pool.getConnection aborted while its connection logs in', () => {
    it('rejects with the reason at the abort, not when the connection arrives', async () => {
        const { pool, mysqlPool } = await connected();
        const logins = loggingIn(mysqlPool);
        const controller = new AbortController();
        const reason = new Error('gave up');
        const request = quiet(pool.getConnection(controller.signal));

        controller.abort(reason);
        expect((await stateOf(request)).rejected).toBe(reason);
        expect(logins).toHaveLength(1);
    });

    it('releases the connection that arrives later and does not hand it out', async () => {
        const { pool, mysqlPool } = await connected();
        const logins = loggingIn(mysqlPool);
        const controller = new AbortController();
        const reason = new Error('gave up');
        const request = quiet(pool.getConnection(controller.signal));
        controller.abort(reason);
        const arrived = connection();

        logins[0](null, arrived);
        expect(arrived.release).toHaveBeenCalledTimes(1);
        expect(arrived.destroy).not.toHaveBeenCalled();
        expect((await stateOf(request)).rejected).toBe(reason);
    });

    it('does nothing when the login fails later', async () => {
        const { pool, mysqlPool } = await connected();
        const logins = loggingIn(mysqlPool);
        const controller = new AbortController();
        const reason = new Error('gave up');
        const request = quiet(pool.getConnection(controller.signal));
        controller.abort(reason);

        expect(() => logins[0](new Error('Access denied'))).not.toThrow();
        expect((await stateOf(request)).rejected).toBe(reason);
    });
});

describe('Pool.getConnection whose signal aborts after the call settled', () => {
    it('does nothing after the promise resolved: the caller keeps the connection', async () => {
        const { pool, mysqlPool } = await connected();
        const handed = connection();
        mysqlPool.getConnection.mockImplementation((cb: any) => cb(null, handed));
        const controller = new AbortController();
        const outcome: any = {};
        const request = quiet(pool.getConnection(controller.signal, outcome));
        expect(await request).toBe(handed);

        controller.abort(new Error('too late'));
        expect(await stateOf(request)).toEqual({ resolved: handed });
        expect(handed.release).not.toHaveBeenCalled();
        expect(handed.destroy).not.toHaveBeenCalled();
        expect(outcome).toEqual({});
    });

    it('keeps the error of mysql2 after the promise rejected with it', async () => {
        const { pool, mysqlPool } = await connected();
        const error = new Error('Access denied');
        mysqlPool.getConnection.mockImplementation((cb: any) => cb(error));
        const controller = new AbortController();
        const outcome: any = {};
        const request = quiet(pool.getConnection(controller.signal, outcome));
        request.catch(() => undefined);

        controller.abort(new Error('too late'));
        expect((await stateOf(request)).rejected).toBe(error);
        expect(outcome).toEqual({});
    });

    // a signal that still calls a listener it was told to drop
    it('does nothing when a signal calls its listener after the call settled', async () => {
        const { pool, mysqlPool } = await connected();
        const handed = connection();
        const signal = oldSignal();
        signal.removeEventListener = jest.fn();
        const outcome: any = {};
        const request = quiet(pool.getConnection(signal, outcome));
        const other = jest.fn();
        mysqlPool._connectionQueue.push(other);
        mysqlPool._connectionQueue.shift()(null, handed);
        expect(await request).toBe(handed);

        signal.abort();
        expect(outcome).toEqual({});
        expect([...mysqlPool._connectionQueue]).toEqual([other]);
        expect(handed.release).not.toHaveBeenCalled();
    });
});

describe('the listener Pool.getConnection puts on the signal', () => {
    // each row settles the call in its own way. The listener must be gone after every one
    const outcomes: [string, (context: any) => void][] = [
        ['resolved', ({ mysqlPool }) => mysqlPool._connectionQueue.shift()(null, connection())],
        ['rejected by an error of mysql2', ({ mysqlPool }) => {
            mysqlPool._connectionQueue.shift()(new Error('Pool is closed.'));
        }],
        ['rejected by the abort', ({ controller }) => controller.abort()],
        ['rejected by failWaiting', ({ pool }) => pool.failWaiting(new Error('going down'))]
    ];

    it.each(outcomes)('is one listener while the call waits, and none once it %s', async (
        _name, settle
    ) => {
        const { pool, mysqlPool } = await connected();
        const controller = new AbortController();
        const listeners = watch(controller.signal);
        const request = quiet(pool.getConnection(controller.signal));
        request.catch(() => undefined);
        expect(listeners.held()).toBe(1);

        settle({ pool, mysqlPool, controller });
        expect((await stateOf(request))).not.toBe('pending');
        expect(listeners.held()).toBe(0);
        expect(listeners.added).toHaveBeenCalledTimes(1);
        expect(listeners.removed).toHaveBeenCalledTimes(1);
        expect(listeners.removed.mock.calls[0]).toEqual(listeners.added.mock.calls[0]);
        expect(listeners.added.mock.calls[0][0]).toBe('abort');
    });

    it('is gone when mysql2 throws instead of calling back', async () => {
        const { pool, mysqlPool } = await connected();
        const thrown = new Error('a listener of acquire threw');
        mysqlPool.getConnection.mockImplementation(() => { throw thrown; });
        const { signal } = new AbortController();
        const listeners = watch(signal);

        expect(await pool.getConnection(signal).catch((e: any) => e)).toBe(thrown);
        expect(listeners.held()).toBe(0);
    });

    it('does nothing at an abort after mysql2 threw, on a signal that kept it', async () => {
        const { pool, mysqlPool } = await connected();
        const thrown = new Error('a listener of acquire threw');
        mysqlPool.getConnection.mockImplementation(() => { throw thrown; });
        const signal = oldSignal();
        signal.removeEventListener = jest.fn();
        const outcome: any = {};
        expect(await pool.getConnection(signal, outcome).catch((e: any) => e)).toBe(thrown);

        signal.abort();
        expect(outcome).toEqual({});
    });

    it('is on the signal before mysql2 is asked, so an answer at once takes it off', async () => {
        const { pool, mysqlPool } = await connected();
        const { signal } = new AbortController();
        const listeners = watch(signal);
        let heldWhenAsked = -1;
        mysqlPool.getConnection.mockImplementation((cb: any) => {
            heldWhenAsked = listeners.held();
            cb(null, connection());
        });

        await pool.getConnection(signal);
        expect(heldWhenAsked).toBe(1);
        expect(listeners.held()).toBe(0);
    });
});

describe('the reason Pool.getConnection rejects with', () => {
    it.each([
        ['an Error', new Error('gave up')],
        ['a plain object', { why: 'deadline' }],
        ['a frozen object', Object.freeze({ why: 'deadline' })],
        ['a string', 'gave up'],
        ['null', null],
        ['zero', 0],
        ['false', false]
    ])('is the reason of the signal as it is: %s', async (_name, reason) => {
        const { pool } = await connected();
        const controller = new AbortController();
        const request = quiet(pool.getConnection(controller.signal));

        controller.abort(reason);
        expect((await stateOf(request)).rejected).toBe(reason);
    });

    it('is not changed: an object reason keeps its own keys and gets no other', async () => {
        const { pool } = await connected();
        const controller = new AbortController();
        const reason = { why: 'deadline' };
        const request = quiet(pool.getConnection(controller.signal));

        controller.abort(reason);
        await stateOf(request);
        expect(Reflect.ownKeys(reason)).toEqual(['why']);
    });

    it('is the error Node makes when abort() gets no reason', async () => {
        const { pool } = await connected();
        const controller = new AbortController();
        const request = quiet(pool.getConnection(controller.signal));

        controller.abort();
        const { rejected } = await stateOf(request);
        expect(rejected).toBe(controller.signal.reason);
        expect(rejected.name).toBe('AbortError');
    });

    it('is an Error named AbortError when the signal has no reason', async () => {
        const { pool } = await connected();
        const signal = oldSignal();
        const request = quiet(pool.getConnection(signal));

        signal.abort();
        const { rejected } = await stateOf(request);
        expect(rejected).toBeInstanceOf(Error);
        expect(rejected.name).toBe('AbortError');
    });

    // the three marks the AbortError of Node itself has
    it('gives that Error the name, the code and the message Node uses', async () => {
        const { pool } = await connected();
        const signal = oldSignal();
        const request = quiet(pool.getConnection(signal));

        signal.abort();
        const { name, code, message } = (await stateOf(request)).rejected;
        expect({ name, code, message }).toEqual({
            name: 'AbortError', code: 'ABORT_ERR', message: 'The operation was aborted'
        });
    });

    it('is an Error named AbortError for an aborted signal that has no reason', async () => {
        const { pool, mysqlPool } = await connected();
        const signal = oldSignal();
        signal.aborted = true;

        const { rejected } = await stateOf(pool.getConnection(signal));
        expect(rejected).toBeInstanceOf(Error);
        expect(rejected.name).toBe('AbortError');
        expect(mysqlPool.getConnection).not.toHaveBeenCalled();
    });
});

describe('Pool.getConnection with a signal, and failWaiting', () => {
    it('failWaiting first: the call keeps its error and a later abort does nothing', async () => {
        const { pool } = await connected();
        const controller = new AbortController();
        const outcome: any = {};
        const request = quiet(pool.getConnection(controller.signal, outcome));
        const error = new Error('going down');

        expect(pool.failWaiting(error)).toBe(1);
        controller.abort(new Error('too late'));
        expect((await stateOf(request)).rejected).toBe(error);
        expect(outcome).toEqual({});
    });

    it('abort first: failWaiting does not find the call and fails only the others', async () => {
        const { pool, mysqlPool } = await connected();
        const controller = new AbortController();
        const reason = new Error('gave up');
        const other = jest.fn();
        const request = quiet(pool.getConnection(controller.signal));
        mysqlPool._connectionQueue.push(other);
        controller.abort(reason);
        const error = new Error('going down');

        expect(pool.failWaiting(error)).toBe(1);
        expect(other).toHaveBeenCalledWith(error);
        expect((await stateOf(request)).rejected).toBe(reason);
    });
});

describe('Pool.getConnection aborted when the queue of mysql2 cannot be searched', () => {
    // Each row is a queue that is not the one the pool expects. The request of the call is the
    // only entry, where there is a queue at all
    const queues: [string, (entry: any) => any][] = [
        ['is missing', () => undefined],
        ['is a plain array', entry => [entry]],
        ['has get but not removeOne', entry => Object.assign([entry], { get: () => entry })],
        ['has removeOne but not get', entry => Object.assign([entry], { removeOne: jest.fn() })]
    ];

    it.each(queues)('rejects at the abort and releases on arrival when it %s', async (
        _name, queueOf
    ) => {
        const { pool, mysqlPool } = await connected();
        const logins = loggingIn(mysqlPool);
        const controller = new AbortController();
        const reason = new Error('gave up');
        const request = quiet(pool.getConnection(controller.signal));
        mysqlPool._connectionQueue = queueOf(logins[0]);
        const arrived = connection();

        expect(() => controller.abort(reason)).not.toThrow();
        expect((await stateOf(request)).rejected).toBe(reason);
        logins[0](null, arrived);
        expect(arrived.release).toHaveBeenCalledTimes(1);
    });

    // such a queue is no failure: the pool leaves it alone and says nothing
    it.each(queues)('leaves the queue as it is, with no warning, when it %s', async (
        _name, queueOf
    ) => {
        const { pool, mysqlPool } = await connected();
        const logins = loggingIn(mysqlPool);
        const controller = new AbortController();
        pool.getConnection(controller.signal).catch(() => undefined);
        const queue = mysqlPool._connectionQueue = queueOf(logins[0]);

        controller.abort();
        expect([...(queue ?? [])]).toEqual(queue ? [logins[0]] : []);
        expect(queue?.removeOne ?? jest.fn()).not.toHaveBeenCalled();
        expect(Logger.warn).not.toHaveBeenCalled();
    });

    // mysql2 queues a wrapper of the callback when something traces its pool
    it('leaves a request it cannot find in the queue, and releases on arrival', async () => {
        const { pool, mysqlPool } = await connected();
        mysqlPool.getConnection.mockImplementation((cb: any) => {
            mysqlPool._connectionQueue.push((...args: any[]) => cb(...args));
        });
        const controller = new AbortController();
        const reason = new Error('gave up');
        const request = quiet(pool.getConnection(controller.signal));
        const arrived = connection();

        controller.abort(reason);
        expect((await stateOf(request)).rejected).toBe(reason);
        expect(mysqlPool._connectionQueue).toHaveLength(1);
        mysqlPool._connectionQueue.shift()(null, arrived);
        expect(arrived.release).toHaveBeenCalledTimes(1);
    });

    it('lets no throw out into abort() when the queue throws, and logs the node', async () => {
        const { pool, mysqlPool } = await connected();
        const logins = loggingIn(mysqlPool);
        mysqlPool._connectionQueue.push(jest.fn());
        mysqlPool._connectionQueue.get = () => { throw new Error('queue broke'); };
        const signal = oldSignal();
        const request = quiet(pool.getConnection(signal));
        const arrived = connection();

        expect(() => signal.abort()).not.toThrow();
        expect((await stateOf(request)).rejected.name).toBe('AbortError');
        expect(signal.listeners).toHaveLength(0);
        const [, fields] = (Logger.warn as jest.Mock).mock.calls[0];
        expect(fields).toEqual({ nodeId: 7, pool: 'seven', error: 'queue broke' });
        logins[0](null, arrived);
        expect(arrived.release).toHaveBeenCalledTimes(1);
    });
});
