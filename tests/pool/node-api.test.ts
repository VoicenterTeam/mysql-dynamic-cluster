jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn() }
}));
// a mysql2 pool that opens nothing. Its three lists are the ones mysql2 keeps: every
// connection, the free ones, and the callbacks that wait for a connection
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => ({
            on: jest.fn(), end: jest.fn(), getConnection: jest.fn(),
            _allConnections: [], _freeConnections: [], _connectionQueue: []
        })),
        createConnection: jest.fn()
    }
}));

import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Logger from '../../src/utils/Logger';
import Metrics from '../../src/metrics/Metrics';

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
    return new Pool({ id: 1, ...host }, 'test');
};

// the pool with its mysql2 pool created, and that mysql2 pool
const connected = async (): Promise<{ pool: any, mysqlPool: any }> => {
    const pool = makePool();
    // the status check of connect() asks through this
    const query = pool.query;
    pool.query = jest.fn().mockResolvedValue([]);
    await pool.connect();
    pool.status.stopTimerCheck();
    pool.query = query;
    return { pool, mysqlPool: pool._pool };
};

describe('Pool.getConnection', () => {
    beforeEach(() => jest.clearAllMocks());

    it('resolves with the connection mysql2 hands out, untouched, with no metric', async () => {
        const { pool, mysqlPool } = await connected();
        const connection = {
            changeUser: jest.fn(), query: jest.fn(), reset: jest.fn(),
            release: jest.fn(), destroy: jest.fn()
        };
        mysqlPool.getConnection.mockImplementation((cb: any) => cb(null, connection));

        expect(await pool.getConnection()).toBe(connection);
        expect(mysqlPool.getConnection).toHaveBeenCalledTimes(1);
        Object.values(connection).forEach(method => expect(method).not.toHaveBeenCalled());
        expect(Metrics.recordOperation).not.toHaveBeenCalled();
    });

    it('rejects with the error object of mysql2', async () => {
        const { pool, mysqlPool } = await connected();
        const error = Object.assign(new Error('Pool is closed.'), { code: 'X' });
        mysqlPool.getConnection.mockImplementation((cb: any) => cb(error));

        expect(await pool.getConnection().catch((e: any) => e)).toBe(error);
        expect(mysqlPool.getConnection).toHaveBeenCalledTimes(1);
    });

    it('rejects with POOL_NOT_CONNECTED before connect() created the mysql2 pool', async () => {
        const failure = await makePool().getConnection().catch((e: any) => e);

        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBe('POOL_NOT_CONNECTED');
    });
});

describe('Pool.failWaiting', () => {
    beforeEach(() => jest.clearAllMocks());

    it('fails every waiting request with the error and returns how many', async () => {
        const { pool, mysqlPool } = await connected();
        const waiting = [jest.fn(), jest.fn(), jest.fn()];
        mysqlPool._connectionQueue.push(...waiting);
        const error = new Error('going down');

        expect(pool.failWaiting(error)).toBe(3);
        waiting.forEach(callback => {
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0]).toEqual([error]);
            expect(callback.mock.calls[0][0]).toBe(error);
        });
        expect(mysqlPool._connectionQueue).toHaveLength(0);
    });

    it('fails a request of the pool itself that waits for a connection', async () => {
        const { pool, mysqlPool } = await connected();
        mysqlPool.getConnection.mockImplementation((cb: any) => {
            mysqlPool._connectionQueue.push(cb);
        });
        const requested = pool.getConnection();
        const error = new Error('going down');

        expect(pool.failWaiting(error)).toBe(1);
        expect(await requested.catch((e: any) => e)).toBe(error);
    });

    it('does not fail a request that a failed callback queues again', async () => {
        const { pool, mysqlPool } = await connected();
        const again = jest.fn();
        const first = jest.fn(() => { mysqlPool._connectionQueue.push(again); });
        mysqlPool._connectionQueue.push(first, jest.fn());

        expect(pool.failWaiting(new Error('going down'))).toBe(2);
        expect(again).not.toHaveBeenCalled();
        expect(mysqlPool._connectionQueue).toEqual([again]);
    });

    it('fails the other requests when one callback throws, and logs what it threw', async () => {
        const { pool, mysqlPool } = await connected();
        const last = jest.fn();
        const broken = jest.fn(() => { throw new Error('callback broke'); });
        mysqlPool._connectionQueue.push(broken, last);
        const error = new Error('going down');

        expect(pool.failWaiting(error)).toBe(2);
        expect(last).toHaveBeenCalledWith(error);
        expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('callback broke'));
    });

    it('leaves the connections in use and the free ones as they were', async () => {
        const { pool, mysqlPool } = await connected();
        const [busy, free] = [{ id: 'busy' }, { id: 'free' }];
        mysqlPool._allConnections.push(busy, free);
        mysqlPool._freeConnections.push(free);
        mysqlPool._connectionQueue.push(jest.fn());

        pool.failWaiting(new Error('going down'));
        expect(mysqlPool._allConnections).toEqual([busy, free]);
        expect(mysqlPool._freeConnections).toEqual([free]);
        expect(mysqlPool.end).not.toHaveBeenCalled();
    });

    it('returns 0 when nothing waits', async () => {
        const { pool } = await connected();
        expect(pool.failWaiting(new Error('going down'))).toBe(0);
    });

    it('returns 0 before connect() created the mysql2 pool', () => {
        expect(makePool().failWaiting(new Error('going down'))).toBe(0);
    });
});

describe('Pool.stats', () => {
    it('counts connections in use, free connections and waiting requests', async () => {
        const { pool, mysqlPool } = await connected();
        mysqlPool._allConnections.push(1, 2, 3, 4, 5);
        mysqlPool._freeConnections.push(4, 5);
        mysqlPool._connectionQueue.push(jest.fn(), jest.fn(), jest.fn());

        expect(pool.stats()).toEqual({ used: 3, idle: 2, pending: 3 });
    });

    it('is all zeros for a connected pool that opened nothing yet', async () => {
        expect((await connected()).pool.stats()).toEqual({ used: 0, idle: 0, pending: 0 });
    });

    it('is all zeros before connect() created the mysql2 pool', () => {
        expect(makePool().stats()).toEqual({ used: 0, idle: 0, pending: 0 });
    });
});
