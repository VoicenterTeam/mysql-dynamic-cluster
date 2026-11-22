import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';

// Which nodes one cluster.query() sends its statement to, against the real mysql2 and
// mysql2's own server class on the loopback interface. Another node is tried only when the
// statement cannot have run on the one before: it was never sent, or the node answered 1047.
// Each fake node counts the logins and the statements of the app that reached it
const COM_CHANGE_USER = 0x11;
const LONG = 600000;

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

type Reply = { errno: number, sqlState: string, message: string };
const DEADLOCK: Reply = {
    errno: 1213, sqlState: '40001',
    message: 'Deadlock found when trying to get lock; try restarting transaction'
};
const NOT_READY: Reply = {
    errno: 1047, sqlState: '08S01', message: 'WSREP has not yet prepared node for application use'
};
const NO_DATABASE: Reply = { errno: 1049, sqlState: '42000', message: "Unknown database 'd'" };
const DENIED: Reply = {
    errno: 1045, sqlState: '28000', message: "Access denied for user 'u'@'127.0.0.1'"
};

// What a node does with the call of the app, from the moment a test says so. Until then it
// takes every login, every change of user and every statement
type Mode =
    | 'answers'
    // answers the statement with this error
    | { replies: Reply }
    // takes the statement and never answers it
    | 'stays silent'
    // closes the connection when the statement arrived
    | 'hangs up'
    // answers every new login with error 1045, as a server does for a wrong password
    | 'refuses the login'
    // never answers the change of user the pool sends before the statement
    | 'ignores the change of user'
    // answers the change of user the pool sends before the statement with this error
    | { failsChangeOfUser: Reply };

interface INode {
    port: number,
    become: (next: Mode) => void,
    // closes the listening socket: a new connection is refused, the open ones stay
    stop: () => void,
    logins: () => number,
    statements: () => number
}

const listen = async (connections: number): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const open: any[] = [];
    const seen = { logins: 0, statements: 0 };
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
        // the server class writes no SQL state of its own. A real server does
        let sqlState = 'HY000';
        const writePacket = connection.writePacket.bind(connection);
        connection.writePacket = (packet: any) => {
            if (packet._name === 'Error') packet.buffer.write(sqlState, 8, 'latin1');
            writePacket(packet);
        };
        const writeError = (reply: Reply) => {
            sqlState = reply.sqlState;
            connection.writeError({ message: reply.message, code: reply.errno });
        };
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: open.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null, mysqlError?: object) => void) => {
                seen.logins++;
                if (mode !== 'refuses the login') return done(null);
                sqlState = DENIED.sqlState;
                done(null, { message: DENIED.message, code: DENIED.errno });
            }
        });
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || code !== COM_CHANGE_USER) return;
            if (mode === 'ignores the change of user') return;
            connection.sequenceId = 1;
            const current = mode;
            if (typeof current === 'object' && 'failsChangeOfUser' in current) {
                return writeError(current.failsChangeOfUser);
            }
            connection.writeOk();
        });
        connection.on('query', (sql: string) => {
            connection.sequenceId = 1;
            if (sql.startsWith('SHOW GLOBAL STATUS')) {
                const columns = [column('Variable_name'), column('Value')];
                return connection.writeTextResult(status(connections), columns);
            }
            if (sql !== APP_SQL) return connection.writeOk();
            seen.statements++;
            const current = mode;
            if (current === 'stays silent') return;
            if (current === 'hangs up') return connection.stream.destroy();
            if (typeof current === 'object' && 'replies' in current) {
                return writeError(current.replies);
            }
            connection.writeOk({ affectedRows: 1 });
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        stop,
        logins: () => seen.logins,
        statements: () => seen.statements
    };
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));

