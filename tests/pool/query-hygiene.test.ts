jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { inc: jest.fn(), mark: jest.fn(), set: jest.fn(), avg: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));
jest.mock('../../src/utils/QueryTimer', () => ({
    QueryTimer: jest.fn().mockImplementation(() => ({
        start: jest.fn(), end: jest.fn(), save: jest.fn(), get: jest.fn(() => 1000)
    }))
}));

import { Pool } from '../../src/pool/Pool';
import Logger from '../../src/utils/Logger';
import Redis from '../../src/Redis/Redis';

type Cb = (err: any, res?: any) => void;

const makeConn = (opts: { changeUserErr?: any, queryErr?: any, rows?: any } = {}) => ({
    changeUser: jest.fn((_o: any, cb: Cb) => cb(opts.changeUserErr ?? null)),
    query: jest.fn((_o: any, cb: Cb) => cb(opts.queryErr ?? null, opts.rows)),
    release: jest.fn(),
    destroy: jest.fn()
});

const makePool = (getConnErr: any, conn: any): Pool => {
    const pool = new Pool({
        id: 1, host: '127.0.0.1', port: 3306, name: 'test',
        user: 'u', password: 'p', database: 'd',
        queryTimeout: 1000, slowQueryTime: 1, redisFactor: 1, redisExpire: 1,
        connectionLimit: 10, minConnections: 0, idleTimeout: 30000, idleCheckInterval: 10000,
        validators: [], loadFactors: [], timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
    } as any, 'cluster');
    (pool as any)._pool = { getConnection: jest.fn((cb: Cb) => cb(getConnErr, conn)) };
    return pool;
};

describe('Pool.availableConnectionCount', () => {
    it('is the limit minus connections in use, read from mysql2', () => {
        const pool = makePool(null, undefined);
        (pool as any)._pool = { _allConnections: { length: 3 }, _freeConnections: { length: 1 } };
        expect(pool.availableConnectionCount).toBe(8);
        expect(pool.status.availableConnectionCount).toBe(8);
    });

    it('is unlimited when connectionLimit is 0 (mysql2: no limit)', () => {
        const pool = makePool(null, undefined);
        (pool as any).connectionLimit = 0;
        (pool as any)._pool = { _allConnections: { length: 3 }, _freeConnections: { length: 1 } };
        expect(pool.availableConnectionCount).toBe(Infinity);
    });

    it('is the limit before the pool is created', () => {
        const pool = makePool(null, undefined);
        (pool as any)._pool = undefined;
        expect(pool.availableConnectionCount).toBe(10);
    });
});

describe('Pool.query connection hygiene', () => {
    beforeEach(() => jest.clearAllMocks());

    it('success: resolves rows and releases once', async () => {
        const conn = makeConn({ rows: [{ a: 1 }] });
        await expect(makePool(null, conn).query('SELECT 1')).resolves.toEqual([{ a: 1 }]);
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('SQL error: rejects, releases once, no slow-query warning, no redis write', async () => {
        const conn = makeConn({ queryErr: { code: 'ER_PARSE_ERROR' } });
        await expect(makePool(null, conn).query('SELEC 1', { redis: true })).rejects.toEqual({ code: 'ER_PARSE_ERROR' });
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
        expect(Logger.warn).not.toHaveBeenCalled();
        expect(Redis.set).not.toHaveBeenCalled();
    });

    it('fatal error: rejects and destroys the connection', async () => {
        const conn = makeConn({ queryErr: { code: 'ECONNRESET', fatal: true } });
        await expect(makePool(null, conn).query('SELECT 1')).rejects.toBeTruthy();
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('timeout: rejects and destroys the connection', async () => {
        const conn = makeConn({ queryErr: { code: 'PROTOCOL_SEQUENCE_TIMEOUT' } });
        await expect(makePool(null, conn).query('SELECT 1')).rejects.toBeTruthy();
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('changeUser fails: rejects, never queries, destroys once', async () => {
        // mysql2 marks every changeUser error fatal
        const conn = makeConn({ changeUserErr: { code: 'ER_BAD_DB_ERROR', fatal: true } });
        await expect(makePool(null, conn).query('SELECT 1')).rejects.toBeTruthy();
        expect(conn.query).not.toHaveBeenCalled();
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('changeUser never answers: rejects after the query timeout, destroys, ignores a late answer', async () => {
        jest.useFakeTimers();
        try {
            let late: Cb;
            const conn = makeConn();
            conn.changeUser.mockImplementation((_o: any, cb: Cb) => { late = cb; });
            const p = makePool(null, conn).query('SELECT 1', { timeout: 500 });
            jest.advanceTimersByTime(500);
            await expect(p).rejects.toMatchObject({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
            late(null);
            expect(conn.query).not.toHaveBeenCalled();
            expect(conn.destroy).toHaveBeenCalledTimes(1);
            expect(conn.release).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it('timeout 0 means no timeout: a slow changeUser still succeeds', async () => {
        const conn = makeConn({ rows: [{ a: 1 }] });
        conn.changeUser.mockImplementation((_o: any, cb: Cb) => { setTimeout(() => cb(null), 5); });
        await expect(makePool(null, conn).query('SELECT 1', { timeout: 0 })).resolves.toEqual([{ a: 1 }]);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('error callback fired twice: settles and hands back only once', async () => {
        const conn = makeConn();
        conn.query.mockImplementation((_o: any, cb: Cb) => {
            cb({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
            cb({ code: 'ECONNRESET', fatal: true });
        });
        await expect(makePool(null, conn).query('SELECT 1')).rejects.toMatchObject({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('no connection: rejects without touching a connection', async () => {
        await expect(makePool(new Error('no conn'), undefined).query('SELECT 1')).rejects.toThrow('no conn');
    });

    it('no error and no connection: rejects', async () => {
        await expect(makePool(null, undefined).query('SELECT 1')).rejects.toThrow("Can't find connection");
    });
});
