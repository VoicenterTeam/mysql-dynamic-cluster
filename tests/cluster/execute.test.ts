import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import Redis from '../../src/Redis/Redis';

// cluster.execute() and the execute query option, with the cluster of createPoolCluster and
// the real mysql2 against mysql2's own server class on the loopback interface. The fake server
// writes down every command of the app: a text statement as it is, 'prepare <sql>',
// 'execute <values as JSON>', 'reset' and 'close'. It keeps the sql_mode of each session and
// sets bit 512 of the status flags of every OK header while NO_BACKSLASH_ESCAPES is on, as
// MySQL does
const COM_CHANGE_USER = 0x11;
const COM_STMT_CLOSE = 0x19;
const COM_RESET_CONNECTION = 0x1f;
const AUTOCOMMIT = 2;
const NO_BACKSLASH_ESCAPES = 512;
const LONG = 600000;

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(20000);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach(close => close()));

// mysql2's server class does not count the packets of a client command and says so on stderr.
// Only that line is dropped. Each test sets it again: the spies of a test are restored after it
const consoleError = console.error;
beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('got packets out of order')) consoleError(...args);
    });
});

const column = (name: string) => ({
    catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: '',
    characterSet: 33, columnLength: 384, columnType: 253, flags: 0, decimals: 0
});
// What the health check of a pool wants to see from a node. The node that reports fewer
// connections has the lower load score, and a query tries it first
const status = (connections: number) => [
    { Variable_name: 'wsrep_ready', Value: 'ON' },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '1' },
    { Variable_name: 'Connections', Value: String(connections) },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0' }
];

// the statements of the app
const SELECT = 'SELECT ? AS v';
const NBE_ON = "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'";
const NBE_OFF = 'SET SESSION sql_mode = DEFAULT';
const CLEAN = 'UPDATE t SET a = 1';
// answered with a deadlock: the connection is dirty and is reset before it goes back
const FAIL = 'UPDATE t SET b = 1';

// The reply to a prepare: the id of the statement, no columns and no parameters. mysql2 sends
// the values it was given, whatever count of parameters the reply says. In the shape
// writePacket() of mysql2's server class takes
const prepareOk = (statementId: number) => {
    // the header of 4 bytes, then 0, the id, and zeros for columns, parameters and warnings
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(statementId, 5);
    return {
        buffer,
        length: () => buffer.length,
        writeHeader: (sequenceId: number) => {
            buffer.writeUIntLE(buffer.length - 4, 0, 3);
            buffer[3] = sequenceId;
        }
    };
};

// What a node does from the moment a test says so. Until then it answers everything
type Mode = 'answers' | 'ignores the prepare';

interface INode {
    port: number,
    become: (next: Mode) => void,
    // closes the listening socket: a new connection is refused, the open ones stay
    stop: () => void,
    // what the connections of the pool got, in order. The check connection is left out
    app: () => string[],
    logins: () => number,
    // the sockets of the client that closed
    closed: () => number
}

const listen = async (connections = 1): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const sockets: any[] = [];
    const got: { id: number, what: string }[] = [];
    const checks = new Set<number>();
    const seen = { logins: 0, closed: 0, statements: 0 };
    let mode: Mode = 'answers';
    let listening = true;
    const stop = () => {
        if (listening) server.close();
        listening = false;
    };
    closers.push(() => {
        sockets.forEach(connection => connection.stream.destroy());
        stop();
    });
    server.on('connection', (connection: any) => {
        const id = sockets.push(connection);
        // the sql_mode of this session, as a server keeps it
        const session = { noBackslashEscapes: false };
        const ok = (affectedRows = 0) => {
            const mode = session.noBackslashEscapes ? NO_BACKSLASH_ESCAPES : 0;
            connection.sequenceId = 1;
            connection.writeOk({ affectedRows, serverStatus: AUTOCOMMIT | mode });
        };
        connection.on('error', () => undefined);
        connection.stream.on('close', () => seen.closed++);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: id,
            statusFlags: AUTOCOMMIT,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => {
                seen.logins++;
                done(null);
            }
        });
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known) return;
            // the check connection changes the user before its status query
            if (code === COM_CHANGE_USER) return ok();
            // no reply: the client sends it and goes on
            if (code === COM_STMT_CLOSE) return got.push({ id, what: 'close' });
            if (code !== COM_RESET_CONNECTION) return;
            got.push({ id, what: 'reset' });
            // a reset brings back the sql_mode of the server
            session.noBackslashEscapes = false;
            ok();
        });
        const answer = (sql: string) => {
            got.push({ id, what: sql });
            connection.sequenceId = 1;
            if (sql.startsWith('SHOW GLOBAL STATUS')) {
                checks.add(id);
                const columns = [column('Variable_name'), column('Value')];
                return connection.writeTextResult(status(connections), columns);
            }
            if (sql === FAIL) {
                return connection.writeError({ code: 1213, message: 'Deadlock found' });
            }
            if (sql === NBE_ON) session.noBackslashEscapes = true;
            if (sql === NBE_OFF) session.noBackslashEscapes = false;
            ok();
        };
        connection.on('query', answer);
        // a prepare of the protocol, and a text SET, which mysql2's server class hands to
        // this event too
        connection.on('stmt_prepare', (sql: string) => {
            if (sql.startsWith('SET ')) return answer(sql);
            got.push({ id, what: 'prepare ' + sql });
            if (mode === 'ignores the prepare') return;
            connection.sequenceId = 1;
            connection.writePacket(prepareOk(++seen.statements));
        });
        connection.on('stmt_execute', (...args: unknown[]) => {
            // the values, as mysql2's server class reads them from the packet
            got.push({ id, what: 'execute ' + JSON.stringify(args[3]) });
            ok(1);
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        stop,
        app: () => got.filter(entry => !checks.has(entry.id)).map(entry => entry.what),
        logins: () => seen.logins,
        closed: () => seen.closed
    };
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));
afterEach(() => jest.restoreAllMocks());