// Two nodes with ids 1 and 2, and node 1 is tried first. The default settings otherwise:
// errorRetryCount 2, so a call may try both. The health check asks on a connection of its
// own, so the call of the app opens a new one. No check runs after the one of connect(),
// and a failed call starts none
const twoNodes = async (): Promise<{ cluster: any, n1: INode, n2: INode }> => {
    const [n1, n2] = [await listen(1), await listen(9)];
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [n1, n2].map((node, index) => ({
            host: '127.0.0.1', port: node.port, id: index + 1
        })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            healthCheck: { interval: LONG, passive: false },
            // mysql2 keeps the timer of a query whose connection was lost. A short one lets
            // the file end
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

// what the call ends with: the result, or the error
const call = (cluster: any, options: object = {}): Promise<{ result?: any, error?: any }> =>
    cluster.query(APP_SQL, undefined, { redis: false, ...options }).then(
        (result: any) => ({ result }),
        (error: any) => ({ error })
    );
const statements = (...nodes: INode[]) => nodes.map(node => node.statements());

describe('the statement reached node 1 and failed there: node 2 is not tried', () => {
    it('an error reply', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become({ replies: DEADLOCK });

        const { error } = await call(cluster);

        expect(statements(n1, n2)).toEqual([1, 0]);
        expect([error.code, error.nodeId, error.sent]).toEqual(['ER_LOCK_DEADLOCK', 1, true]);
        expect(error.errors).toEqual([]);
    });

    it('a timeout', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('stays silent');

        const { error } = await call(cluster, { timeout: 300 });

        expect(statements(n1, n2)).toEqual([1, 0]);
        expect([error.code, error.nodeId, error.sent])
            .toEqual(['PROTOCOL_SEQUENCE_TIMEOUT', 1, true]);
    });

    it('a connection lost after the statement was written', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('hangs up');

        // mysql2 keeps the timer of a statement whose connection was lost: a short one
        const { error } = await call(cluster, { timeout: 300 });

        expect(statements(n1, n2)).toEqual([1, 0]);
        expect([error.code, error.nodeId, error.sent])
            .toEqual(['PROTOCOL_CONNECTION_LOST', 1, true]);
    });
});

describe('the statement never went to node 1: node 2 is tried', () => {
    it('node 1 refused the connection', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.stop();

        const { result } = await call(cluster);

        expect(statements(n1, n2)).toEqual([0, 1]);
        expect(result.affectedRows).toBe(1);
    });

    it('the refused connection is listed with sent: false', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.stop();
        n2.become({ replies: DEADLOCK });

        const { error } = await call(cluster);

        expect([error.code, error.nodeId, error.sent]).toEqual(['ER_LOCK_DEADLOCK', 2, true]);
        expect(error.errors).toHaveLength(1);
        const [{ nodeId, error: first }] = error.errors;
        expect([nodeId, first.code, first.sent]).toEqual([1, 'ECONNREFUSED', false]);
    });

    it('node 1 failed the change of database', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become({ failsChangeOfUser: NO_DATABASE });

        const { result, error } = await call(cluster);

        expect(error).toBeUndefined();
        expect(statements(n1, n2)).toEqual([0, 1]);
        expect(result.affectedRows).toBe(1);
    });

    it('the change of database on node 1 timed out', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores the change of user');

        const { result, error } = await call(cluster, { timeout: 300 });

        expect(error).toBeUndefined();
        expect(statements(n1, n2)).toEqual([0, 1]);
        expect(result.affectedRows).toBe(1);
    });
});

describe('node 1 answered the statement with 1047, not ready', () => {
    it('node 2 is tried', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become({ replies: NOT_READY });

        const { result, error } = await call(cluster);

        expect(error).toBeUndefined();
        expect(statements(n1, n2)).toEqual([1, 1]);
        expect(result.affectedRows).toBe(1);
    });

    it('node 2 is not tried with retryNotReady: false', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become({ replies: NOT_READY });

        const { error } = await call(cluster, { retryNotReady: false });

        expect(statements(n1, n2)).toEqual([1, 0]);
        expect([error.errno, error.nodeId, error.sent]).toEqual([1047, 1, true]);
    });
});

describe('node 1 refused the login with 1045', () => {
    it('node 2 gets no login and no statement', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('refuses the login');
        const logins = n2.logins();

        await call(cluster);

        expect(n2.logins()).toBe(logins);
        expect(statements(n1, n2)).toEqual([0, 0]);
    });

    it('the caller gets the 1045 with sent: false', async () => {
        const { cluster, n1 } = await twoNodes();
        n1.become('refuses the login');

        const { error } = await call(cluster);

        expect([error.code, error.errno, error.nodeId, error.sent])
            .toEqual(['ER_ACCESS_DENIED_ERROR', 1045, 1, false]);
        expect(error.errors).toEqual([]);
    });
});
