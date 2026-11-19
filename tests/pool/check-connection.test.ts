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
// A mysql2 that opens nothing. The pool it creates hands out no connection, and every
// connection it creates is one the test drives by hand
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => ({
            on: jest.fn(), end: jest.fn(), getConnection: jest.fn(),
            _allConnections: [], _freeConnections: [], _connectionQueue: []
        })),
        createConnection: jest.fn(() => {
            const { EventEmitter } = jest.requireActual('events');
            const connection = new EventEmitter();
            connection.changeUser = jest.fn();
            connection.query = jest.fn();
            connection.end = jest.fn();
            connection.destroy = jest.fn();
            connection.stream = { destroy: jest.fn() };
            return connection;
        })
    }
}));

import mysql from 'mysql2';
import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Metrics from '../../src/metrics/Metrics';

// The check connection of a node with a healthCheck block, at the place where the package
// meets mysql2: what it opens the connection with, what it sends on it, and when it drops
// or closes it. A test plays mysql2: it lets a login pass or fail and answers the change
// of user and the status query. The clock is fake, and nothing here opens a socket
const SQL = 'SHOW GLOBAL STATUS;';
const TIMEOUT = 1000;
const createPool = mysql.createPool as unknown as jest.Mock;
const createConnection = mysql.createConnection as unknown as jest.Mock;
const recordOperation = Metrics.recordOperation as unknown as jest.Mock;
const recordHealthCheck = Metrics.recordHealthCheck as unknown as jest.Mock;

// a check that waits for an answer no test gives is a bug of the code or of a test
jest.setTimeout(5000);

// No validators: an answered check is a valid node. fall is 3, so one failed check takes
// no node down. `pool` goes into the default pool settings next to those
const BLOCK = { flags: [], healthCheck: { timeout: TIMEOUT, fall: 3 } };
const makePool = (pool: object = BLOCK): any => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: 'db.example' }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', validators: [], loadFactors: [], ...pool
        }
    } as any).hosts[0];
    return new Pool({ id: 1, ...host }, 'test');
};

// the connections mysql2 was asked for, in order
const connections = (): any[] => createConnection.mock.results.map(result => result.value);
const last = () => connections()[connections().length - 1];
// let everything that waits for a promise run
const settle = async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};
// What mysql2 does, one step each. An error of a change of user is fatal for mysql2
const logIn = async (connection: any) => {
    connection.emit('connect', {});
    await settle();
};
const answerUser = async (connection: any, error?: any) => {
    const calls = connection.changeUser.mock.calls;
    calls[calls.length - 1][1](error ? Object.assign(error, { fatal: true }) : null);
    await settle();
};
const answerQuery = async (connection: any, error?: any) => {
    const calls = connection.query.mock.calls;
    calls[calls.length - 1][1](error || null, error ? undefined : []);
    await settle();
};
// a whole check that passes on this connection, from the change of user on
const answer = async (connection: any) => {
    await answerUser(connection);
    await answerQuery(connection);
};
const lost = () => Object.assign(new Error('read ECONNRESET'),
    { code: 'ECONNRESET', errno: -104, syscall: 'read', fatal: true });
