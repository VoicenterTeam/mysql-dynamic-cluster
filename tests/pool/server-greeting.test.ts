import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { flagsForServer, probeServer } from '../../src/pool/ServerFlags';

// mysql2's own server class on the loopback interface: real packets, no database
const CLIENT_QUERY_ATTRIBUTES = 1 << 27;
const BASE_CAPABILITIES = 0x00ffffff;

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(10000);

const servers: any[] = [];

const listen = (serverVersion: string, capabilityFlags: number, refuse = false): Promise<number> => {
    const server: any = (mysql as any).createServer();
    servers.push(server);
    server.on('connection', (connection: any) => {
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion,
            connectionId: 1,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags,
            authCallback: (_params: object, done: (err: null, mysqlError?: object) => void) =>
                refuse ? done(null, { message: 'Access denied', code: 1045 }) : done(null)
        });
        connection.on('quit', () => connection.close());
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve((server._server.address() as AddressInfo).port));
    });
};

const probe = (port: number) =>
    probeServer({ host: '127.0.0.1', port, user: 'u', password: 'p', database: 'd' });

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

describe('probeServer against a real greeting packet', () => {
    it('reads the version and the capability of an old server, which turns the flag off', async () => {
        const port = await listen('8.0.25-15.1', BASE_CAPABILITIES | CLIENT_QUERY_ATTRIBUTES);
        const greeting = await probe(port);

        expect(greeting.serverVersion).toBe('8.0.25-15.1');
        expect(greeting.capabilityFlags & CLIENT_QUERY_ATTRIBUTES).not.toBe(0);
        expect(flagsForServer(greeting).flags).toEqual(['-CLIENT_QUERY_ATTRIBUTES']);
    });

    it('reads a new server, which keeps the default flags', async () => {
        const port = await listen('8.0.36', BASE_CAPABILITIES | CLIENT_QUERY_ATTRIBUTES);

        expect(flagsForServer(await probe(port))).toStrictEqual({ reason: 'supported' });
    });

    it('reads a server that does not announce query attributes', async () => {
        const port = await listen('8.0.22', BASE_CAPABILITIES);
        const greeting = await probe(port);

        expect(greeting.capabilityFlags & CLIENT_QUERY_ATTRIBUTES).toBe(0);
        expect(flagsForServer(greeting)).toStrictEqual({ reason: 'not_announced' });
    });

    it('rejects when the login is refused', async () => {
        const port = await listen('8.0.25', BASE_CAPABILITIES | CLIENT_QUERY_ATTRIBUTES, true);

        await expect(probe(port)).rejects.toMatchObject({ code: 'ER_ACCESS_DENIED_ERROR' });
    });

    it('rejects when nothing listens', async () => {
        const port = await listen('8.0.25', BASE_CAPABILITIES);
        await new Promise(resolve => servers.pop().close(resolve));

        await expect(probe(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
});
