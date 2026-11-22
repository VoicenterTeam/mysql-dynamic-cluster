import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { getEventListeners } from 'events';
import { createPoolCluster } from '../../index';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Metrics from '../../src/metrics/Metrics';
import Redis from '../../src/Redis/Redis';
import Logger from '../../src/utils/Logger';

// The signal query option of cluster.query(), against the real mysql2 and mysql2's own server
// class on the loopback interface. An abort ends the call with the reason of the signal as it
// is, at any of three moments: while the request waits for a connection, during the USE of
// another database and during the statement. A connection the call holds then is destroyed,
// never released. No other node gets the statement, and no listener stays on the signal
const COM_CHANGE_USER = 0x11;
const COM_RESET_CONNECTION = 0x1f;
const LONG = 600000;
// the status flags of an OK header of a server: autocommit on, no transaction
const AUTOCOMMIT = 2;
// a database other than the one of the pools: a query on it sends USE first
const OTHER = 'other';

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(20000);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach(close => close()));

// mysql2's server class does not count the packets of a client command and says so on stderr.
// Only that line is dropped. Each test sets it again: the spies of a test are restored after it
const consoleError = console.error;
beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('got packets out of order')) consoleError(...args);
    });
});

const column = (name: string) => ({
    catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: '',
    characterSet: 33, columnLength: 384, columnType: 253, flags: 0, decimals: 0
});
// What the health check of a pool wants to see from a node. The node that reports fewer
// connections has the lower load score, and query() tries it first
const status = (connections: number) => [
    { Variable_name: 'wsrep_ready', Value: 'ON' },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '1' },
    { Variable_name: 'Connections', Value: String(connections) },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0' }
];

// the statement of the app
const APP_SQL = 'UPDATE t SET a = 1';

const DEADLOCK = { errno: 1213, message: 'Deadlock found when trying to get lock' };

// What a node does with the call of the app, from the moment a test says so. Until then it
// takes every login, every USE and every statement
type Mode =
    | 'answers'
    // answers the statement with a deadlock
    | 'deadlocks'
    // takes the statement and never answers it
    | 'stays silent'
    // never answers the USE the pool sends before a statement on another database
    | 'ignores USE'
    // never answers the reset the pool sends before it uses a connection the app had
    | 'ignores the reset'
    // keeps each new login waiting until the test calls letIn()
    | 'holds the login';

// what a node saw, counted. `closed` counts the sockets of the app that closed
type Seen = 'logins' | 'uses' | 'resets' | 'statements' | 'closed';

interface INode {
    port: number,
    become: (next: Mode) => void,
    // closes the listening socket: a new connection is refused, the open ones stay
    stop: () => void,
    seen: (what: Seen) => number,
    // resolves when the count of `what` went past the count it has now
    next: (what: Seen) => Promise<void>,
    // lets every login the node holds in
    letIn: () => void
}

const listen = async (connections: number): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const open: any[] = [];
    const counts: Record<Seen, number> = {
        logins: 0, uses: 0, resets: 0, statements: 0, closed: 0
    };
    const waiters: { what: Seen, after: number, resolve: () => void }[] = [];
    const count = (what: Seen) => {
        counts[what]++;
        waiters.filter(w => w.what === what && counts[what] > w.after).forEach(w => {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve();
        });
    };
    const held: (() => void)[] = [];
    let mode: Mode = 'answers';
    let listening = true;
    const stop = () => {
        if (listening) server.close();
        listening = false;
    };
    closers.push(() => {
        open.forEach(connection => connection.stream.destroy());
        stop();
    });
    server.on('connection', (connection: any) => {
        open.push(connection);
        connection.on('error', () => undefined);
        connection.stream.on('close', () => count('closed'));
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: open.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => {
                count('logins');
                if (mode !== 'holds the login') return done(null);
                held.push(() => done(null));
            }
        });
        // The check connection changes the user before its status query. The pool does not:
        // it resets a connection the app had before it uses it again
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || (code !== COM_CHANGE_USER && code !== COM_RESET_CONNECTION)) return;
            if (code === COM_RESET_CONNECTION) count('resets');
            if (code === COM_RESET_CONNECTION && mode === 'ignores the reset') return;
            connection.sequenceId = 1;
            connection.writeOk({ serverStatus: AUTOCOMMIT });
        });
        connection.on('query', (sql: string) => {
            connection.sequenceId = 1;
            if (sql.startsWith('SHOW GLOBAL STATUS')) {
                const columns = [column('Variable_name'), column('Value')];
                return connection.writeTextResult(status(connections), columns);
            }
            if (sql.startsWith('USE ')) {
                count('uses');
                if (mode === 'ignores USE') return;
            }
            if (sql !== APP_SQL) return connection.writeOk({ serverStatus: AUTOCOMMIT });
            count('statements');
            if (mode === 'stays silent') return;
            if (mode === 'deadlocks') {
                return connection.writeError({ message: DEADLOCK.message, code: DEADLOCK.errno });
            }
            connection.writeOk({ affectedRows: 1, serverStatus: AUTOCOMMIT });
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        stop,
        seen: (what: Seen) => counts[what],
        next: (what: Seen) => new Promise<void>(resolve => {
            waiters.push({ what, after: counts[what], resolve });
        }),
        letIn: () => held.splice(0).forEach(done => done())
    };
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));
afterEach(() => jest.restoreAllMocks());

