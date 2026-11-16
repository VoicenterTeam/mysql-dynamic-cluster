import mysql from 'mysql2';
import { AddressInfo, createServer, Socket } from 'net';
import { flagsForServer, probeServer } from '../../src/pool/ServerFlags';

// mysql2's own server class on the loopback interface: real packets, no database
const CLIENT_QUERY_ATTRIBUTES = 1 << 27;
const BASE_CAPABILITIES = 0x00ffffff;

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(10000);

const servers: any[] = [];

const listen = (
    serverVersion: string, capabilityFlags: number, refuse = false, closeOnQuit = true
): Promise<number> => {
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
        connection.on('quit', () => { if (closeOnQuit) connection.close(); });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve((server._server.address() as AddressInfo).port));
    });
};

const probe = (port: number) =>
    probeServer({ host: '127.0.0.1', port, user: 'u', password: 'p', database: 'd' }).greeting;

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

describe('probeServer against a real greeting packet', () => {
    it('reads the version and the capability of an old server, which turns the flag off', async () => {
        const port = await listen('8.0.25-15.1', BASE_CAPABILITIES | CLIENT_QUERY_ATTRIBUTES);
        const greeting = await probe(port);

        // the two values and nothing else of the packet, which also holds the scramble data
        expect(greeting).toStrictEqual({ serverVersion: '8.0.25-15.1', capabilityFlags: expect.any(Number) });
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

    it('rejects and closes its socket when it is cancelled, though the server never answers', async () => {
        // accepts the connection, never says a word and never closes its side:
        // only a socket the client destroys itself goes away
        const sockets: Socket[] = [];
        const silent = createServer({ allowHalfOpen: true }, socket => {
            sockets.push(socket);
            socket.on('error', () => undefined);
        });
        await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
        const port = (silent.address() as AddressInfo).port;
        const created = jest.spyOn(mysql, 'createConnection');
        const pending = probeServer({ host: '127.0.0.1', port, user: 'u', password: 'p', database: 'd' });
        const client: any = created.mock.results[0].value;
        created.mockRestore();
        const settled = expect(pending.greeting).rejects.toThrow('probe cancelled');
        while (sockets.length === 0) await new Promise(resolve => setImmediate(resolve));

        pending.cancel();
        pending.cancel();
        await settled;

        expect(client.stream.destroyed).toBe(true);
        sockets.forEach(socket => socket.destroy());
        await new Promise(resolve => silent.close(resolve));
    });

    it('closes its socket itself when the server keeps it after the logout', async () => {
        // reads the logout and does nothing about it
        const port = await listen('8.0.36', BASE_CAPABILITIES | CLIENT_QUERY_ATTRIBUTES, false, false);
        const created = jest.spyOn(mysql, 'createConnection');
        const pending = probeServer({ host: '127.0.0.1', port, user: 'u', password: 'p', database: 'd' });
        const client: any = created.mock.results[0].value;
        created.mockRestore();

        await pending.greeting;
        // the server gets its time first
        expect(client.stream.destroyed).toBe(false);
        await new Promise(resolve => setTimeout(resolve, 2300));
        expect(client.stream.destroyed).toBe(true);
    });

    it('rejects when nothing listens', async () => {
        const port = await listen('8.0.25', BASE_CAPABILITIES);
        await new Promise(resolve => servers.pop().close(resolve));

        await expect(probe(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
});
