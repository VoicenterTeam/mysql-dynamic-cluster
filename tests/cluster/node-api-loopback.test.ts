import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';

// The cluster of createPoolCluster and the real mysql2 against mysql2's own server class on the
// loopback interface. It shows that the lists of mysql2 the node API reads are the ones a real
// pool keeps, which the mocked tests cannot
const COM_CHANGE_USER = 0x11;

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

// Answers the login and every query, and counts the logins
const listen = (): Promise<{ port: number, logins: () => number }> => {
    const server: any = (mysql as any).createServer();
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
            serverVersion: '8.0.36',
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => done(null)
        });
        // the pool changes the database of a connection before a query of its own
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (!known && code === COM_CHANGE_USER) {
                connection.sequenceId = 1;
                connection.writeOk();
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
                logins: () => connections.length
            });
        });
    });
};

// a test that fails before its own disconnect() must not leave timers and sockets behind
const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.connected && cluster.disconnect()));

// One node with one connection. flags are set, so connect() asks no server first, and the
// next health check is ten minutes away, so only the test asks for connections
const connectCluster = async (port: number): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port, id: 4, connectionLimit: 1 }],
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
        expect(stats()).toEqual({ nodeId: 4, used: 0, idle: 1, pending: 0, limit: 1 });
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
