import mysql from 'mysql2';
import { AddressInfo, createServer } from 'net';
import { constants } from 'os';
import timers from 'timers';
import { createPoolCluster } from '../../index';

// The cluster of createPoolCluster and the real mysql2 against mysql2's own server class on the
// loopback interface. It shows what checkError holds for the errors mysql2 really makes: a
// refused login, a closed port, a server that hangs up, and the timeouts
const COM_RESET_CONNECTION = 0x1f;
const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };
const NOT_VALID = 'pool in host 127.0.0.1 is not valid';

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
const NOT_SYNCED = [{ Variable_name: 'wsrep_ready', Value: 'OFF' }, ...STATUS.slice(1)];
// what the server answers the status query with when it refuses it
const NOT_ALLOWED = { code: 1227, message: 'Access denied; you need the PROCESS privilege' };

type Mode =
    | 'accepts'
    // answers every login with error 1045, as a server does for a wrong password
    | 'refuses the login'
    // answers the status query with a node that is not ready
    | 'is not synced'
    // takes the login and the change of database, and never answers the query
    | 'never answers the query'
    // answers the status query with error 1227, as a server does for a user that may not ask.
    // It does not close the connection: mysql2 keeps the timer of a query whose connection is
    // lost, two minutes here, and that would keep jest from exiting
    | 'refuses the query'
    // takes the TCP connection and never sends its greeting
    | 'never greets'
    // closes the TCP connection as soon as it is open
    | 'hangs up';

// A server that behaves as its mode says. The mode can change while it runs
interface IServer { port: number, become: (next: Mode) => void, connections: () => number }
const listen = async (mode: Mode): Promise<IServer> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    closers.push(() => {
        connections.forEach(connection => connection.stream.destroy());
        server.close();
    });
    server.on('connection', (connection: any) => {
        connections.push(connection);
        connection.on('error', () => undefined);
        if (mode === 'hangs up') return connection.stream.destroy();
        if (mode === 'never greets') return;
        // the server class sends no SQL state with an error. A real server sends 28000 with 1045
        const writePacket = connection.writePacket.bind(connection);
        connection.writePacket = (packet: any) => {
            if (packet._name === 'Error') packet.buffer.write('28000', 8, 'latin1');
            writePacket(packet);
        };
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null, mysqlError?: object) => void) => {
                if (mode !== 'refuses the login') return done(null);
                done(null, { message: "Access denied for user 'u'@'127.0.0.1'", code: 1045 });
            }
        });
        // The pool sends no change of user. It resets a connection whose query failed, and one
        // the app had, before it uses it again
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (!known && code === COM_RESET_CONNECTION) {
                connection.sequenceId = 1;
                connection.writeOk({ serverStatus: 2 });
            }
        });
        connection.on('query', () => {
            if (mode === 'never answers the query') return;
            connection.sequenceId = 1;
            if (mode === 'refuses the query') return connection.writeError(NOT_ALLOWED);
            const rows = mode === 'is not synced' ? NOT_SYNCED : STATUS;
            connection.writeTextResult(rows, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        connections: () => connections.length
    };
};
// a port nothing listens on
const closedPort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise(resolve => server.close(resolve));
    return port;
};

// a test must not leave timers and sockets behind, whether its connect passed or not
const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));
// disconnect() as the last thing a test does with its cluster
const disconnectFinally = async (cluster: any): Promise<void> => {
    clusters.splice(clusters.indexOf(cluster), 1);
    await cluster.disconnect();
};

// The errors the checks of a test failed with, as pool_check_failed hands them out. The events
// of every cluster go through one emitter, so the first cluster of the file adds the listener
// A test that wants to act on a failed check, as a listener of an app would, sets onFailed
let failed: any[];
let onFailed: () => void;
let listening = false;
beforeEach(() => {
    failed = [];
    onFailed = () => undefined;
});

// One node per port, with ids from 1. With flags the pool logs in at once, without them it
// asks the server for its version first. The next health check is ten minutes away, so the
// only checks are the first one of connect() and the ones a test runs itself
const makeCluster = (ports: number[], withFlags = true, pool: object = {}): any => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: ports.map((port, index) => ({
            host: '127.0.0.1', port, id: index + 1, connectionLimit: 1
        })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd',
            timerCheckRange: { start: 600000, end: 600000 },
            ...(withFlags ? { flags: [] } : {}),
            ...pool
        },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    if (!listening) {
        cluster.on('pool_check_failed', ([error]: any[]) => {
            failed.push(error);
            onFailed();
        });
    }
    listening = true;
    return cluster;
};

const checkErrorOf = (entry: any) => entry.checkError;
// connect() of a cluster whose nodes may all fail, and what connect() itself ended with
const connectOf = async (cluster: any): Promise<string | undefined> => {
    return cluster.connect().then(() => undefined, (reason: string) => reason);
};