// Nodes with ids 1, 2, ... on the database d, each pool with one connection: the next call on
// a node gets the connection the call before it had. The node listed first reports fewer
// connections, so a query tries it first. The health check asks on a connection of its own,
// and no check runs after the one of connect()
const clusterOf = async (...nodes: INode[]): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: nodes.map((node, index) => ({ host: '127.0.0.1', port: node.port, id: index + 1 })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 1,
            healthCheck: { interval: LONG, passive: false },
            idleCheckInterval: LONG, queryTimeout: 2000, resetTimeout: 300
        },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // every node has had its first check, so every node takes queries
    await cluster.ready;
    return cluster;
};
const twoNodes = async () => {
    const [n1, n2] = [await listen(1), await listen(9)];
    return { cluster: await clusterOf(n1, n2), n1, n2 };
};

// what the call ends with: the result, or the error
const settle = (call: Promise<any>): Promise<{ result?: any, error?: any }> =>
    call.then(result => ({ result }), error => ({ error }));
const stats = (cluster: any, nodeId: number) =>
    cluster.getPoolStats().find((pool: any) => pool.nodeId === nodeId);
const until = async (done: () => boolean) => {
    for (let waited = 0; waited < 5000 && !done(); waited += 5) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};

// the two forms of a call that asks for bound values
const forms: [string, (cluster: any, values: unknown, options?: object) => Promise<any>][] = [
    ['execute()', (cluster, values, options) => cluster.execute(SELECT, values, options)],
    ['query() with execute: true', (cluster, values, options) =>
        cluster.query(SELECT, values, { ...options, execute: true })]
];

describe('query() without execute', () => {
    it('sends one text query with the value in its text, and no prepare', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);

        await cluster.query(SELECT, ['x']);

        expect(node.app()).toEqual(["SELECT 'x' AS v"]);
    });
});

describe.each(forms)('%s', (_name, run) => {
    it('sends a prepare and an execute: the text holds only ?, the value is a parameter',
        async () => {
            const node = await listen();
            const cluster = await clusterOf(node);

            const result = await run(cluster, ['x']);

            expect(result.affectedRows).toBe(1);
            expect(node.app()).toEqual(['prepare ' + SELECT, 'execute ["x"]']);
        });

    it('is one command the second time the statement runs on the connection', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);

        await run(cluster, ['x']);
        await run(cluster, ['y']);

        expect(node.app()).toEqual(['prepare ' + SELECT, 'execute ["x"]', 'execute ["y"]']);
    });

    it.each([
        ['an object', { v: 'x' }],
        ['a string', 'x'],
        ['an array that holds undefined', [undefined]],
        ['an array that holds a function', [() => 'x']]
    ])('rejects values given as %s with a TypeError, and asks no node', async (_kind, values) => {
        const node = await listen();
        const cluster = await clusterOf(node);
        const logins = node.logins();

        const { error } = await settle(run(cluster, values));

        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('execute');
        expect(node.app()).toEqual([]);
        expect(node.logins()).toBe(logins);
    });
});

