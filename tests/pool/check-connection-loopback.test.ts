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

import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import Logger from '../../src/utils/Logger';

// The check connection of a node with a healthCheck block, with the real mysql2 against
// mysql2's own server class on the loopback interface: two checks that share a connection
// while it logs in, and what a check on a new connection logs
const COM_CHANGE_USER = 0x11;
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

type Login =
    | 'accepts'
    // answers a login with error 1045, as a server does for a wrong password
    | 'refuses'
    // never answers a login, until the test hangs up on it
    | 'holds';

// A server whose answer to a login the test sets, and may change while it runs. It counts
// the logins, can take or hang up on the ones it holds, can hang up on one connection, and
// on the next change of user
const listen = async (login: Login = 'accepts') => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    const held: { connection: any, done: (err: null) => void }[] = [];
    let hangUpOnChange = false;
    closers.push(() => {
        connections.forEach(connection => connection.stream.destroy());
        server.close();
    });
    const refuse = { message: "Access denied for user 'u'@'127.0.0.1'", code: 1045 };
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
            authCallback: (_params: object, done: (err: null, mysqlError?: object) => void) => {
                if (login === 'holds') return held.push({ connection, done });
                done(null, login === 'refuses' ? refuse : undefined);
            }
        });
        // the check changes the user of its connection before its query
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || code !== COM_CHANGE_USER) return;
            if (hangUpOnChange) {
                hangUpOnChange = false;
                return connection.stream.destroy();
            }
            connection.sequenceId = 1;
            connection.writeOk();
        });
        connection.on('query', () => {
            connection.sequenceId = 1;
            connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Login) => { login = next; },
        logins: () => connections.length,
        held: () => held.length,
        hangUpHeld: () => held.splice(0).forEach(({ connection }) => connection.stream.destroy()),
        takeHeld: () => held.splice(0).forEach(({ done }) => done(null)),
        // the connections in the order they came, from 0
        hangUp: (index: number) => connections[index].stream.destroy(),
        hangUpOnNextChange: () => { hangUpOnChange = true; }
    };
};