describe.each([
    ['with flags in the settings', true],
    ['without flags, so the server is asked for its version first', false]
])('a node that refuses the login with error 1045, %s', (_name, withFlags) => {
    it('has the code, errno and sqlState of the server on all three members', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port], withFlags);
        await connectOf(cluster);

        const [ready] = await cluster.ready;
        expect(ready.checkError).toStrictEqual(DENIED);
        expect((await cluster.firstReady)[0].checkError).toStrictEqual(DENIED);
        expect(cluster.nodes()[0].checkError).toStrictEqual(DENIED);
    });

    // the login that asks for the version is refused too, and the pool still logs in after it
    it('reaches the server with ' + (withFlags ? 'one login' : 'two logins'), async () => {
        const server = await listen('refuses the login');
        await connectOf(makeCluster([server.port], withFlags));

        expect(server.connections()).toBe(withFlags ? 1 : 2);
    });

    it('leaves connect() and the error of the result as they were', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port], withFlags);

        expect(await connectOf(cluster)).toBe(NOT_VALID);
        const [ready] = await cluster.ready;
        expect({ nodeId: ready.nodeId, ok: ready.ok, message: ready.error.message })
            .toEqual({ nodeId: 1, ok: false, message: NOT_VALID });
    });

    it('lets firstReady resolve on the node beside it that passes', async () => {
        const [bad, good] = [await listen('refuses the login'), await listen('accepts')];
        const cluster = makeCluster([bad.port, good.port], withFlags);
        cluster.connect().catch(() => undefined);

        const first = await cluster.firstReady;
        expect(first.filter((result: any) => result.ok)).toStrictEqual([{ nodeId: 2, ok: true }]);
        const ready = await cluster.ready;
        expect(ready.map(checkErrorOf)).toStrictEqual([DENIED, undefined]);
        expect(cluster.nodes().map(checkErrorOf)).toStrictEqual([DENIED, undefined]);
    });
});

// The check of these connects ended and the server refused. What comes after that check, a
// disconnect() or another connect(), must not turn the code of the server into an empty object
describe('a refused login whose check ran to its end', () => {
    it.each([
        ['with flags in the settings', true],
        ['without flags', false]
    ])('keeps its code when a listener disconnects on that check, %s', async (_name, withFlags) => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port], withFlags);
        onFailed = () => { disconnectFinally(cluster); };
        const [ready, firstReady] = [cluster.ready, cluster.firstReady];

        expect(await connectOf(cluster)).toBe(NOT_VALID);
        expect(failed.map(checkErrorOf)).toHaveLength(1);
        expect((await ready).map(checkErrorOf)).toStrictEqual([DENIED]);
        expect((await firstReady).map(checkErrorOf)).toStrictEqual([DENIED]);
    });

    it('keeps its code on the results of the first of two connect() calls', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port]);
        const first = connectOf(cluster);
        const [ready, firstReady] = [cluster.ready, cluster.firstReady];
        const second = connectOf(cluster);

        expect([await first, await second]).toEqual([NOT_VALID, NOT_VALID]);
        expect((await ready).map(checkErrorOf)).toStrictEqual([DENIED]);
        expect((await firstReady).map(checkErrorOf)).toStrictEqual([DENIED]);
        expect((await cluster.ready).map(checkErrorOf)).toStrictEqual([DENIED]);
    });
});

describe('a node whose check fails for another reason', () => {
    it('has no checkError when the server answered and a validator said no', async () => {
        const server = await listen('is not synced');
        const cluster = makeCluster([server.port]);

        expect(await connectOf(cluster)).toBe(NOT_VALID);
        expect('checkError' in (await cluster.ready)[0]).toBe(false);
        expect('checkError' in cluster.nodes()[0]).toBe(false);
        expect(failed).toEqual([]);
    });

    it('has the code and errno of the socket when nothing listens on the port', async () => {
        const cluster = makeCluster([await closedPort()]);
        await connectOf(cluster);

        const refused = { code: 'ECONNREFUSED', errno: -constants.errno.ECONNREFUSED };
        expect((await cluster.ready)[0].checkError).toStrictEqual(refused);
        expect(cluster.nodes()[0].checkError).toStrictEqual(refused);
    });

    // a code of mysql2 that is neither a network code nor a refused login
    it('has PROTOCOL_CONNECTION_LOST when the server closes the connection', async () => {
        const server = await listen('hangs up');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);

        const lost = { code: 'PROTOCOL_CONNECTION_LOST' };
        expect((await cluster.ready)[0].checkError).toStrictEqual(lost);
        expect(cluster.nodes()[0].checkError).toStrictEqual(lost);
    });
});

