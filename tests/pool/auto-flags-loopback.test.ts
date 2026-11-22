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

// The real Pool and the real mysql2 against mysql2's own server class on the loopback interface.
// It shows which capability every login of a pool announces, which the mocked tests cannot
const CLIENT_QUERY_ATTRIBUTES = 1 << 27;

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

// Answers the login and every query, and records for each login whether it announced query attributes
const listen = (serverVersion: string): Promise<{ port: number, announced: boolean[] }> => {
    const server: any = (mysql as any).createServer();
    const announced: boolean[] = [];
    const connections: any[] = [];
    closers.push(() => {
        connections.forEach(connection => connection.stream.destroy());
        server.close();
    });
    server.on('connection', (connection: any) => {
        connections.push(connection);
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion,
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff | CLIENT_QUERY_ATTRIBUTES,
            authCallback: (_params: object, done: (err: null) => void) => {
                announced.push((connection.clientHelloReply.clientFlags & CLIENT_QUERY_ATTRIBUTES) !== 0);
                done(null);
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
            resolve({ port: (server._server.address() as AddressInfo).port, announced });
        });
    });
};

const connectPool = async (port: number, host: object = {}): Promise<void> => {
    const settings = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port, ...host }],
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd' }
    });
    const pool = new Pool({ id: 1, ...settings.hosts[0] }, 'test');
    try {
        await pool.connect();
    } finally {
        pool.disconnect();
    }
};

describe('the logins of a pool, seen from the server', () => {
    it('never announce query attributes to a server older than 8.0.26', async () => {
        const server = await listen('8.0.25-15.1');
        await connectPool(server.port);

        // the login that asks, then the first connection of the pool
        expect(server.announced).toEqual([false, false]);
    });

    it('announce them to a newer server, except for the login that asks', async () => {
        const server = await listen('8.0.36');
        await connectPool(server.port);

        expect(server.announced).toEqual([false, true]);
    });

    it('are one login less with flags in the settings, which are used as they are', async () => {
        const server = await listen('8.0.25-15.1');
        await connectPool(server.port, { flags: [] });

        expect(server.announced).toEqual([true]);
    });
});