// Two nodes with ids 1 and 2, and node 1 is tried first. Each pool has one connection, so a
// call whose connection was not given back leaves the next call waiting. The health check
// asks on a connection of its own, and no check runs after the one of connect()
const twoNodes = async (): Promise<{ cluster: any, n1: INode, n2: INode }> => {
    const [n1, n2] = [await listen(1), await listen(9)];
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [n1, n2].map((node, index) => ({
            host: '127.0.0.1', port: node.port, id: index + 1
        })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 1,
            healthCheck: { interval: LONG, passive: false },
            // mysql2 keeps the timer of a query whose connection was destroyed. A short one
            // lets the file end
            queryTimeout: 2000
        },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // every node has had its first check, so every node takes queries
    await cluster.ready;
    return { cluster, n1, n2 };
};

// what the call ends with: the result, or the error. maxRetry 2: the call may try both nodes
const call = (cluster: any, options: object = {}): Promise<{ result?: any, error?: any }> =>
    cluster.query(APP_SQL, undefined, { redis: false, maxRetry: 2, ...options }).then(
        (result: any) => ({ result }),
        (error: any) => ({ error })
    );
const seen = (what: Seen, ...nodes: INode[]) => nodes.map(node => node.seen(what));
const stats = (cluster: any, nodeId: number) =>
    cluster.getPoolStats().find((pool: any) => pool.nodeId === nodeId);
const listeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;
// a reason of the app's own, to see that it comes back as it is
const reasonOf = () => Object.assign(new Error('caller gave up'), { code: 'APP_GAVE_UP' });

// The pool asks mysql2 a few turns after query() was called
const turns = async (until: () => boolean) => {
    for (let turn = 0; turn < 100 && !until(); turn++) await new Promise(setImmediate);
};

describe('a signal that is already aborted', () => {
    it('rejects with the reason and asks no node, no service name and no Redis', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        const reason = reasonOf();
        const signal = AbortSignal.abort(reason);
        const added = jest.spyOn(signal, 'addEventListener');
        const lookup = jest.spyOn(cluster._serviceNames, 'getID');
        const redis = jest.spyOn(Redis, 'get');
        const logins = seen('logins', n1, n2);

        const { error } = await call(cluster, { signal, serviceName: 'svc', redis: true });

        expect(error).toBe(reason);
        expect(seen('logins', n1, n2)).toEqual(logins);
        expect(seen('statements', n1, n2)).toEqual([0, 0]);
        expect([lookup, redis, added].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0]);
    });

    it('is recorded as a failed query with the reason as its error', async () => {
        const { cluster } = await twoNodes();
        const reason = reasonOf();
        const recorded = jest.spyOn(Metrics, 'recordQuery');

        await call(cluster, { signal: AbortSignal.abort(reason) });

        expect(recorded).toHaveBeenCalledTimes(1);
        expect(recorded.mock.calls[0][1].error).toBe(reason);
    });
});

describe('a signal that is no AbortSignal', () => {
    it('rejects with a TypeError and asks no node', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        const logins = seen('logins', n1, n2);

        const { error } = await call(cluster, { signal: { aborted: false } });

        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toBe('query: options.signal must be an AbortSignal');
        expect(seen('logins', n1, n2)).toEqual(logins);
    });

    it('null stands for no signal', async () => {
        const { cluster } = await twoNodes();

        const { result } = await call(cluster, { signal: null });

        expect(result.affectedRows).toBe(1);
    });
});

