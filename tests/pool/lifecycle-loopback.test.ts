jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { init: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: {
        init: jest.fn(), registerPools: jest.fn(), unregisterPools: jest.fn(),
        recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn(),
        recordHealthCheck: jest.fn()
    }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn(), disconnect: jest.fn() }
}));

import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Events from '../../src/utils/Events';
import Logger from '../../src/utils/Logger';

// The real Pool and the real mysql2 against mysql2's own server class on the loopback
// interface: a listener of the app that throws inside an event of mysql2, and the idle
// connections the server closed
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

// Answers the login and every query, and closes every connection it holds when asked
const listen = async (): Promise<{ port: number, hangUp: () => void }> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    const hangUp = () => connections.splice(0).forEach(connection => connection.stream.destroy());
    closers.push(() => {
        hangUp();
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
        // the release() of a lent connection resets it
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (!known && code === COM_RESET_CONNECTION) {
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
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server._server.address() as AddressInfo).port, hangUp };
};

// A pool of the legacy check, so its check draws a connection of the pool. flags are set,
// so connect() asks no server first, and the next check is ten minutes away
const pools: any[] = [];
afterEach(() => pools.splice(0).forEach(pool => pool.disconnect()));
const makePool = (port: number, host: object = {}): any => {
    const settings = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port, ...host }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            timerCheckRange: { start: 600000, end: 600000 }
        }
    } as any);
    const pool = new Pool({ id: 1, ...settings.hosts[0] }, 'test');
    pools.push(pool);
    return pool;
};

// Poll until `done` says yes. It gives up after 300 turns, about 3 s, and says what it saw
const until = async (done: () => boolean, saw: () => unknown): Promise<void> => {
    for (let turn = 0; turn < 300 && !done(); turn++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!done()) throw new Error('gave up waiting, saw ' + JSON.stringify(saw()));
};
// A call that has not settled after 2 s is one that never will
const within = <T = any>(call: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout;
    const late = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('still pending')), 2000);
    });
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
};

// Events has no way to remove a listener: each one hands its calls to the test's own
const EVENTS = ['connection', 'acquire', 'release', 'pool_disconnected'];
const listeners: { [event: string]: () => void } = {};
EVENTS.forEach(event => {
    Events.on(event as any, () => listeners[event]?.());
});
afterEach(() => EVENTS.forEach(event => delete listeners[event]));
// a second release listener, added after the one above
let releasedAfter = 0;
Events.on('release', () => { releasedAfter++; });
const throwsOn = (event: string) => {
    listeners[event] = () => { throw new Error('a bug of the app in its ' + event + ' listener'); };
};
const warnLines = (): any[][] => (Logger.warn as jest.Mock).mock.calls
    .filter(([message]) => String(message).includes('listener'));

describe('a listener of the app that throws inside an event of mysql2', () => {
    beforeEach(() => jest.clearAllMocks());

    it('acquire: getConnection() gets the connection, and its release() gives it back', async () => {
        const server = await listen();
        const pool = makePool(server.port);
        await pool.connect();
        throwsOn('acquire');

        const connection: any = await within(pool.getConnection());
        connection.release();
        await until(() => pool.stats().idle === 1, () => pool.stats());

        expect(pool.stats()).toEqual({ used: 0, idle: 1, pending: 0 });
        expect(warnLines()).toHaveLength(1);
        expect(warnLines()[0][1]).toEqual({ nodeId: 1, pool: '127.0.0.1:' + server.port,
            error: 'a bug of the app in its acquire listener' });
    });

    it('release: query() settles, and the connection is idle in the pool', async () => {
        const server = await listen();
        const pool = makePool(server.port);
        await pool.connect();
        throwsOn('release');
        releasedAfter = 0;

        const rows = await within(pool.query('SHOW GLOBAL STATUS'));

        expect(rows).toHaveLength(STATUS.length);
        // the listener added after the one that threw still hears the release
        expect(releasedAfter).toBe(1);
        expect(pool.stats()).toEqual({ used: 0, idle: 1, pending: 0 });
        expect(warnLines().map(([, meta]) => meta.error)).toEqual(
            ['a bug of the app in its release listener']);
    });

    it('connection: connect() passes on the connection its check opened', async () => {
        const server = await listen();
        const pool = makePool(server.port);
        throwsOn('connection');

        await within(pool.connect());

        expect([pool.status.isValid, pool.stats()]).toEqual(
            [true, { used: 0, idle: 1, pending: 0 }]);
        expect(warnLines().map(([, meta]) => meta.error)).toEqual(
            ['a bug of the app in its connection listener']);
    });

    it('a listener that throws a value with no readable message is logged too', async () => {
        const server = await listen();
        const pool = makePool(server.port);
        await pool.connect();
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        listeners.acquire = () => { throw proxy; };

        const connection: any = await within(pool.getConnection());
        connection.release();

        expect(warnLines()).toHaveLength(1);
        expect(warnLines()[0][1].error).toBe('unreadable error');
    });
});

describe('a pool_disconnected listener that throws, on a cluster of two nodes', () => {
    it('cluster.disconnect() closes both nodes, and the throw is logged', async () => {
        jest.clearAllMocks();
        const [one, two] = [await listen(), await listen()];
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: [one.port, two.port].map((port, index) => ({
                host: '127.0.0.1', port, id: index + 1
            })),
            defaultPoolSettings: {
                user: 'u', password: 'p', database: 'd', flags: [],
                timerCheckRange: { start: 600000, end: 600000 }
            },
            useClusterHashing: false
        } as any);
        try {
            await cluster.connect();
            await until(() => cluster.pools.every((pool: any) => pool.status.isValid),
                () => cluster.pools.map((pool: any) => pool.status.isValid));
            let thrown = false;
            listeners.pool_disconnected = () => {
                if (thrown) return;
                thrown = true;
                throw new Error('a bug of the app in its pool_disconnected listener');
            };

            await expect(cluster.disconnect()).resolves.toBeUndefined();

            expect(cluster.pools.map((pool: any) => [
                pool.status.active, pool._pool._closed, pool._reaper._timer === null
            ])).toEqual([[false, true, true], [false, true, true]]);
            expect(warnLines().map(([, meta]) => [meta.nodeId, meta.error])).toEqual(
                [[1, 'a bug of the app in its pool_disconnected listener']]);
        } finally {
            cluster.pools.forEach((pool: any) => pool.disconnect());
        }
    });
});

describe('idle connections of the pool that the server closed', () => {
    // The age rule keeps minConnections, so before 4.1.1 the reaper kept every connection
    // mysql2 had taken out of its lists itself
    it('are forgotten by the reaper at its next tick', async () => {
        const server = await listen();
        const pool = makePool(server.port, { connectionLimit: 3, idleCheckInterval: 50 });
        await pool.connect();
        const held = await Promise.all([1, 2, 3].map(() => pool.getConnection()));
        held.forEach(connection => connection.release());
        await until(() => pool.stats().idle === 3, () => pool.stats());
        const known = () => pool._reaper._idleConnections.size;
        const before = known();

        server.hangUp();
        await until(() => pool.stats().idle === 0, () => pool.stats());
        await until(() => known() === 0, known);

        expect([before, known()]).toEqual([3, 0]);
    });
});
