import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';

// What a failed cluster.query() rejects with, against the real mysql2 and mysql2's own server
// class on the loopback interface: the error of mysql2 itself for the node tried last, with
// that node's id, and the errors of the nodes tried before it
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

// How a node answers a query of the app: an error packet, or it closes the connection
type Answer = { errno: number, sqlState: string, message: string } | 'hangs up';
const DEADLOCK = {
    errno: 1213, sqlState: '40001',
    message: 'Deadlock found when trying to get lock; try restarting transaction'
};
const LOCK_WAIT = {
    errno: 1205, sqlState: 'HY000',
    message: 'Lock wait timeout exceeded; try restarting transaction'
};

// A node that passes its health check and answers every other query as `answer` says
const listen = async (answer: Answer): Promise<number> => {
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
        // the pool changes the user of a connection before each query of its own
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (!known && code === COM_CHANGE_USER) {
                connection.sequenceId = 1;
                connection.writeOk();
            }
        });
        connection.on('query', (sql: string) => {
            if (sql.startsWith('SHOW GLOBAL STATUS')) {
                connection.sequenceId = 1;
                return connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
            }
            if (answer === 'hangs up') return connection.stream.destroy();
            connection.sequenceId = 1;
            // the server class writes no SQL state of its own. A real server does
            const writePacket = connection.writePacket.bind(connection);
            connection.writePacket = (packet: any) => {
                packet.buffer.write(answer.sqlState, 8, 'latin1');
                connection.writePacket = writePacket;
                writePacket(packet);
            };
            connection.writeError({ message: answer.message, code: answer.errno });
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server._server.address() as AddressInfo).port;
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));

// One node per port, with ids from 1, every node tried once. The next health check is ten
// minutes away, so the only check of a node is its first one
const connected = async (ports: number[], errorRetryCount = ports.length): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: ports.map((port, index) => ({ host: '127.0.0.1', port, id: index + 1 })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            timerCheckRange: { start: 600000, end: 600000 },
            // mysql2 keeps the timer of a query whose connection was lost. A short one lets
            // the file end
            queryTimeout: 2000
        },
        errorRetryCount,
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // every node has had its first check, so every node takes queries
    await cluster.ready;
    return cluster;
};

const failedQuery = (cluster: any): Promise<any> =>
    cluster.query('UPDATE t SET a = 1', undefined, { redis: false }).then(
        () => { throw new Error('the query passed'); },
        (error: unknown) => error
    );

describe('cluster.query() on one node that answers with error 1213', () => {
    it('rejects with the error of mysql2: its code, errno, sqlState and own message', async () => {
        const port = await listen(DEADLOCK);
        const error = await failedQuery(await connected([port]));

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe('ER_LOCK_DEADLOCK');
        expect(error.errno).toBe(1213);
        expect(error.sqlState).toBe('40001');
        expect(error.sqlMessage).toBe(DEADLOCK.message);
        expect(error.message).toBe(DEADLOCK.message);
        // mysql2 marks no error the server sent as fatal
        expect(error.fatal).toBeUndefined();
    });

    it('adds the node it came from, and no earlier errors', async () => {
        const port = await listen(DEADLOCK);
        const error = await failedQuery(await connected([port]));

        expect(error.nodeId).toBe(1);
        expect(error.errors).toEqual([]);
    });
});

describe('cluster.query() on a node that closes the connection on the query', () => {
    it('rejects with the lost connection of mysql2, fatal and without errno', async () => {
        const port = await listen('hangs up');
        const error = await failedQuery(await connected([port]));

        expect(error.code).toBe('PROTOCOL_CONNECTION_LOST');
        expect(error.fatal).toBe(true);
        expect(error.errno).toBeUndefined();
        expect(error.nodeId).toBe(1);
    });
});

describe('cluster.query() on two nodes that fail with 1213 and 1205', () => {
    it('rejects with the error of the node tried last, and lists the one before it', async () => {
        const ports = [await listen(DEADLOCK), await listen(LOCK_WAIT)];
        const error = await failedQuery(await connected(ports));

        expect(error.errors).toHaveLength(1);
        const [first] = error.errors;
        expect(first.nodeId).not.toBe(error.nodeId);
        expect(first.error.nodeId).toBe(first.nodeId);
    });

    it('has both codes, each with its own node', async () => {
        const ports = [await listen(DEADLOCK), await listen(LOCK_WAIT)];
        const error = await failedQuery(await connected(ports));

        const both = [...error.errors, { nodeId: error.nodeId, error }]
            .map((entry: any) => [entry.nodeId, entry.error.code])
            .sort();
        expect(both).toEqual([[1, 'ER_LOCK_DEADLOCK'], [2, 'ER_LOCK_WAIT_TIMEOUT']]);
    });
});

describe('cluster.query() with errorRetryCount 0', () => {
    it('still tries one node, and rejects with its error', async () => {
        const port = await listen(DEADLOCK);
        const error = await failedQuery(await connected([port], 0));

        expect(error.code).toBe('ER_LOCK_DEADLOCK');
        expect(error.nodeId).toBe(1);
    });
});

describe('cluster.query() when no node is valid', () => {
    it('rejects with the code getConnection() uses', async () => {
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: [{ host: '127.0.0.1', port: 1, id: 1 }],
            defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [] },
            useClusterHashing: false,
            logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        } as any);
        // never connected: no pool is valid
        const error = await failedQuery(cluster);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(error.nodeId).toBeUndefined();
    });
});
