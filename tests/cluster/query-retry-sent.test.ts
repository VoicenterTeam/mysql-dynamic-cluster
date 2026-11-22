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

import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import { Pool } from '../../src/pool/Pool';
import Logger from '../../src/utils/Logger';

// How query() knows whether the statement went to a node: Pool.query() says so in the
// outcome the caller hands in, and on the error when the error can take it. An error that
// cannot, such as a frozen one, or one the app handed failWaiting() for many queries at
// once, is still decided by what the pool knew
type Cb = (...args: any[]) => void;

// `use` answers the USE of a query on another database, `reset` a reset
const conn = (
    statement: (cb: Cb) => void, use = (cb: Cb) => cb(null), reset = (cb: Cb) => cb(null)
) => ({
    query: jest.fn((options: { sql: string }, cb: Cb) =>
        options.sql.startsWith('USE ') ? use(cb) : statement(cb)),
    reset: jest.fn(reset),
    release: jest.fn(),
    destroy: jest.fn(),
    stream: { destroy: jest.fn() },
    on: jest.fn(),
    removeListener: jest.fn()
});

// A real Pool whose mysql2 pool answers getConnection() as `connection` says. The pool with
// the lower id has the lower load score
const makePool = (id: number, connection?: (cb: Cb) => void): Pool => {
    const pool = new Pool({
        id, host: '10.0.0.' + id, port: 3306, name: 'node' + id,
        user: 'u', password: 'p', database: 'd',
        queryTimeout: 1000, resetTimeout: 20, slowQueryTime: 1000, redisFactor: 1, redisExpire: 1,
        connectionLimit: 10, minConnections: 0, idleTimeout: 30000, idleCheckInterval: 10000,
        validators: [], loadFactors: [], timerCheckRange: { start: 1000, end: 10000 },
        timerCheckMultiplier: 2
    } as any, 'c');
    if (connection) (pool as any)._pool = { getConnection: jest.fn(connection) };
    (pool.status as any)._isValid = true;
    (pool.status as any)._loadScore = id;
    return pool;
};

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[], hashing: object = { connected: false }): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: hashing
    });

const settle = (promise: Promise<any>): Promise<{ result?: any, error?: any }> =>
    promise.then(result => ({ result }), error => ({ error }));

const ROWS = [{ a: 1 }];
const handsOut = (connection: object) => (cb: Cb) => cb(null, connection);
const answers = handsOut(conn(cb => cb(null, ROWS)));

beforeEach(() => jest.clearAllMocks());

