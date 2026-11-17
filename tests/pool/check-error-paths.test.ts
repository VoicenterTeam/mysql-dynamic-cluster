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
// a mysql2 pool that opens nothing. Each test puts its own getConnection there
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
import Events from '../../src/utils/Events';

// Every way a health check of a real Pool can fail, and what checkError holds after each.
// The errors a test hands to a callback of the mysql2 pool stand for the ones mysql2 makes
type Cb = (err: any, res?: any) => void;
const TIMEOUT = 1000;

// flags are set, so connect() asks no server. No validators: an answered check is a valid pool
const makePool = (): any => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: 'db.example' }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], queryTimeout: TIMEOUT,
            validators: [], loadFactors: [], timerCheckRange: { start: TIMEOUT, end: 10000 }
        }
    } as any).hosts[0];
    return new Pool({ id: 1, ...host }, 'test');
};

// mysql2 calls back later, never inside getConnection, changeUser or query
const later = (call: () => void) => { Promise.resolve().then(call); };
const makeConn = (opts: { changeUserErr?: any, queryErr?: any, hangs?: 'changeUser' } = {}) => ({
    changeUser: jest.fn((_o: any, cb: Cb) => {
        if (opts.hangs !== 'changeUser') later(() => cb(opts.changeUserErr ?? null));
    }),
    query: jest.fn((_o: any, cb: Cb) => later(() => cb(opts.queryErr ?? null, []))),
    release: jest.fn(),
    destroy: jest.fn()
});
// a pool whose mysql2 pool exists and hands out what the test says
const poolWith = (getConnection: (cb: Cb) => void): any => {
    const pool = makePool();
    pool._pool = { getConnection: jest.fn(getConnection), end: jest.fn(), _connectionQueue: [] };
    return pool;
};
const handsOut = (conn: any, err: any = null) => poolWith(cb => later(() => cb(err, conn)));

// the errors the checks failed with, as pool_check_failed hands them out. A test that wants
// to act on a failed check, as a listener of an app would, sets onFailed
let failed: any[];
let onFailed: () => void;
Events.on('pool_check_failed', ([error]: any[]) => {
    failed.push(error);
    onFailed();
});

// one health check of the pool, then what it reports
const check = async (pool: any) => {
    pool.status.active = true;
    await pool.status.checkStatus();
    pool.status.stopTimerCheck();
    return pool.checkError;
};
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const accessDenied = () => Object.assign(
    new Error("Access denied for user 'u'@'192.0.2.5' (using password: YES)"),
    { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }
);
// what mysql2 makes when its own timeout option of a query runs out
const driverTimeout = () => Object.assign(new Error('Query inactivity timeout'), {
    errorno: 'PROTOCOL_SEQUENCE_TIMEOUT', code: 'PROTOCOL_SEQUENCE_TIMEOUT', syscall: 'query'
});

beforeEach(() => {
    jest.clearAllMocks();
    failed = [];
    onFailed = () => undefined;
});

describe('checkError after a failure the package makes itself', () => {
    // POOL_NOT_CONNECTED is a code of the package, so it is not passed on
    it('is empty for a check that finds no mysql2 pool', async () => {
        const pool = makePool();

        expect(await check(pool)).toStrictEqual({});
        expect(failed.map(error => error.code)).toEqual(['POOL_NOT_CONNECTED']);
    });

    it('is empty when mysql2 hands out neither an error nor a connection', async () => {
        expect(await check(handsOut(undefined))).toStrictEqual({});
        expect(failed[0].message).toContain("Can't find connection");
    });

    it('is empty for the timer of the package around the change of database', async () => {
        jest.useFakeTimers();
        const conn = makeConn({ hangs: 'changeUser' });
        const pool = handsOut(conn);
        const query = pool.query('SELECT 1').catch((e: any) => e);
        await turns();
        jest.advanceTimersByTime(TIMEOUT);
        const timeout = await query;
        jest.useRealTimers();
        // the query of a caller still fails with the code, and the connection is destroyed
        expect(timeout.code).toBe('PROTOCOL_SEQUENCE_TIMEOUT');
        expect(conn.destroy).toHaveBeenCalledTimes(1);

        pool.query = jest.fn().mockRejectedValue(timeout);
        expect(await check(pool)).toStrictEqual({});
    });

    it('is empty for an error the app passed to failWaiting, whatever its code', async () => {
        const pool = poolWith(cb => pool._pool._connectionQueue.push(cb));
        const leaving = Object.assign(new Error('leaving'), { code: 'MDC_NO_NODE_AVAILABLE' });
        const checking = check(pool);
        const request = pool.getConnection().catch((e: any) => e);

        expect(pool.failWaiting(leaving)).toBe(2);
        expect(await checking).toStrictEqual({});
        expect(failed).toEqual([leaving]);
        // a waiting request of the app still gets the error with its code
        expect((await request).code).toBe('MDC_NO_NODE_AVAILABLE');
    });

    it('is empty for a non-Error value passed to failWaiting of the pool', async () => {
        const pool = poolWith(cb => pool._pool._connectionQueue.push(cb));
        const checking = check(pool);

        expect(pool.failWaiting('going down')).toBe(1);
        expect(await checking).toStrictEqual({});
    });
});

