import mysql from 'mysql2';
import { getEventListeners } from 'events';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';

// The cluster of createPoolCluster and the real mysql2 against mysql2's own server class on the
// loopback interface. It shows that the lists of mysql2 the node API reads are the ones a real
// pool keeps, which the mocked tests cannot
const COM_RESET_CONNECTION = 0x1f;

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(20000);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach(close => close()));

// mysql2's server class does not count the packets of a client command and says so on stderr.
// Only that line is dropped
const consoleError = console.error;
beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('got packets out of order')) consoleError(...args);
    });
});
afterAll(() => jest.restoreAllMocks());

const column = (name: string) => ({
    catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: '',
    characterSet: 33, columnLength: 384, columnType: 253, flags: 0, decimals: 0
});
// what the health check of a pool wants to see from a node
const STATUS = [
    { Variable_name: 'wsrep_ready', Value: 'ON' },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '1' },
    { Variable_name: 'Connections', Value: '1' },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0' }
];

// Answers the login and every query, and counts the logins and the resets
const listen = (): Promise<{ port: number, logins: () => number, resets: () => number }> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    let resets = 0;
    closers.push(() => {
        connections.forEach(connection => connection.stream.destroy());
        server.close();
    });
    server.on('connection', (connection: any) => {
        connections.push(connection);
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => done(null)
        });
        // The pool sends no change of user. It resets a connection whose query failed, and one
        // the app had, when the app releases it
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (!known && code === COM_RESET_CONNECTION) {
                resets++;
                connection.sequenceId = 1;
                connection.writeOk({ serverStatus: 2 });
            }
        });
        connection.on('query', () => {
            connection.sequenceId = 1;
            connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => connection.close());
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: (server._server.address() as AddressInfo).port,
                logins: () => connections.length,
                resets: () => resets
            });
        });
    });
};

// a test that fails before its own disconnect() must not leave timers and sockets behind
const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.connected && cluster.disconnect()));

// One node with one connection, or as many as the test asks for. flags are set, so connect()
// asks no server first, and the next health check is ten minutes away, so only the test asks
// for connections
const connectCluster = async (port: number, connectionLimit = 1): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port, id: 4, connectionLimit }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            timerCheckRange: { start: 600000, end: 600000 }
        },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    return cluster;
};

// Poll until `done` says yes. It gives up after 500 turns, about 5 s, and says what it saw
const until = async (done: () => boolean, saw: () => unknown): Promise<void> => {
    for (let turn = 0; turn < 500 && !done(); turn++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!done()) throw new Error('gave up waiting, saw ' + JSON.stringify(saw()));
};
// The release() of a lent connection resets it first: wait for the counts after that
const countsAfterReset = async (cluster: any, wanted: object): Promise<void> => {
    const stats = () => cluster.getPoolStats()[0];
    await until(() => JSON.stringify(stats()) === JSON.stringify(wanted), stats);
};

const ask = (connection: any): Promise<any[]> => new Promise((resolve, reject) => {
    connection.query('SHOW GLOBAL STATUS', (error: any, rows: any[]) => {
        return error ? reject(error) : resolve(rows);
    });
});