describe('Pool.query() says whether the statement was sent', () => {
    const failure = () => Object.assign(new Error('failed'), { code: 'X' });
    it.each([
        ['the pool is not connected', undefined, false],
        ['getConnection() failed', (cb: Cb) => cb(failure()), false],
        ['no connection came', (cb: Cb) => cb(null, null), false],
        ['the USE failed', handsOut(conn(cb => cb(null, ROWS), cb => cb(failure()))), false],
        ['the USE timed out', handsOut(conn(
            cb => cb(null, ROWS), cb => cb({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' })
        )), false],
        ['the statement failed', handsOut(conn(cb => cb(failure()))), true],
        ['the statement timed out',
            handsOut(conn(cb => cb({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }))), true]
    ])('%s: sent is %p', async (_name, connection, sent) => {
        const outcome: any = {};
        const { error } = await settle(
            makePool(1, connection).query('UPDATE t', { timeout: 20, database: 'x' }, outcome)
        );

        expect([outcome.sent, error.sent]).toEqual([sent, sent]);
    });

    // the app had the connection, so it is reset before the statement
    it.each([
        ['failed', (cb: Cb) => cb(failure())],
        ['ran out of resetTimeout', () => undefined]
    ])('the reset of a connection the app had %s: sent is false', async (_name, reset) => {
        const connection = conn(cb => cb(null, ROWS), undefined, reset);
        const pool = makePool(1, handsOut(connection));
        pool.lend(connection as any);
        const outcome: any = {};
        const { error } = await settle(pool.query('UPDATE t', {}, outcome));

        expect([outcome.sent, error.sent]).toEqual([false, false]);
        expect(connection.query).not.toHaveBeenCalled();
        expect(connection.destroy).toHaveBeenCalled();
    });

    it('a statement that passed: sent is true in the outcome', async () => {
        const outcome: any = {};
        await makePool(1, answers).query('UPDATE t', {}, outcome);

        expect(outcome).toEqual({ sent: true });
    });
});

describe('the health check of a node without a healthCheck block', () => {
    it('asks through Pool.query() and reports a failure as before', async () => {
        const denied = Object.assign(new Error('Access denied'), {
            code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000'
        });
        const pool = makePool(1, cb => cb(denied));
        pool.status.active = true;
        try {
            await pool.status.checkStatus();
        } finally {
            pool.status.stopTimerCheck();
        }

        // reduced to the three fields: sent is on the error, not in what the node reports
        expect(pool.checkError).toStrictEqual(
            { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }
        );
        expect((denied as any).sent).toBe(false);
    });
});

describe('an error that cannot take sent', () => {
    const frozen = () => Object.freeze(Object.assign(new Error('frozen'), { code: 'X' }));

    it('from getConnection(), as failWaiting() hands it out: the next node is tried', async () => {
        const error = frozen();
        const second = makePool(2, answers);
        const { result } = await settle(
            makeCluster([makePool(1, cb => cb(error)), second]).query('UPDATE t')
        );

        expect(result).toEqual(ROWS);
        expect((error as any).sent).toBeUndefined();
    });

    it('from the statement: the next node is not tried', async () => {
        const error = frozen();
        const second = makePool(2, answers);
        const { error: rejected } = await settle(
            makeCluster([makePool(1, handsOut(conn(cb => cb(error)))), second]).query('UPDATE t')
        );

        expect(rejected).toBe(error);
        expect((second as any)._pool.getConnection).not.toHaveBeenCalled();
    });
});

// A node whose query() rejects with `error` and says in the outcome whether it was sent, as
// Pool.query() does. `sent` undefined: a node that tells nothing
const node = (id: number, error: unknown, sent?: boolean): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore: id },
    query: jest.fn((_sql: string, _options: object, outcome: any) => {
        if (sent !== undefined) outcome.sent = sent;
        return Promise.reject(error);
    })
});
const passes = (id: number): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore: id },
    query: jest.fn(() => Promise.resolve(ROWS))
});
const withErrno = (errno: number) => Object.assign(new Error('errno ' + errno), { errno });

describe('which errors let query() try the next node', () => {
    it.each([1045, 1698, 1044, 3118, 3955, 1130])(
        'a login refused with %p is not tried again, although it was not sent', async errno => {
            const second = passes(2);
            const { error } = await settle(
                makeCluster([node(1, withErrno(errno), false), second]).query('UPDATE t')
            );

            expect(error.errno).toBe(errno);
            expect(second.query).not.toHaveBeenCalled();
        }
    );

    // on the list of the health check, not on this one: they can differ from node to node
    it.each([1049, 1129])('%p before the statement went out: the next node is tried',
        async errno => {
            const second = passes(2);
            await makeCluster([node(1, withErrno(errno), false), second]).query('UPDATE t');

            expect(second.query).toHaveBeenCalledTimes(1);
        }
    );

    it('1047 is tried again, also from a node that tells nothing', async () => {
        const second = passes(2);
        await makeCluster([node(1, withErrno(1047)), second]).query('UPDATE t');

        expect(second.query).toHaveBeenCalledTimes(1);
    });

    it('1047 before the statement went out is tried again with retryNotReady: false', async () => {
        const second = passes(2);
        await makeCluster([node(1, withErrno(1047), false), second])
            .query('UPDATE t', undefined, { retryNotReady: false });

        expect(second.query).toHaveBeenCalledTimes(1);
    });

    it('any other error of a node that tells nothing is not tried again', async () => {
        const second = passes(2);
        await settle(makeCluster([node(1, new Error('down')), second]).query('UPDATE t'));

        expect(second.query).not.toHaveBeenCalled();
    });
});

describe('the statement passed and the update of the hashing table threw', () => {
    it('query() resolves with the result, logs a warning and runs the statement once', async () => {
        const first = passes(1);
        const second = passes(2);
        const hashing = {
            connected: true,
            getNodeByService: (): undefined => undefined,
            updateNodeForService: jest.fn(() => Promise.reject(new Error('hashing down')))
        };
        const cluster = makeCluster([first, second], hashing);

        await expect(cluster.query('UPDATE t', undefined, { serviceId: 7 })).resolves.toBe(ROWS);
        expect([first.query.mock.calls.length, second.query.mock.calls.length]).toEqual([1, 0]);
        expect(Logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('hashing'), expect.anything()
        );
    });
});
