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

    it('changeUser fails: rejects, never queries, hands back once', async () => {
        const conn = makeConn({ changeUserErr: { code: 'ER_BAD_DB_ERROR' } });
        await expect(makePool(null, conn).query('SELECT 1')).rejects.toBeTruthy();
        expect(conn.query).not.toHaveBeenCalled();
        expect(conn.release.mock.calls.length + conn.destroy.mock.calls.length).toBe(1);
    });

    it('no connection: rejects without touching a connection', async () => {
        await expect(makePool(new Error('no conn'), undefined).query('SELECT 1')).rejects.toThrow('no conn');
    });
});