// A node with the block. flags are set, so connect() asks no server first. Only the test and
// passive health start a check: the interval is ten minutes
const pools: any[] = [];
afterEach(() => pools.splice(0).forEach(pool => pool.disconnect()));
const makePool = (port: number): any => {
    const settings = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            healthCheck: { interval: 600000, timeout: 5000, fall: 3 }
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
const debugLines = (text: string): any[][] => (Logger.debug as jest.Mock).mock.calls
    .filter(([message]) => String(message).includes(text));
// what a call of the app runs into when the host has no route to the node
const noRoute = () => Object.assign(new Error('connect ENETUNREACH 127.0.0.1:3306'),
    { code: 'ENETUNREACH', errno: -101, syscall: 'connect', fatal: true });

beforeEach(() => jest.clearAllMocks());

describe('two checks at once, on a connection that still logs in', () => {
    // The check of connect() opens the connection, and a second check shares it while it
    // logs in. That connection was not held from before, so neither check asks again when
    // it is lost: the path did not forget it
    it('lost during the login: neither check asks again on a new one', async () => {
        const server = await listen('holds');
        const pool = makePool(server.port);
        const connecting = pool.connect().catch((e: Error) => e.message);
        await until(() => server.held() === 1, server.held);
        const second = pool.status.checkStatus();

        server.become('accepts');
        server.hangUpHeld();
        await second;

        expect(await connecting).toBe(NOT_VALID);
        expect([server.logins(), pool.status.isValid]).toEqual([1, false]);
        expect(debugLines('the check opens a new one and asks again')).toEqual([]);
    });

    // the control: the connection was open before the check, and the server closes it under
    // the change of user of the check, as a path that forgot it does
    it('a connection that was open before is still asked again once when it is lost', async () => {
        const server = await listen();
        const pool = makePool(server.port);
        await pool.connect();

        server.hangUpOnNextChange();
        await pool.status.checkStatus();

        expect([server.logins(), pool.status.isValid, pool.checkError]).toEqual([2, true, undefined]);
        expect(debugLines('the check opens a new one and asks again')).toHaveLength(1);
    });
});

describe('a check on a new connection, beside the one the node holds', () => {
    // After a call of the app found no route, the next check asks on a new connection
    const deciding = async (login: Login) => {
        const server = await listen();
        const pool = makePool(server.port);
        await pool.connect();
        server.become(login);
        pool.status.realFailure(noRoute(), true);
        await until(() => debugLines('a new connection').length > 0, () => server.logins());
        return { server, pool };
    };

    it('that logs in: one debug line, and the node holds the new one', async () => {
        const { server, pool } = await deciding('accepts');

        expect(debugLines('a new connection')).toEqual([[
            'Pool 127.0.0.1:' + server.port + ': a check opened a new connection beside the ' +
                'one it held, and that one logged in. The old one is logged out of',
            { pool: '127.0.0.1:' + server.port, newConnection: 'logged_in' }
        ]]);
        await until(() => pool.checkError === undefined && server.logins() === 2,
            () => pool.checkError);
    });

    it('that is refused: one debug line with the code, and the old one is not kept', async () => {
        const { server } = await deciding('refuses');

        expect(debugLines('a new connection')).toEqual([[
            'Pool 127.0.0.1:' + server.port + ': a check opened a new connection beside the ' +
                'one it held, and that one failed. The old one is logged out of as well',
            { pool: '127.0.0.1:' + server.port, newConnection: 'failed',
                code: 'ER_ACCESS_DENIED_ERROR', kept: false }
        ]]);
    });

    // The old one broke while the new one logged in: it was dropped, not logged out of
    it('that logs in after the old one broke: the line says the old one was closed already',
        async () => {
            const server = await listen();
            const pool = makePool(server.port);
            await pool.connect();
            server.become('holds');
            pool.status.realFailure(noRoute(), true);
            await until(() => server.held() === 1, server.held);

            server.hangUp(0);
            await until(() => !pool._check._kept, () => 'the old one is still put aside');
            server.takeHeld();
            await until(() => debugLines('a new connection').length > 0, server.logins);

            expect(debugLines('a new connection')).toEqual([[
                'Pool 127.0.0.1:' + server.port + ': a check opened a new connection beside ' +
                    'the one it held, and that one logged in. The old one was closed already',
                { pool: '127.0.0.1:' + server.port, newConnection: 'logged_in' }
            ]]);
        });
});

describe('a check on a new connection, when the node holds no open one', () => {
    // After a call of the app found no route, on a node whose check connection is gone: the
    // check opens the only connection, as any check that finds none
    const deciding = async (login: Login) => {
        const server = await listen();
        const pool = makePool(server.port);
        await pool.connect();
        pool.dropCheckConnection();
        server.become(login);
        pool.status.realFailure(noRoute(), true);
        await until(() => debugLines('a new connection').length > 0, () => server.logins());
        return { server, pool };
    };

    it('that logs in: one debug line', async () => {
        const { server } = await deciding('accepts');

        expect(debugLines('a new connection')).toEqual([[
            'Pool 127.0.0.1:' + server.port + ': a check asked on a new connection, as the ' +
                'node held no open one, and that one logged in',
            { pool: '127.0.0.1:' + server.port, newConnection: 'logged_in' }
        ]]);
    });

    it('that is refused: one debug line with the code', async () => {
        const { server } = await deciding('refuses');

        expect(debugLines('a new connection')).toEqual([[
            'Pool 127.0.0.1:' + server.port + ': a check asked on a new connection, as the ' +
                'node held no open one, and that one failed',
            { pool: '127.0.0.1:' + server.port, newConnection: 'failed',
                code: 'ER_ACCESS_DENIED_ERROR' }
        ]]);
    });
});