const deadlock = () => Object.assign(new Error('Deadlock found'),
    { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' });

// A pool that connected: the check of connect() logged in on the first connection and
// passed there. The node is up and holds that connection
const connected = async (settings?: object) => {
    const pool = makePool(settings);
    const connecting = pool.connect();
    await logIn(last());
    await answer(last());
    await connecting;
    return pool;
};

// one turn of the real event loop: what setImmediate holds runs
const turn = () => new Promise(resolve => setImmediate(resolve));

let pools: any[];
beforeEach(() => {
    // The timers are fake and setImmediate is not: a check waits one turn of the event
    // loop after its timer, and a fake setImmediate would be 1 ms of fake time instead
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
    createPool.mockClear();
    createConnection.mockClear();
    recordOperation.mockClear();
    recordHealthCheck.mockClear();
    pools = [];
});
afterEach(() => {
    pools.forEach(pool => pool.disconnect());
    jest.useRealTimers();
});
const started = async (settings?: object) => {
    const pool = await connected(settings);
    pools.push(pool);
    return pool;
};

describe('the check connection: what it is opened with', () => {
    it('the options of the pool of the node, without its limit', async () => {
        await started({ flags: ['-FOUND_ROWS'], healthCheck: {} });

        const { connectionLimit, ...ofThePool } = createPool.mock.calls[0][0];
        expect(createConnection.mock.calls).toEqual([[ofThePool]]);
        expect(ofThePool).toStrictEqual({
            host: 'db.example', port: 3306, user: 'u', password: 'p', database: 'd',
            flags: ['-FOUND_ROWS']
        });
    });

    it('the flags the server made the pool take, when the settings have none', async () => {
        const pool = makePool({ healthCheck: {} });
        pools.push(pool);
        const connecting = pool.connect();
        // the login that reads the version: a server that needs query attributes off
        last().emit('connect', { serverVersion: '8.0.25', capabilityFlags: 1 << 27 });
        await settle();
        await logIn(last());
        await answer(last());
        await connecting;

        const flags = ['-CLIENT_QUERY_ATTRIBUTES'];
        expect(createPool.mock.calls[0][0].flags).toEqual(flags);
        expect(createConnection.mock.calls[1][0].flags).toEqual(flags);
    });

    it('a node without the block opens none: its check asks the pool', async () => {
        const pool = makePool({ flags: [] });
        pools.push(pool);
        pool.connect().catch((): void => undefined);
        await settle();

        const mysqlPool = createPool.mock.results[0].value;
        expect(createConnection).not.toHaveBeenCalled();
        expect(mysqlPool.getConnection).toHaveBeenCalledTimes(1);
        expect(pool.holdsCheckConnection).toBe(false);
    });

    it('a node with the block asks its pool for no connection', async () => {
        await started();

        expect(createPool.mock.results[0].value.getConnection).not.toHaveBeenCalled();
    });
});

describe('the check connection: what a check sends on it', () => {
    it('a change of user to the database of the node, then the status query', async () => {
        await started();

        const { changeUser, query } = last();
        const sent = (call: jest.Mock) => call.mock.calls.map(([options]: any[]) => options);
        expect([sent(changeUser), sent(query)]).toEqual([[{ database: 'd' }], [{ sql: SQL }]]);
        expect(changeUser.mock.invocationCallOrder[0])
            .toBeLessThan(query.mock.invocationCallOrder[0]);
    });

    it('the status query with no timeout of mysql2', async () => {
        await started();

        expect(last().query.mock.calls.map(([options]: any[]) => options)).toEqual([{ sql: SQL }]);
    });

    it('nothing before the server took the login', async () => {
        const pool = makePool();
        pools.push(pool);
        pool.connect().catch((): void => undefined);
        await settle();

        expect(last().changeUser).not.toHaveBeenCalled();
    });

    it('every check a change of user again, on the connection it holds', async () => {
        const pool = await started();

        const checking = pool.status.checkStatus();
        await settle();
        await answer(last());
        await checking;

        expect(connections()).toHaveLength(1);
        expect(last().changeUser).toHaveBeenCalledTimes(2);
        expect(last().query).toHaveBeenCalledTimes(2);
    });
});

describe('the check connection: a login the server refuses', () => {
    it('on a new connection reaches the check as mysql2 made it, not fatal', async () => {
        const pool = makePool();
        pools.push(pool);
        const outcome: any = {};
        const connecting = pool.connect(outcome).catch((e: Error) => e.message);
        const refused: any = Object.assign(new Error('Access denied'),
            { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' });
        last().emit('error', refused);

        expect(await connecting).toBe('pool in host db.example is not valid');
        expect(outcome.checkError).toEqual(
            { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' });
        expect([refused.fatal, pool.holdsCheckConnection]).toEqual([undefined, false]);
    });

    it('is dropped with its socket, and the next check opens a new connection', async () => {
        const pool = makePool();
        pools.push(pool);
        pool.connect().catch((): void => undefined);
        const first = last();
        first.emit('error', Object.assign(new Error('Access denied'), { errno: 1045 }));
        await settle();

        pool.status.checkStatus();
        await settle();

        expect([first.destroy.mock.calls.length, first.stream.destroy.mock.calls.length])
            .toEqual([1, 1]);
        expect(connections()).toHaveLength(2);
    });
});

describe('the check connection: when it is kept and when it is dropped', () => {
    it('an error of the server under the status query keeps it', async () => {
        const pool = await started();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(last());
        await answerQuery(last(), deadlock());
        await checking;

        expect(pool.checkError).toEqual(
            { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' });
        expect([pool.holdsCheckConnection, last().destroy.mock.calls.length]).toEqual([true, 0]);
    });

    it('a refused change of user, fatal for mysql2, drops it', async () => {
        const pool = await started();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(last(), Object.assign(new Error('Access denied'), { errno: 1045 }));
        await checking;

        expect(pool.checkError).toEqual({ errno: 1045 });
        expect([pool.holdsCheckConnection, last().destroy.mock.calls.length]).toEqual([false, 1]);
    });

    it('an error event while nobody asks drops it, and nothing is thrown', async () => {
        const pool = await started();
        const idle = last();

        expect(() => idle.emit('error', lost())).not.toThrow();

        expect([pool.holdsCheckConnection, idle.destroy.mock.calls.length]).toEqual([false, 1]);
        expect(pool.checkError).toBeUndefined();
    });
});

describe('the check connection: a connection that was lost', () => {
    it('held from an earlier check: the check opens a new one and asks again', async () => {
        const pool = await started();
        const held = last();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(held, lost());
        await logIn(last());
        await answer(last());
        await checking;

        expect(connections()).toHaveLength(2);
        expect([pool.status.isValid, pool.checkError]).toEqual([true, undefined]);
        expect([held.destroy.mock.calls.length, pool.holdsCheckConnection]).toEqual([1, true]);
    });

    it('lost under the status query, not at the change of user: the same', async () => {
        const pool = await started();
        const held = last();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(held);
        await answerQuery(held, lost());
        await logIn(last());
        await answer(last());
        await checking;

        expect([connections().length, pool.checkError]).toEqual([2, undefined]);
    });

    it('lost again on the new one: the check failed, and asks no third time', async () => {
        const pool = await started();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(last(), lost());
        await logIn(last());
        await answerUser(last(), lost());
        await checking;

        expect(connections()).toHaveLength(2);
        expect(pool.checkError).toEqual({ code: 'ECONNRESET', errno: -104 });
    });

    it('opened by this check itself: the check failed, and asks no second time', async () => {
        const pool = await started();
        last().emit('error', lost());
        await settle();

        const checking = pool.status.checkStatus();
        await settle();
        await logIn(last());
        await answerUser(last(), lost());
        await checking;

        // the one of connect(), and the one this check opened
        expect(connections()).toHaveLength(2);
        expect(pool.checkError).toEqual({ code: 'ECONNRESET', errno: -104 });
    });

    it('an error of another kind on the held one: the check failed, and asks no second time',
        async () => {
            const pool = await started();

            const checking = pool.status.checkStatus();
            await settle();
            await answerUser(last());
            const broken = Object.assign(new Error('fatal'), { code: 'EPROTO', fatal: true });
            await answerQuery(last(), broken);
            await checking;

            expect(connections()).toHaveLength(1);
            expect(pool.checkError).toEqual({ code: 'EPROTO' });
        });

    it('a disconnect() before the loss is seen: no new connection is opened', async () => {
        const pool = await started();
        const held = last();

        pool.status.checkStatus();
        await settle();
        pool.disconnect();
        await answerUser(held, lost());

        expect(connections()).toHaveLength(1);
    });
});

// Passive health tells the status of a call of the app that failed, and starts a check at
// once. The connection the node holds says nothing about a new one, so after a call that
// could open none the check opens one itself
describe('the check connection: after a call of the app that could open no connection', () => {
    const noRoute = () => Object.assign(new Error('connect ENETUNREACH'),
        { code: 'ENETUNREACH', errno: -101, syscall: 'connect', fatal: true });
    const timedOut = () => Object.assign(new Error('connect ETIMEDOUT'),
        { code: 'ETIMEDOUT', fatal: true });
    // the call fails, and the check that passive health starts for it is out
    const afterCall = async (error: any, opening: boolean, settings?: object) => {
        const pool = await started(settings);
        const held = last();
        pool.status.realFailure(error, opening);
        await jest.advanceTimersByTimeAsync(0);
        return { pool, held };
    };
    // how often the node logged out of a connection, and how often it asked on it
    const used = (connection: any) => {
        return [connection.end.mock.calls.length, connection.changeUser.mock.calls.length];
    };

    it.each([['found no route', noRoute], ['got none in time', timedOut]])(
        'that %s: the check logs out of the one it held and asks on a new one',
        async (_name, error) => {
            const { pool, held } = await afterCall(error(), true);
            await logIn(last());
            await answer(last());

            // the check of connect() asked on the first one, this check on the second
            expect([connections().length, used(held), used(last())]).toEqual([2, [1, 1], [0, 1]]);
            expect([pool.status.isValid, pool.checkError]).toEqual([true, undefined]);
        });

    it('that lost the connection it had: the check asks on the one the node holds',
        async () => {
            const { pool, held } = await afterCall(lost(), false);
            await answer(held);

            expect([connections().length, used(held)]).toEqual([1, [0, 2]]);
            expect([pool.status.isValid, pool.checkError]).toEqual([true, undefined]);
        });

    it('no route for the new one either: the node stays up and holds none', async () => {
        const { pool, held } = await afterCall(noRoute(), true);
        last().emit('error', noRoute());
        await settle();

        expect([connections().length, used(held)]).toEqual([2, [1, 1]]);
        expect([pool.status.isValid, pool.holdsCheckConnection]).toEqual([true, false]);
        expect(pool.checkError).toEqual({ code: 'ENETUNREACH', errno: -101 });
    });

    it('the new one is lost: down with that check, and no third one is opened', async () => {
        const { pool } = await afterCall(noRoute(), true);
        await logIn(last());
        await answerUser(last(), lost());

        expect([connections().length, pool.status.isValid]).toEqual([2, false]);
        expect(pool.checkError).toEqual({ code: 'ECONNRESET', errno: -104 });
    });

    it('the new one is not there in time: down at the timeout of the check', async () => {
        const { pool } = await afterCall(timedOut(), true);
        const before = pool.status.isValid;
        await jest.advanceTimersByTimeAsync(TIMEOUT);

        expect([before, pool.status.isValid, pool.checkError]).toEqual([true, false, {}]);
        expect([connections().length, pool.holdsCheckConnection]).toEqual([2, false]);
    });

    it('the check of the timer after it has nothing to decide: it asks on the new one',
        async () => {
            const { pool } = await afterCall(noRoute(), true);
            await logIn(last());
            await answer(last());

            const checking = pool.status.checkStatus();
            await settle();
            await answer(last());
            await checking;

            expect([connections().length, used(last())]).toEqual([2, [0, 2]]);
        });

    it('with passive false the node is told nothing: its check asks on the one it holds',
        async () => {
            const off = { ...BLOCK, healthCheck: { ...BLOCK.healthCheck, passive: false } };
            const { pool, held } = await afterCall(noRoute(), true, off);

            const checking = pool.status.checkStatus();
            await settle();
            await answer(held);
            await checking;

            expect([connections().length, used(held)]).toEqual([1, [0, 2]]);
        });
});

describe('the check connection: the timeout of a check', () => {
    it('drops the connection with its socket, so no late answer comes on it', async () => {
        const pool = await started();
        const held = last();

        const checking = pool.status.checkStatus();
        await jest.advanceTimersByTimeAsync(TIMEOUT);
        await checking;

        expect(pool.checkError).toEqual({});
        expect([held.destroy.mock.calls.length, held.stream.destroy.mock.calls.length])
            .toEqual([1, 1]);
        expect(pool.holdsCheckConnection).toBe(false);
    });

    it('covers the login of a new connection: one that is not taken in time is dropped',
        async () => {
            const pool = makePool();
            pools.push(pool);
            const connecting = pool.connect().catch((e: Error) => e.message);

            await jest.advanceTimersByTimeAsync(TIMEOUT - 1);
            const before = last().destroy.mock.calls.length;
            await jest.advanceTimersByTimeAsync(1);

            expect(await connecting).toBe('pool in host db.example is not valid');
            expect([before, last().destroy.mock.calls.length]).toEqual([0, 1]);
        });

    it('an answer that is read in the turn the timer fires wins', async () => {
        const pool = await started();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(last());
        // the timer of the check fires, and nothing else runs yet
        jest.advanceTimersByTime(TIMEOUT);
        await answerQuery(last());
        await checking;

        expect([pool.checkError, pool.holdsCheckConnection]).toEqual([undefined, true]);
        expect(last().destroy).not.toHaveBeenCalled();
    });

    it('with no answer in that turn the check fails right after it', async () => {
        const pool = await started();

        const checking = pool.status.checkStatus();
        await settle();
        jest.advanceTimersByTime(TIMEOUT);
        await settle();
        const atTheTimer = pool.checkError;
        await turn();
        await checking;

        expect([atTheTimer, pool.checkError]).toEqual([undefined, {}]);
    });

    it('of a check from before a disconnect() leaves the connection of a later connect()',
        async () => {
            const pool = await started();
            pool.status.checkStatus();
            await settle();
            pool.disconnect();
            const connecting = pool.connect();
            await logIn(last());
            await answer(last());
            await connecting;

            await jest.advanceTimersByTimeAsync(TIMEOUT);

            expect(connections()).toHaveLength(2);
            expect([last().destroy.mock.calls.length, pool.holdsCheckConnection])
                .toEqual([0, true]);
        });
});

describe('the check connection: connect() and disconnect()', () => {
    it('disconnect() logs out of it, and drops it when the server keeps the socket', async () => {
        const pool = await connected();
        const held = last();

        pool.disconnect();
        const loggedOut = [held.end.mock.calls.length, held.destroy.mock.calls.length];
        jest.advanceTimersByTime(2000);

        expect(loggedOut).toEqual([1, 0]);
        expect([held.destroy.mock.calls.length, pool.holdsCheckConnection]).toEqual([1, false]);
    });

    it('a check after disconnect() opens nothing', async () => {
        const pool = await connected();
        pool.disconnect();

        await pool.status.checkStatus();
        const direct = await pool.checkQuery(SQL).then(() => undefined, (e: any) => e.code);

        expect([connections().length, direct]).toEqual([1, 'POOL_NOT_CONNECTED']);
    });

    it('a second connect() logs out of the one it held and opens one', async () => {
        const pool = await started();
        const first = last();

        const connecting = pool.connect();
        await logIn(last());
        await answer(last());
        await connecting;

        expect(connections()).toHaveLength(2);
        expect([first.end.mock.calls.length, last().end.mock.calls.length]).toEqual([1, 0]);
    });

    // Each connect() starts the timer that closes idle connections of its pool. The one
    // of a connect() that was replaced has to end with it, or the process never exits
    it.each([1, 2])('%i connect() calls, then disconnect(): no timer of the node is left',
        async calls => {
            const pool = await connected();
            for (let call = 1; call < calls; call++) {
                const connecting = pool.connect();
                await logIn(last());
                await answer(last());
                await connecting;
            }

            pool.disconnect();
            // the logout of a check connection gives the server 2000 ms to close
            jest.advanceTimersByTime(2000);

            expect(jest.getTimerCount()).toBe(0);
        });

    // mysql2 takes no command on a connection once its logout is queued
    const closedState = () => Object.assign(
        new Error("Can't add new command when connection is in closed state"), { fatal: true });
    // how every check that was recorded ended
    const results = () => recordHealthCheck.mock.calls.map(([, options]) => options.result);

    it('a second connect() while the first logs in: both checks pass on the new connection',
        async () => {
            const pool = makePool();
            pools.push(pool);
            const first = pool.connect();
            const replaced = last();
            const second = pool.connect();
            replaced.changeUser.mockImplementation((_options: any, done: any) => {
                done(closedState());
            });

            await logIn(replaced);
            await logIn(last());
            last().changeUser.mock.calls.forEach(([, done]: any[]) => done(null));
            await settle();
            last().query.mock.calls.forEach(([, done]: any[]) => done(null, []));
            await Promise.all([first, second]);

            expect([connections().length, last().query.mock.calls.length]).toEqual([2, 2]);
            expect([results(), pool.checkError]).toEqual([['valid', 'valid'], undefined]);
        });

    it('a check from before a disconnect() asks nothing on the connection of a later connect()',
        async () => {
            const pool = await started();
            const old = last();
            pool.status.checkStatus();
            await settle();
            pool.disconnect();
            const connecting = pool.connect();
            await logIn(last());
            await answer(last());
            await connecting;

            await answerUser(old, closedState());

            expect(last().changeUser).toHaveBeenCalledTimes(1);
            expect(results()).toEqual(['valid', 'valid']);
        });
});

describe('the check connection: the metric of an attempt', () => {
    const records = () => recordOperation.mock.calls.map(([, options]) => {
        return [options.sql, options.poolName, options.database, options.error?.code];
    });

    it('a check that passes is one record of the operation, as through the pool', async () => {
        await started();

        expect(records()).toEqual([[SQL, 'db.example:3306', 'd', undefined]]);
    });

    it('a check that asks twice is two: the one that was lost has the error', async () => {
        const pool = await started();
        recordOperation.mockClear();

        const checking = pool.status.checkStatus();
        await settle();
        await answerUser(last(), lost());
        await logIn(last());
        await answer(last());
        await checking;

        expect(records()).toEqual([
            [SQL, 'db.example:3306', 'd', 'ECONNRESET'], [SQL, 'db.example:3306', 'd', undefined]
        ]);
    });
});