describe('checkError after a failure mysql2, the socket or the server made', () => {
    it.each([
        ['a refused login when the connection is opened', () => handsOut(undefined, accessDenied()),
            { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }],
        ['the connect timeout of mysql2', () => handsOut(undefined, Object.assign(
            new Error('connect ETIMEDOUT'),
            { errorno: 'ETIMEDOUT', code: 'ETIMEDOUT', syscall: 'connect', fatal: true }
        )), { code: 'ETIMEDOUT' }],
        ['a connect timeout of the socket', () => handsOut(undefined, Object.assign(
            new Error('connect ETIMEDOUT 192.0.2.5:3306'),
            { errno: -110, code: 'ETIMEDOUT', syscall: 'connect', fatal: true }
        )), { code: 'ETIMEDOUT', errno: -110 }],
        ['a server that closed the connection', () => handsOut(undefined, Object.assign(
            new Error('Connection lost: The server closed the connection.'),
            { fatal: true, code: 'PROTOCOL_CONNECTION_LOST' }
        )), { code: 'PROTOCOL_CONNECTION_LOST' }],
        ['a refused change of database', () => handsOut(makeConn({ changeUserErr: Object.assign(
            new Error("Unknown database 'd'"),
            { code: 'ER_BAD_DB_ERROR', errno: 1049, sqlState: '42000', fatal: true }
        ) })), { code: 'ER_BAD_DB_ERROR', errno: 1049, sqlState: '42000' }],
        ['a refused status query', () => handsOut(makeConn({ queryErr: Object.assign(
            new Error('Access denied; you need the PROCESS privilege'),
            { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR', errno: 1227, sqlState: '42000' }
        ) })), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR', errno: 1227, sqlState: '42000' }],
        // mysql2 made this one, so it is passed on. It is not a refused login
        ['the query timeout of mysql2', () => handsOut(makeConn({ queryErr: driverTimeout() })),
            { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }]
    ])('holds what came with %s', async (_name, make, expected) => {
        expect(await check(make())).toStrictEqual(expected);
    });
});

describe('a health check that runs out of time', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // like mysql2: the timer of the query starts when the query is sent, and calls back once
    const silentConn = () => {
        const conn = makeConn();
        conn.query.mockImplementation((options: any, cb: Cb) => {
            setTimeout(() => cb(driverTimeout()), options.timeout);
        });
        return conn;
    };

    it('ends by the timer of the check, which is set before the one of mysql2', async () => {
        const conn = silentConn();
        const pool = handsOut(conn);
        pool.status.active = true;
        const checking = pool.status.checkStatus();
        await turns();
        expect(conn.query.mock.calls[0][0].timeout).toBe(TIMEOUT);

        jest.advanceTimersByTime(TIMEOUT);
        await checking;
        pool.status.stopTimerCheck();
        expect(failed.map(error => error.message)).toEqual(['Status check timeout']);
        expect(pool.checkError).toStrictEqual({});
    });

    it('drops the timeout of mysql2 that comes after it, and destroys the connection', async () => {
        const conn = silentConn();
        const pool = handsOut(conn);
        pool.status.active = true;
        const checking = pool.status.checkStatus();
        await turns();
        jest.advanceTimersByTime(TIMEOUT);
        await checking;
        await turns();
        pool.status.stopTimerCheck();

        expect(conn.destroy).toHaveBeenCalledTimes(1);
        expect(failed).toHaveLength(1);
        expect(pool.checkError).toStrictEqual({});
    });
});

describe('checkError of a pool over connect() and disconnect()', () => {
    // the status check asks through this
    const answering = (pool: any, ...answers: any[]) => {
        pool.query = jest.fn();
        answers.forEach(answer => answer instanceof Error
            ? pool.query.mockRejectedValueOnce(answer) : pool.query.mockResolvedValueOnce(answer));
        return pool;
    };
    const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };

    it('is set when connect() rejects, since its first check failed', async () => {
        const pool = answering(makePool(), accessDenied());

        await expect(pool.connect()).rejects.toThrow('pool in host db.example is not valid');
        expect(pool.checkError).toStrictEqual(DENIED);
        expect(pool.checkError).not.toBe(pool.checkError);
        pool.disconnect();
    });

    it('is still there after disconnect()', async () => {
        const pool = answering(makePool(), accessDenied());
        await pool.connect().catch(() => undefined);
        pool.disconnect();

        expect(pool.checkError).toStrictEqual(DENIED);
    });

    it('is cleared by the first check of the next connect() that gets its answer', async () => {
        const pool = answering(makePool(), accessDenied(), []);
        await pool.connect().catch(() => undefined);
        pool.disconnect();
        await pool.connect();

        expect(pool.checkError).toBeUndefined();
        pool.disconnect();
    });

    it('is not set by a check that disconnect() left behind', async () => {
        const pool = makePool();
        let rejectQuery: (error: Error) => void;
        pool.query = jest.fn(() => new Promise((_, reject) => { rejectQuery = reject; }));
        const connecting = pool.connect().catch((e: any) => e);
        await turns();
        pool.disconnect();
        rejectQuery(accessDenied());

        expect((await connecting).message).toBe('pool in host db.example is not valid');
        expect(pool.checkError).toBeUndefined();
    });

    // one failed check does not take a valid pool out, so the second connect() resolves
    it('is set on a pool whose connect() passes on an earlier validity', async () => {
        const pool = answering(makePool(), [], accessDenied());
        await pool.connect();
        pool.disconnect();

        await expect(pool.connect()).resolves.toBeUndefined();
        expect(pool.checkError).toStrictEqual(DENIED);
        pool.disconnect();
    });

    describe('the outcome a caller hands to connect()', () => {
        it('says at once that no check of this connect is recorded yet', async () => {
            const pool = answering(makePool(), []);
            const outcome: any = {};
            const connecting = pool.connect(outcome);

            expect(outcome).toStrictEqual({ recorded: false });
            await connecting;
            pool.disconnect();
        });

        it('says recorded, with the error, when the first check failed', async () => {
            const pool = answering(makePool(), accessDenied());
            const outcome: any = {};
            await pool.connect(outcome).catch(() => undefined);

            expect(outcome).toStrictEqual({ recorded: true, checkError: DENIED });
            pool.disconnect();
        });

        it('says recorded, with no error, when the first check got its answer', async () => {
            const pool = answering(makePool(), []);
            const outcome: any = {};
            await pool.connect(outcome);

            expect(outcome).toStrictEqual({ recorded: true });
            pool.disconnect();
        });

        it('stays not recorded when disconnect() comes while the first check is out', async () => {
            const pool = makePool();
            let rejectQuery: (error: Error) => void;
            pool.query = jest.fn(() => new Promise((_, reject) => { rejectQuery = reject; }));
            const outcome: any = {};
            const connecting = pool.connect(outcome).catch((e: any) => e);
            await turns();
            pool.disconnect();
            rejectQuery(accessDenied());
            await connecting;

            expect(outcome).toStrictEqual({ recorded: false });
        });

        // the check ended and was recorded. What a listener does after it changes nothing
        it('stays recorded when disconnect() comes right after the check failed', async () => {
            const pool = answering(makePool(), accessDenied());
            onFailed = () => pool.disconnect();
            const outcome: any = {};
            await pool.connect(outcome).catch(() => undefined);

            expect(outcome).toStrictEqual({ recorded: true, checkError: DENIED });
        });

        it('is of its own connect when two connect() calls overlap', async () => {
            const pool = answering(makePool(), accessDenied(), []);
            const [first, second]: any[] = [{}, {}];
            const connects = [pool.connect(first), pool.connect(second)];
            await Promise.all(connects.map(connect => connect.catch(() => undefined)));

            expect(first).toStrictEqual({ recorded: true, checkError: DENIED });
            expect(second).toStrictEqual({ recorded: true });
            pool.disconnect();
        });
    });

    it('counts every connect() and disconnect() in connectAttempt', async () => {
        const pool = answering(makePool(), [], []);
        const start = pool.connectAttempt;
        const connecting = pool.connect();
        expect(pool.connectAttempt).toBe(start + 1);
        await connecting;
        pool.disconnect();
        expect(pool.connectAttempt).toBe(start + 2);
    });
});