describe('an abort while the request waits for a connection', () => {
    it('in the queue of a full pool: the request leaves it, the slot stays free', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        // the only connection of node 1 is taken
        const taken = await cluster.getConnection();
        expect(taken.nodeId).toBe(1);
        const controller = new AbortController();
        const reason = reasonOf();
        const second = jest.spyOn(cluster.pools[1], 'query');
        const pending = call(cluster, { signal: controller.signal });
        await turns(() => stats(cluster, 1).pending === 1);
        expect(stats(cluster, 1).pending).toBe(1);

        controller.abort(reason);

        expect((await pending).error).toBe(reason);
        expect(second).not.toHaveBeenCalled();
        expect(stats(cluster, 1).pending).toBe(0);
        expect(listeners(controller.signal)).toBe(0);
        // the connection given back goes to the pool, not to the call that gave up. The app
        // had it, so its release() resets it first
        taken.connection.release();
        await turns(() => stats(cluster, 1).idle === 1);
        expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1, pending: 0 });
        expect(seen('statements', n1, n2)).toEqual([0, 0]);
        // and the next call runs on it, with no new login and no second reset
        const logins = seen('logins', n1, n2);
        expect((await call(cluster)).result.affectedRows).toBe(1);
        expect(seen('logins', n1, n2)).toEqual(logins);
        expect(seen('statements', n1, n2)).toEqual([1, 0]);
        expect(seen('resets', n1, n2)).toEqual([1, 0]);
    });

    it('while its connection logs in: the connection goes to the pool when it arrives',
        async () => {
            const { cluster, n1, n2 } = await twoNodes();
            n1.become('holds the login');
            const controller = new AbortController();
            const reason = reasonOf();
            const login = n1.next('logins');
            const second = jest.spyOn(cluster.pools[1], 'query');
            const pending = call(cluster, { signal: controller.signal });
            await login;
            const n2logins = n2.seen('logins');

            controller.abort(reason);

            expect((await pending).error).toBe(reason);
            expect(second).not.toHaveBeenCalled();
            n1.become('answers');
            n1.letIn();
            await turns(() => stats(cluster, 1).idle === 1);
            expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1, pending: 0 });
            expect(seen('statements', n1, n2)).toEqual([0, 0]);
            expect(n2.seen('logins')).toBe(n2logins);
            expect(listeners(controller.signal)).toBe(0);
        });
});

// The connection the call held is destroyed with its socket, and the slot of the pool comes
// back: the next call on node 1, which has one connection, gets a new one
const expectDropped = async (cluster: any, n1: INode, n2: INode, closed: Promise<void>) => {
    await closed;
    expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 0, pending: 0 });
    n1.become('answers');
    const statements = n1.seen('statements');
    expect((await call(cluster)).result.affectedRows).toBe(1);
    expect(n1.seen('statements')).toBe(statements + 1);
    expect(n2.seen('statements')).toBe(0);
};

describe('an abort during the USE of another database', () => {
    it('rejects with the reason as it is and destroys the connection', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores USE');
        const controller = new AbortController();
        const reason = reasonOf();
        const used = n1.next('uses');
        const second = jest.spyOn(cluster.pools[1], 'query');
        const pending = call(cluster, { signal: controller.signal, database: OTHER });
        await used;
        const n2logins = n2.seen('logins');
        const closed = n1.next('closed');

        controller.abort(reason);

        const { error } = await pending;
        expect(error).toBe(reason);
        // nothing of the node is written on the reason of the app
        expect(Object.keys(error)).toEqual(['code']);
        expect(seen('statements', n1, n2)).toEqual([0, 0]);
        // the statement was not sent, and still node 2 is not asked
        expect(second).not.toHaveBeenCalled();
        expect(n2.seen('logins')).toBe(n2logins);
        expect(listeners(controller.signal)).toBe(0);
        await expectDropped(cluster, n1, n2, closed);
    });
});

describe('an abort during the reset of a connection the app had', () => {
    it('rejects with the reason as it is and destroys the connection', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        const { connection, nodeId } = await cluster.getConnection();
        expect(nodeId).toBe(1);
        connection.release();
        n1.become('ignores the reset');
        const controller = new AbortController();
        const reason = reasonOf();
        const reset = n1.next('resets');
        const second = jest.spyOn(cluster.pools[1], 'query');
        const pending = call(cluster, { signal: controller.signal });
        await reset;
        const closed = n1.next('closed');

        controller.abort(reason);

        expect((await pending).error).toBe(reason);
        expect(seen('statements', n1, n2)).toEqual([0, 0]);
        expect(second).not.toHaveBeenCalled();
        expect(listeners(controller.signal)).toBe(0);
        await expectDropped(cluster, n1, n2, closed);
    });
});

