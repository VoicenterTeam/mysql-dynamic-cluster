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

import { Pool } from '../../src/pool/Pool';

type Cb = (err: any, res?: any) => void;

// queries answer asynchronously so a commit issued before they finish is caught
const makeConn = (opts: { changeUserErr?: any, beginErr?: any, queryErrs?: Record<string, any>, commitErr?: any } = {}) => {
    const log: string[] = [];
    const conn = {
        log,
        changeUser: jest.fn((_o: any, cb: Cb) => setImmediate(() => cb(opts.changeUserErr ?? null))),
        beginTransaction: jest.fn((cb: Cb) => setImmediate(() => { log.push('begin'); cb(opts.beginErr ?? null); })),
        query: jest.fn((o: any, cb: Cb) => setImmediate(() => {
            log.push(o.sql);
            const err = opts.queryErrs?.[o.sql];
            cb(err ?? null, err ? undefined : { sql: o.sql });
        })),
        commit: jest.fn((cb: Cb) => setImmediate(() => { log.push('commit'); cb(opts.commitErr ?? null); })),
        rollback: jest.fn((cb: () => void) => setImmediate(() => { log.push('rollback'); cb(); })),
        release: jest.fn(),
        destroy: jest.fn()
    };
    return conn;
};

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
        expect(conn.commit).not.toHaveBeenCalled();
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(conn.destroy).not.toHaveBeenCalled();
    });

    it('fatal error or timeout: destroys the connection without rollback', async () => {
        for (const err of [{ code: 'ECONNRESET', fatal: true }, { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }]) {
            const conn = makeConn({ queryErrs: { A: err } });
            await expect(makePool(null, conn).multiStatementQuery(['A', 'B'], {})).rejects.toEqual(err);
            expect(conn.commit).not.toHaveBeenCalled();
            expect(conn.rollback).not.toHaveBeenCalled();
            expect(conn.destroy).toHaveBeenCalledTimes(1);
            expect(conn.release).not.toHaveBeenCalled();
        }
    });

    it('commit error: rolls back, rejects, releases once', async () => {
        const conn = makeConn({ commitErr: { code: 'ER_LOCK_DEADLOCK' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toEqual({ code: 'ER_LOCK_DEADLOCK' });
        expect(conn.rollback).toHaveBeenCalledTimes(1);
        expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('changeUser fails: no transaction, hands back once', async () => {
        const conn = makeConn({ changeUserErr: { code: 'ER_BAD_DB_ERROR' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toBeTruthy();
        expect(conn.beginTransaction).not.toHaveBeenCalled();
        expect(conn.query).not.toHaveBeenCalled();
        expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('beginTransaction fails: no queries, hands back once', async () => {
        const conn = makeConn({ beginErr: { code: 'ER_UNKNOWN' } });
        await expect(makePool(null, conn).multiStatementQuery(['A'], {})).rejects.toBeTruthy();
        expect(conn.query).not.toHaveBeenCalled();
        expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('no connection: rejects without touching a connection', async () => {
        await expect(makePool(new Error('no conn'), undefined).multiStatementQuery(['A'], {})).rejects.toThrow('no conn');
    });
});
