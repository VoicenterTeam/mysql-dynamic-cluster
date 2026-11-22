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

import { Pool } from '../../src/pool/Pool';

type Cb = (err: any, res?: any) => void;

// queries answer asynchronously so a commit issued before they finish is caught
// useErr answers the USE of a transaction on another database
const makeConn = (opts: {
    useErr?: any, beginErr?: any, queryErrs?: Record<string, any>, commitErr?: any,
    rollbackErr?: any
} = {}) => {
    const log: string[] = [];
    const conn = {
        log,
        changeUser: jest.fn(),
        reset: jest.fn((cb: Cb) => setImmediate(() => {
            log.push('reset');
            cb(null);
        })),
        query: jest.fn((o: any, cb: Cb) => setImmediate(() => {
            if (o.sql.startsWith('USE ')) {
                log.push(o.sql);
                return cb(opts.useErr ?? null);
            }
            if (o.sql === 'ROLLBACK') {
                log.push('rollback');
                return cb(opts.rollbackErr ?? null);
            }
            if (o.sql === 'START TRANSACTION') {
                log.push('begin');
                return cb(opts.beginErr ?? null);
            }
            if (o.sql === 'COMMIT') {
                log.push('commit');
                return cb(opts.commitErr ?? null);
            }
            log.push(o.sql);
            const err = opts.queryErrs?.[o.sql];
            cb(err ?? null, err ? undefined : { sql: o.sql });
        })),
        release: jest.fn(),
        destroy: jest.fn()
    };
    return conn;
};

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

describe('Pool.multiStatementQuery', () => {
    it('runs queries in order, commits after the last one, resolves results in order, releases once', async () => {
        const conn = makeConn();
        const res = await makePool(null, conn).multiStatementQuery(['A', 'B', 'C'], {});
        expect(res).toEqual([{ sql: 'A' }, { sql: 'B' }, { sql: 'C' }]);
        expect(conn.log).toEqual(['begin', 'A', 'B', 'C', 'commit']);
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('SQL error: stops, rolls back, never commits, releases once', async () => {
        const conn = makeConn({ queryErrs: { B: { code: 'ER_PARSE_ERROR' } } });
        await expect(makePool(null, conn).multiStatementQuery(['A', 'B', 'C'], {})).rejects.toEqual({ code: 'ER_PARSE_ERROR' });
        expect(conn.log).toEqual(['begin', 'A', 'B', 'rollback']);
        expect(conn.log).not.toContain('commit');
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('fatal error or timeout: destroys the connection without rollback', async () => {
        for (const err of [{ code: 'ECONNRESET', fatal: true }, { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }]) {
            const conn = makeConn({ queryErrs: { A: err } });
            await expect(makePool(null, conn).multiStatementQuery(['A', 'B'], {})).rejects.toEqual(err);
            expect(conn.log).not.toContain('commit');
            expect(conn.log).not.toContain('rollback');
            expect(conn.destroy).toHaveBeenCalledTimes(1);
            expect(conn.release).not.toHaveBeenCalled();
        }
    });

    it('commit error: rolls back, rejects, releases once', async () => {
        const conn = makeConn({ commitErr: { code: 'ER_LOCK_DEADLOCK' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toEqual({ code: 'ER_LOCK_DEADLOCK' });
        expect(conn.log).toEqual(['begin', 'A', 'commit', 'rollback']);
        expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('START TRANSACTION and COMMIT are sent with the query timeout', async () => {
        const conn = makeConn();
        await makePool(null, conn).multiStatementQuery(['A'], { timeout: 700 });
        expect(conn.query).toHaveBeenCalledWith({ sql: 'START TRANSACTION', timeout: 700 }, expect.any(Function));
        expect(conn.query).toHaveBeenCalledWith({ sql: 'COMMIT', timeout: 700 }, expect.any(Function));
    });

    it('COMMIT times out: destroys without rollback', async () => {
        const conn = makeConn({ commitErr: { code: 'PROTOCOL_SEQUENCE_TIMEOUT' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toBeTruthy();
        expect(conn.log).not.toContain('rollback');
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('rollback fails: destroys instead of releasing, rejects with the original error', async () => {
        const conn = makeConn({ queryErrs: { A: { code: 'ER_PARSE_ERROR' } }, rollbackErr: { code: 'ER_UNKNOWN' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toEqual({ code: 'ER_PARSE_ERROR' });
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('rollback is sent with the query timeout', async () => {
        const conn = makeConn({ queryErrs: { A: { code: 'ER_PARSE_ERROR' } } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], { timeout: 700 })).rejects.toBeTruthy();
        expect(conn.query).toHaveBeenLastCalledWith({ sql: 'ROLLBACK', timeout: 700 }, expect.any(Function));
    });

    it('another database: USE with the timeout, then the transaction, no change of user',
        async () => {
            const conn = makeConn();
            await makePool(null, conn).multiStatementQuery(['A'], { database: 'h', timeout: 700 });
            expect(conn.query.mock.calls[0][0]).toEqual({ sql: 'USE `h`', timeout: 700 });
            expect(conn.log).toEqual(['USE `h`', 'begin', 'A', 'commit']);
            expect(conn.changeUser).not.toHaveBeenCalled();
            expect(conn.release).toHaveBeenCalledTimes(1);
        });

    it('USE fails: no transaction, resets and releases once', async () => {
        const conn = makeConn({ useErr: { code: 'ER_BAD_DB_ERROR', errno: 1049 } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], { database: 'nope' }))
            .rejects.toMatchObject({ errno: 1049 });
        // the release waits for the answer of the reset
        await new Promise(setImmediate);
        expect(conn.log).toEqual(['USE `nope`', 'reset']);
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('USE times out: no transaction, destroys', async () => {
        const conn = makeConn({ useErr: { code: 'PROTOCOL_SEQUENCE_TIMEOUT' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], { database: 'h' }))
            .rejects.toMatchObject({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
        expect(conn.log).toEqual(['USE `h`']);
        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(conn.release).not.toHaveBeenCalled();
    });

    it('START TRANSACTION fails: no statements, hands back once', async () => {
        const conn = makeConn({ beginErr: { code: 'ER_UNKNOWN' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toBeTruthy();
        expect(conn.log).toEqual(['begin']);
        expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('no connection: rejects without touching a connection', async () => {
        await expect(makePool(new Error('no conn'), undefined).multiStatementQuery(['A'], {})).rejects.toThrow('no conn');
    });
});