describe('the node API against a real mysql2 pool', () => {
    it('ready and nodes() report the node that connected', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);

        expect(await cluster.ready).toEqual([{ nodeId: 4, ok: true }]);
        expect(cluster.nodes()).toEqual([{
            id: 4, name: '127.0.0.1:' + server.port, host: '127.0.0.1', port: server.port,
            isValid: true, loadScore: 2
        }]);
    });

    it('getPoolStats counts the connection in use and the requests that wait', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        const stats = () => cluster.getPoolStats()[0];
        expect(stats()).toEqual({ nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });

        const held = await cluster.getConnection();
        expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 0, pending: 0, limit: 1 });
        const waiting = [cluster.getConnection(), cluster.getConnection()];
        waiting.forEach(request => request.catch(() => undefined));
        expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 0, pending: 2, limit: 1 });

        cluster.failWaiting(4, new Error('node 4 is leaving'));
        held.connection.release();
        // in use until its reset is answered
        expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 0, pending: 0, limit: 1 });
        await countsAfterReset(cluster, { nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
        expect(server.resets()).toBe(1);
    });

    it('failWaiting fails the waiting requests and leaves the connection in use', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        const held = await cluster.getConnection();
        const waiting = [cluster.getConnection(), cluster.getConnection()]
            .map(request => request.catch((e: any) => e));

        const error = new Error('node 4 is leaving');
        expect(cluster.failWaiting(4, error)).toBe(2);
        expect(await Promise.all(waiting)).toEqual([error, error]);
        expect((error as any).nodeId).toBe(4);
        expect(cluster.failWaiting(4, error)).toBe(0);

        // the connection in use still answers, on the one login the pool made
        expect(held.nodeId).toBe(4);
        expect(await ask(held.connection)).toHaveLength(STATUS.length);
        expect(server.logins()).toBe(1);
    });

    it('a query of the cluster that waits is failed too', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        // the only connection of the node is taken, so the query has to wait
        await cluster.getConnection();

        const query = cluster.query('SELECT 1').catch((e: any) => e);
        // the query reaches the pool a few turns after the cluster picked it
        const pending = () => cluster.getPoolStats()[0].pending;
        for (let turn = 0; turn < 100 && pending() < 1; turn++) await new Promise(setImmediate);
        expect(pending()).toBe(1);
        expect(cluster.failWaiting(4, new Error('node 4 is leaving'))).toBe(1);

        expect((await query).message).toContain('node 4 is leaving');
    });

    it('getConnection rejects with the error of mysql2 plus nodeId after disconnect', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        await cluster.disconnect();

        // the node is still picked, and its closed mysql2 pool refuses with an error of its own
        const failure = await cluster.getConnection().catch((e: any) => e);
        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBeUndefined();
        expect(failure.nodeId).toBe(4);
    });
});

// One node whose only connection is taken, so every other request waits in the queue of mysql2
const fullPool = async () => {
    const server = await listen();
    const cluster = await connectCluster(server.port);
    const held = await cluster.getConnection();
    return { server, cluster, held, stats: () => cluster.getPoolStats()[0] };
};

// How a promise stands one turn of the event loop from now, and what it rejected with. mysql2
// hands a released connection to the next waiter within that turn. The value of a resolved
// promise is left out: a connection of mysql2 in a failed assertion breaks the json report
const stateOf = (promise: Promise<any>): Promise<{ state: string, reason?: any }> => Promise.race([
    promise.then(() => ({ state: 'resolved' }), reason => ({ state: 'rejected', reason })),
    new Promise<{ state: string }>(resolve => setImmediate(() => resolve({ state: 'pending' })))
]);

// the id the server gave a connection at its login. Two results with the same id hold the same
// connection
const threadOf = (result: any): number => result.connection.threadId;

// A request whose rejection always has a handler. Without one, an assertion that fails before
// the test reads the request leaves an unhandled rejection, which ends the worker instead of
// failing the test
const quiet = (request: Promise<any>): Promise<any> => {
    request.catch(() => undefined);
    return request;
};

// Resolves when the next connection goes back to the pool of a node, which the cluster tells
// with its release event. No clock and no count of turns: a release that never comes is a
// test that hangs, and that is the failure
const nextRelease = (cluster: any): Promise<void> => new Promise(resolve => {
    cluster.on('release', () => resolve());
});

// Runs the test while a subscriber traces the requests to the pools of mysql2, as a tracing
// library does. The subscriber is gone afterwards, also when the test failed
const traced = async (test: () => Promise<void>): Promise<void> => {
    const channel = require('diagnostics_channel').tracingChannel('mysql2:pool:connect');
    const tracer = { start() {}, end() {}, asyncStart() {}, asyncEnd() {}, error() {} };
    channel.subscribe(tracer);
    try {
        await test();
    } finally {
        channel.unsubscribe(tracer);
    }
};

// Asks for one connection per controller, with its signal. Resolves once every call ended, with
// the places of the calls that got the connection, in the order they got it. A call that gets
// the connection gives it back at once, which serves the next
const servedOrder = (cluster: any, controllers: AbortController[]): Promise<number[]> => {
    const served: number[] = [];
    const requests = controllers.map(({ signal }, place) => {
        return cluster.getConnection({ signal }).then(({ connection }: any) => {
            served.push(place);
            connection.release();
        }, () => undefined);
    });
    return Promise.all(requests).then(() => served);
};