describe('a health check that runs out of time', () => {
    // twenty nodes on one server, so twenty checks race their two timers at once
    const RUNS = 20;

    const every = (value: unknown) => new Array(RUNS).fill(value);
    const modes: [Mode][] = [['never answers the query'], ['never greets']];

    // the timer of the check ends it, before the timer mysql2 has for the query
    it.each(modes)('gives an empty object when the server %s', async (mode) => {
        const server = await listen(mode);
        const cluster = makeCluster(every(server.port), true, { queryTimeout: 150 });
        await connectOf(cluster);

        const results = await cluster.ready;
        expect(failed.map(error => [error.message, error.code]))
            .toEqual(every(['Status check timeout', undefined]));
        expect(results.map(checkErrorOf)).toStrictEqual(every({}));
        expect(cluster.nodes().map(checkErrorOf)).toStrictEqual(every({}));
    });
});

describe('a connection that runs into the connect timeout of mysql2', () => {
    // mysql2 gives a new connection 10 s, and asks the timers module of Node for that timer.
    // The test hands it 50 ms instead, so it does not wait the 10 s. Every other timer is as it was
    const CONNECT_TIMEOUT = 10000;
    const setTimeoutOfNode = timers.setTimeout;
    let asked: jest.SpyInstance;
    beforeEach(() => {
        asked = jest.spyOn(timers, 'setTimeout').mockImplementation(((run: any, ms: number) => {
            return setTimeoutOfNode(run, ms === CONNECT_TIMEOUT ? 50 : ms);
        }) as any);
    });
    afterEach(() => asked.mockRestore());

    // the check gives the server 600 s here, so the timer of mysql2 ends first
    it('has ETIMEDOUT without an errno: mysql2 made it, not the socket', async () => {
        const server = await listen('never greets');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);

        expect(asked.mock.calls.map(call => call[1])).toContain(CONNECT_TIMEOUT);
        expect(failed.map(error => [error.message, error.code]))
            .toEqual([['connect ETIMEDOUT', 'ETIMEDOUT']]);
        expect((await cluster.ready)[0].checkError).toStrictEqual({ code: 'ETIMEDOUT' });
    });
});

describe('checkError over the life of a node', () => {
    it('is cleared by the next check that gets its answer', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);
        expect(cluster.nodes()[0].checkError).toStrictEqual(DENIED);

        server.become('accepts');
        await cluster.pools[0].status.checkStatus();
        expect(cluster.nodes()[0]).toMatchObject({ isValid: true });
        expect('checkError' in cluster.nodes()[0]).toBe(false);
    });

    it('is cleared when the next check is answered and a validator says no', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);

        server.become('is not synced');
        await cluster.pools[0].status.checkStatus();
        expect(cluster.nodes()[0]).toMatchObject({ isValid: false });
        expect('checkError' in cluster.nodes()[0]).toBe(false);
    });

    it('stays on nodes() after disconnect()', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);
        await disconnectFinally(cluster);

        expect(cluster.nodes()[0].checkError).toStrictEqual(DENIED);
    });

    it('is gone after a connect() that passes, and the new ready has none', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);
        await cluster.disconnect();
        server.become('accepts');

        expect(await connectOf(cluster)).toBeUndefined();
        expect(await cluster.ready).toStrictEqual([{ nodeId: 1, ok: true }]);
        expect('checkError' in cluster.nodes()[0]).toBe(false);
    });

    // The node passed, one later check failed and left it valid, and it was disconnected. The
    // next connect() is cut short, so no check of it is recorded. It still passes, as it did
    // before: the node kept its validity. Its result must not show the error of the old check
    it('is not on a passed result when it comes from before the last disconnect()', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster([server.port]);
        await connectOf(cluster);
        server.become('refuses the query');
        await cluster.pools[0].status.checkStatus();
        await cluster.disconnect();
        const connecting = connectOf(cluster);
        await disconnectFinally(cluster);
        await connecting;

        const old = { isValid: true, checkError: { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR' } };
        expect(cluster.nodes()[0]).toMatchObject(old);
        expect(await cluster.ready).toStrictEqual([{ nodeId: 1, ok: true }]);
    });

    // disconnect() cut the connect short, so the result has an empty object
    it.each([
        ['the server is asked for its version', false],
        ['the first check runs', true]
    ])('is an empty object when disconnect() comes while %s', async (_name, withFlags) => {
        const server = await listen('accepts');
        const cluster = makeCluster([server.port], withFlags);
        const connecting = connectOf(cluster);
        await disconnectFinally(cluster);
        await connecting;

        const [ready] = await cluster.ready;
        expect([ready.ok, ready.checkError]).toStrictEqual([false, {}]);
        expect('checkError' in cluster.nodes()[0]).toBe(false);
    });
});