describe('an abort right after the connection arrived', () => {
    it('before the USE of another database: the connection is destroyed, nothing is sent',
        async () => {
            const { cluster, n1, n2 } = await twoNodes();
            // a first call leaves an idle connection, which mysql2 hands out on a tick
            await call(cluster);
            const uses = n1.seen('uses');
            const controller = new AbortController();
            const reason = reasonOf();
            // mysql2 emits acquire and then queues the tick that hands the connection out.
            // A tick queued from the tick before it runs after that one and before any
            // promise job: getConnection() has taken its listener off, and Pool.query()
            // has not added its own yet
            cluster.pools[0]._pool.once('acquire', () => {
                process.nextTick(() => process.nextTick(() => controller.abort(reason)));
            });
            const closed = n1.next('closed');

            const options = { signal: controller.signal, database: OTHER };
            expect((await call(cluster, options)).error).toBe(reason);

            expect(n1.seen('uses')).toBe(uses);
            expect(seen('statements', n1, n2)).toEqual([1, 0]);
            expect(listeners(controller.signal)).toBe(0);
            await closed;
            expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 0, pending: 0 });
        });
});

describe('an abort during the statement', () => {
    it('rejects with the reason, destroys the connection, tries no other node', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('stays silent');
        const controller = new AbortController();
        const reason = reasonOf();
        const sent = n1.next('statements');
        const pending = call(cluster, { signal: controller.signal });
        await sent;
        const closed = n1.next('closed');

        controller.abort(reason);

        expect((await pending).error).toBe(reason);
        expect(seen('statements', n1, n2)).toEqual([1, 0]);
        expect(listeners(controller.signal)).toBe(0);
        await expectDropped(cluster, n1, n2, closed);
    });

    it('serves no stale data of Redis', async () => {
        const { cluster, n1 } = await twoNodes();
        n1.become('stays silent');
        const stale = JSON.stringify({ data: 'stale', expired: 0 });
        jest.spyOn(Redis, 'get').mockResolvedValue(stale);
        const controller = new AbortController();
        const reason = reasonOf();
        const sent = n1.next('statements');
        const pending = call(cluster, { signal: controller.signal, redis: true });
        await sent;

        controller.abort(reason);

        expect(await pending).toEqual({ error: reason });
    });

    it('is a failed attempt and a failed query to the metrics, not told to passive health',
        async () => {
            const { cluster, n1 } = await twoNodes();
            n1.become('stays silent');
            const operation = jest.spyOn(Metrics, 'recordOperation');
            const query = jest.spyOn(Metrics, 'recordQuery');
            const told = jest.spyOn(cluster.pools[0].status, 'realFailure');
            const controller = new AbortController();
            const reason = reasonOf();
            const sent = n1.next('statements');
            const pending = call(cluster, { signal: controller.signal });
            await sent;

            controller.abort(reason);
            await pending;

            expect(operation.mock.calls.map(([, options]) => options.error)).toEqual([reason]);
            expect(query.mock.calls.map(([, options]) => options.error)).toEqual([reason]);
            expect(told).not.toHaveBeenCalled();
        });

    it('a destroy that throws is logged, and the abort() of the app throws nothing',
        async () => {
            const { cluster, n1 } = await twoNodes();
            n1.become('stays silent');
            const warned = jest.spyOn(Logger, 'warn');
            let connection: any;
            cluster.pools[0]._pool.once('acquire', (acquired: any) => {
                connection = acquired;
                jest.spyOn(acquired, 'destroy').mockImplementation(() => {
                    throw new Error('destroy failed');
                });
            });
            const controller = new AbortController();
            const reason = reasonOf();
            const sent = n1.next('statements');
            const pending = call(cluster, { signal: controller.signal });
            await sent;

            expect(() => controller.abort(reason)).not.toThrow();

            expect((await pending).error).toBe(reason);
            expect(warned).toHaveBeenCalledWith(
                expect.stringContaining('could not destroy the connection of an aborted query'),
                expect.objectContaining({ nodeId: 1, error: 'destroy failed' })
            );
            expect(listeners(controller.signal)).toBe(0);
            // the socket the pool could not close is closed here, so the file can end
            connection.destroy.mockRestore();
            connection.destroy();
            connection.stream.destroy();
        });
});

describe('passive health hears of a connection that could not be opened', () => {
    it('once, as before', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.stop();
        const told = jest.spyOn(cluster.pools[0].status, 'realFailure');

        const { result } = await call(cluster, { signal: new AbortController().signal });

        expect(result.affectedRows).toBe(1);
        expect(seen('statements', n1, n2)).toEqual([0, 1]);
        expect(told).toHaveBeenCalledTimes(1);
        const [error, opening] = told.mock.calls[0] as [any, boolean];
        expect([error.code, opening]).toEqual(['ECONNREFUSED', true]);
    });
});