describe('getConnection with a signal against a real mysql2 pool', () => {
    it('rejects a waiting call with the reason at the abort, with one waiter less', async () => {
        const { cluster, stats } = await fullPool();
        const controller = new AbortController();
        const reason = { why: 'deadline' };
        [cluster.getConnection(), cluster.getConnection()].forEach(quiet);
        const aborted = quiet(cluster.getConnection({ signal: controller.signal }));
        expect(stats().pending).toBe(3);

        controller.abort(reason);
        expect(stats().pending).toBe(2);
        expect((await stateOf(aborted)).reason).toBe(reason);
        expect(Object.keys(reason)).toEqual(['why']);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('serves the waiters before and after an aborted call in their order', async () => {
        const { cluster, held } = await fullPool();
        const controller = new AbortController();
        const before = quiet(cluster.getConnection());
        cluster.getConnection({ signal: controller.signal }).catch(() => undefined);
        const after = quiet(cluster.getConnection());
        controller.abort();

        held.connection.release();
        const first = await before;
        // the node has one connection, and it is the first the server saw
        expect([threadOf(held), threadOf(first)]).toEqual([1, 1]);
        expect((await stateOf(after)).state).toBe('pending');
        first.connection.release();
        expect(threadOf(await after)).toBe(threadOf(held));
    });

    it('leaks no connection: the counts are back once the other waiter released', async () => {
        const { server, cluster, held, stats } = await fullPool();
        const controller = new AbortController();
        cluster.getConnection({ signal: controller.signal }).catch(() => undefined);
        const other = quiet(cluster.getConnection());
        controller.abort();

        // mysql2 takes the next waiter out of its queue as it releases, after the reset
        held.connection.release();
        await countsAfterReset(cluster, { nodeId: 4, used: 1, idle: 0, pending: 0, limit: 1 });
        (await other).connection.release();
        await countsAfterReset(cluster, { nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
        expect([server.logins(), server.resets(), stats().pending]).toEqual([1, 2, 0]);
    });

    it('takes two calls out of the middle of six waiters and serves the other four', async () => {
        const { cluster, held, stats } = await fullPool();
        const controllers = [0, 1, 2, 3, 4, 5].map(() => new AbortController());
        const served = servedOrder(cluster, controllers);

        [controllers[1], controllers[4]].forEach(controller => controller.abort());
        expect(stats().pending).toBe(4);
        held.connection.release();
        expect(await served).toEqual([0, 2, 3, 5]);
        await countsAfterReset(cluster, { nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
    });

    // The second round starts where the first left the queue of mysql2, which is a ring: its
    // entries then wrap around the end of the list behind it
    it('keeps the order of 120 waiters less every third, twice on the same pool', async () => {
        const { cluster, held, stats } = await fullPool();
        const places = Array.from({ length: 120 }, (_, place) => place);
        const kept = places.filter(place => place % 3 !== 1);
        for (const holder of [held, undefined]) {
            const taken = holder ?? await cluster.getConnection();
            const controllers = Array.from({ length: 120 }, () => new AbortController());
            const served = servedOrder(cluster, controllers);
            controllers.forEach((controller, place) => place % 3 === 1 && controller.abort());
            expect(stats().pending).toBe(80);
            taken.connection.release();
            expect(await served).toEqual(kept);
            await countsAfterReset(cluster, { nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
        }
    });

    it('releases the connection that arrives for a call aborted while it logged in', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port, 2);
        const stats = () => cluster.getPoolStats()[0];
        await cluster.getConnection();
        const controller = new AbortController();
        const reason = new Error('gave up');
        const aborted = quiet(cluster.getConnection({ signal: controller.signal }));
        const arrived = nextRelease(cluster);
        // the second connection of the node is being opened: it counts as used, nothing waits
        expect(stats()).toEqual({ nodeId: 4, used: 2, idle: 0, pending: 0, limit: 2 });

        controller.abort(reason);
        expect((await stateOf(aborted)).reason).toBe(reason);
        await arrived;
        expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 1, pending: 0, limit: 2 });
        expect(server.logins()).toBe(2);
    });

    it('hands the released connection of an aborted login to the next call', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port, 2);
        const stats = () => cluster.getPoolStats()[0];
        await cluster.getConnection();
        const controller = new AbortController();
        cluster.getConnection({ signal: controller.signal }).catch(() => undefined);
        const arrived = nextRelease(cluster);
        controller.abort();
        await arrived;

        const next = await cluster.getConnection();
        expect(await ask(next.connection)).toHaveLength(STATUS.length);
        expect(stats()).toEqual({ nodeId: 4, used: 2, idle: 0, pending: 0, limit: 2 });
        expect(server.logins()).toBe(2);
    });

    it('gives back the idle connection of a call that is aborted in the same turn', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        const stats = () => cluster.getPoolStats()[0];
        const controller = new AbortController();
        const aborted = quiet(cluster.getConnection({ signal: controller.signal }));
        const arrived = nextRelease(cluster);
        // mysql2 took the idle connection for the call and hands it over one tick later
        expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 0, pending: 0, limit: 1 });

        controller.abort();
        expect((await stateOf(aborted)).reason).toBe(controller.signal.reason);
        await arrived;
        expect(stats()).toEqual({ nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
        expect(server.logins()).toBe(1);
    });

    // Events is one emitter for every cluster of this file, so the listener throws once only
    it('survives a release listener that throws when an aborted call gives back', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        const controller = new AbortController();
        let armed = true;
        const thrown = new Promise<void>(resolve => cluster.on('release', () => {
            if (!armed) return;
            armed = false;
            resolve();
            throw new Error('release listener threw');
        }));
        quiet(cluster.getConnection({ signal: controller.signal }));
        controller.abort();

        await thrown;
        expect(cluster.getPoolStats()[0]).toMatchObject({ used: 0, idle: 1, pending: 0 });
        expect(threadOf(await cluster.getConnection())).toBe(1);
    });

    it('queues nothing for a signal that is already aborted', async () => {
        const { cluster, stats } = await fullPool();
        const reason = new Error('too late');

        const state = await stateOf(cluster.getConnection({ signal: AbortSignal.abort(reason) }));
        expect(state.reason).toBe(reason);
        expect(reason).not.toHaveProperty('nodeId');
        expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 0, pending: 0, limit: 1 });
    });

    it('leaves the connection with the caller when the signal aborts after it came', async () => {
        const server = await listen();
        const cluster = await connectCluster(server.port);
        const controller = new AbortController();
        const { connection } = await cluster.getConnection({ signal: controller.signal });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

        controller.abort();
        expect(cluster.getPoolStats()[0]).toMatchObject({ used: 1, idle: 0 });
        expect(await ask(connection)).toHaveLength(STATUS.length);
        connection.release();
        await countsAfterReset(cluster, { nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
    });

    it('failWaiting fails a waiting call that has a signal, once, with nodeId', async () => {
        const { cluster } = await fullPool();
        const controller = new AbortController();
        const waiting = quiet(cluster.getConnection({ signal: controller.signal }));
        const error = new Error('node 4 is leaving');

        expect(cluster.failWaiting(4, error)).toBe(1);
        controller.abort(new Error('too late'));
        expect((await stateOf(waiting)).reason).toBe(error);
        expect((error as any).nodeId).toBe(4);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('failWaiting does not count a call that was aborted before it', async () => {
        const { cluster } = await fullPool();
        const controller = new AbortController();
        const reason = new Error('gave up');
        const aborted = quiet(cluster.getConnection({ signal: controller.signal }));
        cluster.getConnection().catch(() => undefined);
        controller.abort(reason);

        expect(cluster.failWaiting(4, new Error('node 4 is leaving'))).toBe(1);
        expect((await stateOf(aborted)).reason).toBe(reason);
        expect(reason).not.toHaveProperty('nodeId');
    });

    it('disconnect() fails a waiting call that has a signal, and no listener stays', async () => {
        const { cluster } = await fullPool();
        const controller = new AbortController();
        const waiting = quiet(cluster.getConnection({ signal: controller.signal }));

        await cluster.disconnect();
        const failure = await waiting.catch((e: any) => e);
        expect(failure).toBeInstanceOf(Error);
        expect(failure.nodeId).toBe(4);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    // While something traces the pool of mysql2, mysql2 queues a wrapper of the callback, which
    // the package cannot find. The call still rejects at once and no connection is lost
    it('a traced pool: the request stays in the queue and its connection goes back', () => {
        return traced(async () => {
            const { cluster, held, stats } = await fullPool();
            const controller = new AbortController();
            const reason = new Error('gave up');
            const aborted = quiet(cluster.getConnection({ signal: controller.signal }));
            const other = quiet(cluster.getConnection());

            controller.abort(reason);
            expect((await stateOf(aborted)).reason).toBe(reason);
            expect(stats().pending).toBe(2);
            held.connection.release();
            expect(threadOf(await other)).toBe(threadOf(held));
            expect(stats()).toEqual({ nodeId: 4, used: 1, idle: 0, pending: 0, limit: 1 });
        });
    });
});