describe('execute()', () => {
    it('prepares again after a reset, which clears the statements mysql2 keeps', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);

        await cluster.execute(SELECT, ['x']);
        // a failed statement leaves the connection dirty: it is reset before it goes back
        await settle(cluster.query(FAIL));
        await cluster.execute(SELECT, ['y']);

        expect(node.app()).toEqual([
            'prepare ' + SELECT, 'execute ["x"]', FAIL, 'reset', 'close',
            'prepare ' + SELECT, 'execute ["y"]'
        ]);
    });

    it('reads no Redis and writes none, whatever the redis option says', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        const get = jest.spyOn(Redis, 'get').mockResolvedValue(null);
        const set = jest.spyOn(Redis, 'set').mockImplementation(async () => undefined);

        await cluster.execute(SELECT, ['x'], { redis: true });
        expect([get.mock.calls.length, set.mock.calls.length]).toEqual([0, 0]);

        // the same option on a query() reads and writes it
        await cluster.query(SELECT, ['x'], { redis: true });
        expect([get.mock.calls.length, set.mock.calls.length]).toEqual([1, 1]);
    });

    it('with no values: a prepare and an execute without parameters', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);

        await cluster.execute(CLEAN);

        expect(node.app()).toEqual(['prepare ' + CLEAN, 'execute []']);
    });
});

describe('a connection whose last header has bit 512, NO_BACKSLASH_ESCAPES', () => {
    it('refuses a query() with values before anything is sent, and tries no other node',
        async () => {
            const { cluster, n1, n2 } = await twoNodes();
            await cluster.query(NBE_ON);
            const logins = n2.logins();

            const { error } = await settle(cluster.query(SELECT, ['x'], { maxRetry: 2 }));

            expect([error.code, error.nodeId, error.sent])
                .toEqual(['MDC_UNSAFE_SQL_MODE', 1, false]);
            expect(error.message).toContain('NO_BACKSLASH_ESCAPES');
            expect(error.message).toContain('execute');
            expect(n1.app()).toEqual([NBE_ON]);
            expect(n2.app()).toEqual([]);
            expect(n2.logins()).toBe(logins);
        });

    it('releases the connection as it is: no reset, not destroyed', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);
        const [logins, closed] = [node.logins(), node.closed()];

        await settle(cluster.query(SELECT, ['x']));
        await cluster.query(CLEAN);

        expect(node.app()).toEqual([NBE_ON, CLEAN]);
        expect([node.logins(), node.closed()]).toEqual([logins, closed]);
        expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1 });
    });

    it('still runs execute() and a query() without values', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);

        await cluster.execute(SELECT, ['x']);
        await cluster.query(CLEAN);

        expect(node.app()).toEqual([NBE_ON, 'prepare ' + SELECT, 'execute ["x"]', CLEAN]);
    });

    it('lets values through again once a header comes without the bit', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);
        await cluster.query(NBE_OFF);

        await cluster.query(SELECT, ['x']);

        expect(node.app()).toEqual([NBE_ON, NBE_OFF, "SELECT 'x' AS v"]);
    });

    it('counts as off after a reset, until a header says otherwise', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);
        await settle(cluster.query(FAIL));

        await cluster.query(SELECT, ['x']);

        expect(node.app()).toEqual([NBE_ON, FAIL, 'reset', "SELECT 'x' AS v"]);
    });
});

describe('named values', () => {
    it('a value that holds a quote arrives escaped, with no setting', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);

        await cluster.query('SELECT :n AS v', { n: "a'b" });

        expect(node.app()).toEqual(["SELECT 'a\\'b' AS v"]);
    });
});

describe('execute() goes the way of query()', () => {
    it('an abort during the prepare rejects with the reason as it is, destroys the ' +
        'connection and tries no other node', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores the prepare');
        const closed = n1.closed();
        const controller = new AbortController();
        const reason = new Error('caller gave up');

        const call = settle(cluster.execute(SELECT, ['x'], {
            signal: controller.signal, maxRetry: 2
        }));
        await until(() => n1.app().length > 0);
        controller.abort(reason);
        const { error } = await call;

        expect(error).toBe(reason);
        expect(n1.app()).toEqual(['prepare ' + SELECT]);
        expect(n2.app()).toEqual([]);
        await until(() => n1.closed() > closed);
        expect(n1.closed()).toBe(closed + 1);
    });

    it('a refused connection: the next node gets the statement', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.stop();

        const result = await cluster.execute(SELECT, ['x'], { maxRetry: 2 });

        expect(result.affectedRows).toBe(1);
        expect(n1.app()).toEqual([]);
        expect(n2.app()).toEqual(['prepare ' + SELECT, 'execute ["x"]']);
    });
});
