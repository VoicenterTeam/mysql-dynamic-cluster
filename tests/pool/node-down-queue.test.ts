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
// A mysql2 pool at its limit that opens nothing: every request for a connection waits in its
// queue, the list mysql2 keeps, until the test answers it
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => {
            const pool: any = {
                on: jest.fn(), end: jest.fn(),
                _allConnections: [], _freeConnections: [], _connectionQueue: []
            };
            pool.getConnection = jest.fn((cb: any) => { pool._connectionQueue.push(cb); });
            return pool;
        }),
        createConnection: jest.fn()
    }
}));

import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Logger from '../../src/utils/Logger';

// #98: a node that goes from valid to down fails every request that waits for one of its
// connections, each with an error of its own, as failWaiting() does but with no call of the
// app. The status query of the legacy check that waits there is left in the queue

type Rows = { Variable_name: string, Value: string }[];
const STATUS_SQL = 'SHOW GLOBAL STATUS;';
// what the one validator of these nodes accepts, and what it says no to
const PASS: Rows = [{ Variable_name: 'wsrep_ready', Value: 'ON' }];
const NO: Rows = [{ Variable_name: 'wsrep_ready', Value: 'OFF' }];
const HOST = '192.0.2.10';
const PORT = 3307;
const NAME = HOST + ':' + PORT;
const MESSAGE = 'The node 192.0.2.10:3307 went down while the request waited for a connection';

// a status query whose connection was lost, a login the server refused, and a connection
// the node refused, as mysql2 hands them out
const lost = () => Object.assign(new Error('read ECONNRESET'),
    { code: 'ECONNRESET', errno: -104, fatal: true });
const denied = () => Object.assign(new Error("Access denied for user 'u'"),
    { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' });
const refused = () => Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:3307'),
    { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', fatal: true });

// a connection that answers every statement with these rows
const connection = (rows: Rows) => ({
    query: (_options: any, done: any) => done(null, rows),
    reset: (done: any) => done(null),
    release: jest.fn(), destroy: jest.fn(), on: jest.fn(), removeListener: jest.fn()
});
// a turn of the event loop, for the steps of a call that got its connection
const turn = () => new Promise(resolve => setImmediate(resolve));

// every pool a test made, disconnected after it: connect() starts the interval of the reaper
const made: any[] = [];
afterEach(() => made.splice(0).forEach(pool => pool.disconnect()));
beforeEach(() => jest.clearAllMocks());

// A node that connected: up by the check of connect(). Then each check that the test runs
// gets the next reply as the answer to its status query, rows or an error to fail with: on
// the check connection for a node with a healthCheck block, through the pool for one of the
// legacy check. Every other call goes to the pool as it is. No check of the timer runs
const connected = async (
    block: object | undefined, replies: (Rows | Error)[], settings: object = {}
) => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: HOST, port: PORT }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 2,
            validators: [{ key: 'wsrep_ready', operator: '=', value: 'ON' }], loadFactors: [],
            ...(block ? { healthCheck: block } : {}), ...settings
        }
    } as any).hosts[0];
    const pool: any = new Pool({ id: 4, ...host }, 'test');
    made.push(pool);
    const reply = () => {
        const next = replies.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    if (block) {
        pool.checkQuery = jest.fn(reply);
    } else {
        const query = pool.query.bind(pool);
        pool.query = jest.fn((sql: string, ...rest: any[]) => {
            return sql === STATUS_SQL ? reply() : query(sql, ...rest);
        });
    }
    await pool.connect();
    pool.status.stopTimerCheck();
    return { pool, queue: pool._pool._connectionQueue as any[] };
};

// a getConnection(), a query(), a bound statement and a transaction of the app that wait in
// the queue: what each settles with
const waitFor = (pool: any): Promise<any>[] => [
    pool.getConnection(),
    pool.query('SELECT 1'),
    pool.query('SELECT ?', { execute: true }, {}, { values: [1] }),
    pool.multiStatementQuery(['UPDATE t SET a = 1'], {})
].map(call => call.then(() => 'resolved', (error: any) => error));

