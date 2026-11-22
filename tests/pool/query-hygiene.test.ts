jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));
jest.mock('../../src/utils/QueryTimer', () => ({
    QueryTimer: jest.fn().mockImplementation(() => ({
        start: jest.fn(), end: jest.fn(), get: jest.fn(() => 1000)
    }))
}));

import { Pool } from '../../src/pool/Pool';
import Logger from '../../src/utils/Logger';
import Redis from '../../src/Redis/Redis';

type Cb = (err: any, res?: any) => void;

// useErr answers the USE of a query on another database, queryErr the statement
const makeConn = (opts: { useErr?: any, queryErr?: any, rows?: any } = {}) => ({
    changeUser: jest.fn(),
    query: jest.fn((o: any, cb: Cb) => o.sql.startsWith('USE ')
        ? cb(opts.useErr ?? null)
        : cb(opts.queryErr ?? null, opts.rows)),
    reset: jest.fn((cb: Cb) => cb(null)),
    release: jest.fn(),
    destroy: jest.fn()
});

const makePool = (getConnErr: any, conn: any): Pool => {
    const pool = new Pool({
        id: 1, host: '127.0.0.1', port: 3306, name: 'test',
        user: 'u', password: 'p', database: 'd',
        queryTimeout: 1000, resetTimeout: 1000, slowQueryTime: 1, redisFactor: 1, redisExpire: 1,
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

    it('success: resolves rows and releases once, with no change of user and no reset',
        async () => {
            const conn = makeConn({ rows: [{ a: 1 }] });
            await expect(makePool(null, conn).query('SELECT 1')).resolves.toEqual([{ a: 1 }]);
            expect(conn.query.mock.calls.map(([options]) => options.sql)).toEqual(['SELECT 1']);
            expect(conn.release).toHaveBeenCalledTimes(1);
            expect([conn.changeUser, conn.reset, conn.destroy].map(f => f.mock.calls.length))
                .toEqual([0, 0, 0]);
        });

    it('SQL error: rejects, resets and releases once, no slow-query warning, no redis write',
        async () => {
            const conn = makeConn({ queryErr: { code: 'ER_PARSE_ERROR' } });
            // the statement went to the server
            await expect(makePool(null, conn).query('SELEC 1', { redis: true }))
                .rejects.toEqual({ code: 'ER_PARSE_ERROR', sent: true });
            expect(conn.reset).toHaveBeenCalledTimes(1);
            expect(conn.release).toHaveBeenCalledTimes(1);
            expect(conn.reset.mock.invocationCallOrder[0])
                .toBeLessThan(conn.release.mock.invocationCallOrder[0]);
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

    it('another database: USE with the timeout of the query, then the statement', async () => {
        const conn = makeConn({ rows: [{ a: 1 }] });
        await makePool(null, conn).query('SELECT 1', { database: 'other', timeout: 0 });
        // mysql2 keeps the time limit of the USE, 0 is none: the pool adds no timer
        expect(conn.query.mock.calls.map(([options]) => options)).toEqual([
            { sql: 'USE `other`', timeout: 0 }, { sql: 'SELECT 1', timeout: 0 }
        ]);
        expect(conn.changeUser).not.toHaveBeenCalled();
    });

    it('a database option left undefined is the one of the pool: no USE', async () => {
        const conn = makeConn({ rows: [{ a: 1 }] });
        await makePool(null, conn).query('SELECT 1', { database: undefined });
        expect(conn.query.mock.calls.map(([options]) => options.sql)).toEqual(['SELECT 1']);
    });

    it('USE fails: rejects with sent false, never sends the statement, resets', async () => {
        const conn = makeConn({ useErr: { code: 'ER_BAD_DB_ERROR', errno: 1049 } });
        await expect(makePool(null, conn).query('SELECT 1', { database: 'nope' }))
            .rejects.toEqual({ code: 'ER_BAD_DB_ERROR', errno: 1049, sent: false });
        expect(conn.query).toHaveBeenCalledTimes(1);
        expect(conn.reset).toHaveBeenCalledTimes(1);
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('USE times out: rejects with sent false, never sends the statement, destroys', async () => {
        const conn = makeConn({ useErr: { code: 'PROTOCOL_SEQUENCE_TIMEOUT' } });
        await expect(makePool(null, conn).query('SELECT 1', { database: 'other' }))
            .rejects.toMatchObject({ code: 'PROTOCOL_SEQUENCE_TIMEOUT', sent: false });
        expect(conn.query).toHaveBeenCalledTimes(1);
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect([conn.reset, conn.release].map(f => f.mock.calls.length)).toEqual([0, 0]);
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