describe('no listener stays on the signal once the call settled', () => {
    it('after an answer, and an abort after it changes nothing', async () => {
        const { cluster } = await twoNodes();
        const controller = new AbortController();

        const { result } = await call(cluster, { signal: controller.signal });

        expect(result.affectedRows).toBe(1);
        expect(listeners(controller.signal)).toBe(0);
        expect(() => controller.abort(reasonOf())).not.toThrow();
        expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1 });
    });

    it('after an error of the node', async () => {
        const { cluster, n1 } = await twoNodes();
        n1.become('deadlocks');
        const controller = new AbortController();

        const { error } = await call(cluster, { signal: controller.signal });

        expect([error.errno, error.nodeId]).toEqual([DEADLOCK.errno, 1]);
        expect(listeners(controller.signal)).toBe(0);
    });

    it('after the next node was tried', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.stop();
        const controller = new AbortController();

        const { result } = await call(cluster, { signal: controller.signal });

        expect(result.affectedRows).toBe(1);
        expect(seen('statements', n1, n2)).toEqual([0, 1]);
        expect(listeners(controller.signal)).toBe(0);
    });
});

// What the cluster reads of a pool. Node 1 fails without sending the statement, which would
// let the next node have it, and the signal aborts at that moment
const ROWS = [{ a: 1 }];
const fakeNode = (id: number, query: (...args: any[]) => Promise<any>): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore: id },
    query: jest.fn(query)
});
const fakeCluster = (pools: any[]): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });

describe('an abort between two nodes', () => {
    it('asks no next node and rejects with the reason', async () => {
        const controller = new AbortController();
        const reason = reasonOf();
        const refused = Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED', fatal: true
        });
        const first = fakeNode(1, (_sql: string, _options: object, outcome: any) => {
            outcome.sent = false;
            controller.abort(reason);
            return Promise.reject(refused);
        });
        const second = fakeNode(2, () => Promise.resolve(ROWS));

        const failure = await fakeCluster([first, second])
            .query(APP_SQL, undefined, { signal: controller.signal })
            .catch((e: any) => e);

        expect(failure).toBe(reason);
        expect(second.query).not.toHaveBeenCalled();
    });
});

describe('an abort while the nodes are looked for', () => {
    it('serves no stale data of Redis when no node is valid', async () => {
        const controller = new AbortController();
        const reason = reasonOf();
        const cluster = fakeCluster([]);
        jest.spyOn(cluster, '_getActivePools').mockImplementation(async () => {
            controller.abort(reason);
            throw Object.assign(new Error('no node'), { code: 'MDC_NO_NODE_AVAILABLE' });
        });
        const redis = jest.spyOn(Redis, 'get')
            .mockResolvedValue(JSON.stringify({ data: 'stale', expired: 0 }));

        const failure = await cluster
            .query(APP_SQL, undefined, { signal: controller.signal, redis: true })
            .catch((e: any) => e);

        expect(failure).toBe(reason);
        expect(redis).not.toHaveBeenCalled();
    });

    it('serves no stale data of Redis when the signal aborts while Redis is read', async () => {
        const controller = new AbortController();
        const reason = reasonOf();
        const cluster = fakeCluster([]);
        jest.spyOn(cluster, '_getActivePools').mockRejectedValue(
            Object.assign(new Error('no node'), { code: 'MDC_NO_NODE_AVAILABLE' })
        );
        jest.spyOn(Redis, 'get').mockImplementation(async () => {
            controller.abort(reason);
            return JSON.stringify({ data: 'stale', expired: 0 });
        });

        const failure = await cluster
            .query(APP_SQL, undefined, { signal: controller.signal, redis: true })
            .catch((e: any) => e);

        expect(failure).toBe(reason);
    });

    it('with valid nodes: reads no Redis and asks no node', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        const controller = new AbortController();
        const reason = reasonOf();
        jest.spyOn(cluster._serviceNames, 'getID').mockImplementation(async () => {
            controller.abort(reason);
            return undefined;
        });
        const fresh = JSON.stringify({ data: 'fresh', expired: Date.now() + LONG });
        const redis = jest.spyOn(Redis, 'get').mockResolvedValue(fresh);
        const operation = jest.spyOn(Metrics, 'recordOperation');
        const logins = seen('logins', n1, n2);

        const options = { signal: controller.signal, serviceName: 'svc', redis: true };
        expect((await call(cluster, options)).error).toBe(reason);

        expect(redis).not.toHaveBeenCalled();
        expect(operation).not.toHaveBeenCalled();
        expect(seen('logins', n1, n2)).toEqual(logins);
    });
});