// what a request that waited was failed with: an Error of its own for each
const expectNodeDown = (errors: any[]) => {
    errors.forEach(error => {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(MESSAGE);
        expect([error.code, error.sent, error.nodeId]).toEqual(['MDC_NODE_DOWN', false, 4]);
    });
    expect(new Set(errors).size).toBe(errors.length);
};

// the meta of every info line about requests that were failed
const failLines = () => (Logger.info as jest.Mock).mock.calls
    .filter(([, meta]) => meta && meta.failed !== undefined);

describe('a node that goes down fails the requests that wait for its connections', () => {
    // How each way down ends, after the check of connect() passed: the replies of the checks
    // that follow, the last of which takes the node down
    it.each<[string, object | undefined, (Rows | Error)[]]>([
        ['the legacy check, by its second failed check', undefined, [lost(), lost()]],
        ['the legacy check, by a validator that says no', undefined, [NO]],
        ['a healthCheck block, by fall', {}, [lost(), lost()]],
        ['a healthCheck block, by a refused login', {}, [denied()]],
        ['a healthCheck block, by a validator that says no', {}, [NO]]
    ])('%s', async (_name, block, replies) => {
        const { pool, queue } = await connected(block, [PASS, ...replies]);
        const calls = waitFor(pool);
        expect(queue).toHaveLength(4);

        // a check that leaves the node up fails nothing
        for (let left = replies.length; left > 1; left--) await pool.status.checkStatus();
        expect([pool.status.isValid, queue.length]).toEqual([true, 4]);
        await pool.status.checkStatus();

        expect(pool.status.isValid).toBe(false);
        expect(queue).toHaveLength(0);
        expectNodeDown(await Promise.all(calls));
        expect(failLines()).toEqual([[expect.stringContaining(HOST),
            { nodeId: 4, pool: NAME, failed: 4 }]]);
    });

    it('passive health, a connection the node refused: the requests behind it fail, and ' +
        'one check starts', async () => {
        const { pool, queue } = await connected({}, [PASS]);
        const start = jest.spyOn(pool.status._timer, 'start');
        const calls = waitFor(pool);

        // the connection mysql2 opened for the first request was refused
        queue.shift()(refused());
        const [first, ...others] = await Promise.all(calls);

        expect(pool.status.isValid).toBe(false);
        expect(first.code).toBe('ECONNREFUSED');
        expectNodeDown(others);
        // the check passive health starts for the refusal. None for the errors of the down node
        expect(start.mock.calls).toEqual([[0]]);
    });

    it('the error moves no node and starts no check: passive health does not count it',
        async () => {
            const { pool } = await connected({}, [PASS, NO, PASS, PASS]);
            const calls = waitFor(pool);
            await pool.status.checkStatus();
            const errors = await Promise.all(calls);
            // back by rise, 2 passes in a row
            await pool.status.checkStatus();
            await pool.status.checkStatus();
            expect(pool.status.isValid).toBe(true);
            const start = jest.spyOn(pool.status._timer, 'start');

            errors.forEach(error => {
                pool.status.realFailure(error, true);
                pool.status.realFailure(error, false);
            });

            expect(start).not.toHaveBeenCalled();
            expect([pool.status.isValid, pool.status._decides]).toEqual([true, undefined]);
        });

    it('the status query of the legacy check that waits is not failed, and the check ' +
        'counts no failure', async () => {
        const { pool, queue } = await connected(undefined, [PASS]);
        // from here on the checks ask through the pool, as the legacy check does
        delete pool.query;
        const app = pool.getConnection().then(() => 'resolved', (error: any) => error);
        const waiting = pool.status.checkStatus();
        const deciding = pool.status.checkStatus();
        expect(queue).toHaveLength(3);

        // the second check gets a connection first, and the validator says no
        queue.splice(2, 1)[0](null, connection(NO));
        await deciding;

        expect(pool.status.isValid).toBe(false);
        expectNodeDown([await app]);
        expect(queue).toHaveLength(1);
        expect(failLines()).toEqual([[expect.stringContaining(HOST),
            { nodeId: 4, pool: NAME, failed: 1 }]]);
        // the first check gets its connection later, and its answer
        queue.shift()(null, connection(PASS));
        await waiting;
        expect([pool.status.isValid, pool.status._failedChecks]).toEqual([true, 0]);
    });

    // mysql2 queues a wrapper of the callback while a subscriber listens on its tracing
    // channel mysql2:pool:connect. The package cannot tell the request of the check then
    it('a status query whose request mysql2 wrapped is failed: an empty checkError', async () => {
        // a check that would wait for ten minutes before it gives up by itself
        const long = { queryTimeout: 0, timerCheckRange: { start: 1000, end: 600000 } };
        const { pool, queue } = await connected(undefined, [PASS], long);
        delete pool.query;
        const waiting = pool.status.checkStatus();
        const deciding = pool.status.checkStatus();
        const own = queue.shift();
        queue.push((error: any, conn: any) => own(error, conn));

        queue.shift()(null, connection(NO));
        await deciding;
        await waiting;

        expect([pool.status.isValid, pool.status._failedChecks]).toEqual([false, 1]);
        expect(pool.checkError).toEqual({});
    });

    it('leaves a connection the app holds, and a statement that runs', async () => {
        const { pool, queue } = await connected({}, [PASS, NO]);
        const lent = pool.getConnection();
        const running = pool.query('SELECT 1');
        const waiting = pool.getConnection().then(() => 'resolved', (error: any) => error);
        const held = connection(PASS);
        const { release, destroy } = held;
        let answer: (rows: Rows) => void;
        const busy = { ...connection(PASS), query: (_options: any, done: any) => {
            answer = rows => done(null, rows);
        } };
        queue.shift()(null, held);
        queue.shift()(null, busy);
        const lentConnection = await lent;
        for (let i = 0; i < 10 && !answer; i++) await turn();
        expect(answer).toBeDefined();

        await pool.status.checkStatus();

        expect(pool.status.isValid).toBe(false);
        expectNodeDown([await waiting]);
        [release, destroy, busy.release, busy.destroy].forEach(method => {
            expect(method).not.toHaveBeenCalled();
        });
        answer(PASS);
        await expect(running).resolves.toEqual(PASS);
        lentConnection.release();
        for (let i = 0; i < 10 && !release.mock.calls.length; i++) await turn();
        expect(release).toHaveBeenCalledTimes(1);
        expect(failLines()).toEqual([[expect.stringContaining(HOST),
            { nodeId: 4, pool: NAME, failed: 1 }]]);
    });

    it('does nothing when a node that is down fails again', async () => {
        const { pool, queue } = await connected({}, [PASS, NO, NO, lost(), lost()]);
        await pool.status.checkStatus();
        expect(pool.status.isValid).toBe(false);
        waitFor(pool);

        for (let i = 0; i < 3; i++) await pool.status.checkStatus();

        expect(queue).toHaveLength(4);
        expect(failLines()).toEqual([]);
    });

    it('logs no line when no request waited', async () => {
        const { pool } = await connected({}, [PASS, NO]);

        await pool.status.checkStatus();

        expect(pool.status.isValid).toBe(false);
        expect(failLines()).toEqual([]);
    });

    it('does nothing at disconnect()', async () => {
        const { pool, queue } = await connected({}, [PASS]);
        waitFor(pool);
        made.splice(made.indexOf(pool), 1);

        pool.disconnect();

        expect(queue).toHaveLength(4);
        expect(failLines()).toEqual([]);
    });
});
