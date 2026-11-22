import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import Redis from '../../src/Redis/Redis';

// cluster.execute() and the execute query option, with the cluster of createPoolCluster and
// the real mysql2 against mysql2's own server class on the loopback interface. The fake server
// writes down every command of the app: a text statement as it is, 'prepare <sql>',
// 'execute <values as JSON>', 'reset' and 'close <statement id>'. It keeps the sql_mode of
// each session and sets bit 512 of the status flags of every OK header while
// NO_BACKSLASH_ESCAPES is on, as MySQL does. A USE gets bit 0x4000, session state changed, as
// from a server that tracks the schema
const COM_CHANGE_USER = 0x11;
const COM_STMT_CLOSE = 0x19;
const COM_RESET_CONNECTION = 0x1f;
const AUTOCOMMIT = 2;
const NO_BACKSLASH_ESCAPES = 512;
const SESSION_STATE_CHANGED = 0x4000;
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
// answered with rows, which carry no OK header: the sql_mode stays unknown
const ROWS = 'SELECT a FROM t';
const ROWS_OF = 'SELECT a FROM t WHERE a = ?';
// what the pool sends to read the sql_mode of a session it does not know
const DO_0 = 'DO 0';

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
type Mode =
    | 'answers'
    | 'ignores the prepare'
    // answers a prepare with 1064, a syntax error
    | 'refuses the prepare'
    // answers a prepare with 1047, as a Galera node outside the primary component does
    | 'is not ready for the prepare'
    | 'ignores DO 0'
    // answers DO 0 with 1047
    | 'is not ready for DO 0';

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

// `serverMode`: the sql_mode of the server has NO_BACKSLASH_ESCAPES, so every session starts
// with it and a reset brings it back
const listen = async (connections = 1, serverMode = false): Promise<INode> => {
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
        const session = { noBackslashEscapes: serverMode };
        const ok = (affectedRows = 0, changed = 0) => {
            const mode = session.noBackslashEscapes ? NO_BACKSLASH_ESCAPES : 0;
            connection.sequenceId = 1;
            connection.writeOk({ affectedRows, serverStatus: AUTOCOMMIT | mode | changed });
        };
        const refuse = (code: number, message: string) => {
            connection.sequenceId = 1;
            connection.writeError({ code, message });
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
        connection.on('packet', (packet: any, known: boolean, code: number) => {
            if (known) return;
            // the check connection changes the user before its status query
            if (code === COM_CHANGE_USER) return ok();
            if (code === COM_STMT_CLOSE) {
                // the command, then the id of the statement. No reply: the client goes on
                packet.readInt8();
                return got.push({ id, what: 'close ' + packet.readInt32() });
            }
            if (code !== COM_RESET_CONNECTION) return;
            got.push({ id, what: 'reset' });
            // a reset brings back the sql_mode of the server
            session.noBackslashEscapes = serverMode;
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
            if (sql === FAIL) return refuse(1213, 'Deadlock found');
            if (sql === DO_0 && mode === 'ignores DO 0') return;
            if (sql === DO_0 && mode === 'is not ready for DO 0') {
                return refuse(1047, 'WSREP not ready');
            }
            if (sql.startsWith(ROWS)) {
                return connection.writeTextResult([{ a: '1' }], [column('a')]);
            }
            if (sql.startsWith('USE ')) return ok(0, SESSION_STATE_CHANGED);
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
            if (mode === 'refuses the prepare') return refuse(1064, 'You have an error');
            if (mode === 'is not ready for the prepare') return refuse(1047, 'WSREP not ready');
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
const clusterOf = async (...nodes: INode[]): Promise<any> => clusterWith({}, ...nodes);
// the same, with pool settings of the test on top
const clusterWith = async (settings: object, ...nodes: INode[]): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: nodes.map((node, index) => ({ host: '127.0.0.1', port: node.port, id: index + 1 })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 1,
            healthCheck: { interval: LONG, passive: false },
            idleCheckInterval: LONG, queryTimeout: 2000, resetTimeout: 300,
            ...settings
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
// what the call ends with within `ms`, or 'still waiting'
const within = (ms: number, call: Promise<any>) => Promise.race([
    settle(call),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), ms))
]) as Promise<{ result?: any, error?: any } | 'still waiting'>;

// What unprepare() of mysql2 3.24 sends for one statement: two closes. Its cache calls the
// eviction handler, which closes, on delete, and unprepare() closes again. The server ignores
// a close of a statement it does not have, and no close gets a reply
const closes = (statementId: number) => ['close ' + statementId, 'close ' + statementId];

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

        // DO 0 first: the sql_mode of a new connection is unknown
        expect(node.app()).toEqual([DO_0, "SELECT 'x' AS v"]);
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
        // mysql2 skips a hole in its own check, then fails the execute after the prepare
        ['an array with a hole', [, 'x']],
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
            'prepare ' + SELECT, 'execute ["x"]', FAIL, 'reset', 'close 1',
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

    it('closes what it prepared before a USE of another database, and prepares again there',
        async () => {
            const node = await listen();
            const cluster = await clusterOf(node);

            await cluster.execute(SELECT, ['x']);
            await cluster.execute(SELECT, ['y'], { database: 'b' });

            expect(node.app()).toEqual([
                'prepare ' + SELECT, 'execute ["x"]',
                ...closes(1), 'USE `b`', 'prepare ' + SELECT, 'execute ["y"]'
            ]);
        });

    it('keeps what it prepared when the USE goes back to the database it was prepared in',
        async () => {
            const node = await listen();
            const cluster = await clusterOf(node);

            await cluster.execute(SELECT, ['x']);
            // the header says the session changed: the next statement sends USE first
            await cluster.query('USE other');
            await cluster.execute(SELECT, ['y']);

            expect(node.app()).toEqual([
                'prepare ' + SELECT, 'execute ["x"]', 'USE other', 'USE `d`', 'execute ["y"]'
            ]);
        });

    it('closes what it prepared before it lends the connection to the app', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.execute(SELECT, ['x']);
        await cluster.query('USE other');

        const { connection } = await cluster.getConnection();
        try {
            // on database other now: the statement the pool prepared in d must not run
            await connection.promise().execute(SELECT, ['y']);
        } finally {
            connection.release();
        }

        expect(node.app()).toEqual([
            'prepare ' + SELECT, 'execute ["x"]', 'USE other',
            ...closes(1), 'prepare ' + SELECT, 'execute ["y"]'
        ]);
    });

    it('keeps at most maxPreparedStatements statements on a connection', async () => {
        const node = await listen();
        const cluster = await clusterWith({ maxPreparedStatements: 2 }, node);

        for (const n of [1, 2, 3, 1]) await cluster.execute(`SELECT ${n} + ?`, [n]);

        expect(node.app()).toEqual([
            'prepare SELECT 1 + ?', 'execute [1]',
            'prepare SELECT 2 + ?', 'execute [2]',
            ...closes(1), 'prepare SELECT 3 + ?', 'execute [3]',
            ...closes(2), 'prepare SELECT 1 + ?', 'execute [1]'
        ]);
    });

    it('gives the prepare the timeout of the query: it fails, the connection is destroyed',
        async () => {
            const node = await listen();
            const cluster = await clusterOf(node);
            node.become('ignores the prepare');
            const closed = node.closed();

            const ended = await within(3000, cluster.execute(SELECT, ['x'], { timeout: 200 }));

            expect(ended).not.toBe('still waiting');
            const { error } = ended as { error: any };
            expect([error.code, error.sent, error.nodeId])
                .toEqual(['PROTOCOL_SEQUENCE_TIMEOUT', true, 1]);
            await until(() => node.closed() > closed);
            expect(node.closed()).toBe(closed + 1);
        });

    it('a prepare the server refuses: sent, no other node, the connection is reset',
        async () => {
            const { cluster, n1, n2 } = await twoNodes();
            n1.become('refuses the prepare');

            const { error } = await settle(cluster.execute(SELECT, ['x'], { maxRetry: 2 }));

            expect([error.errno, error.sent, error.nodeId]).toEqual([1064, true, 1]);
            await until(() => n1.app().includes('reset'));
            expect(n1.app()).toEqual(['prepare ' + SELECT, 'reset']);
            expect(n2.app()).toEqual([]);
        });

    it('a prepare the node answers with 1047: the next node runs it', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('is not ready for the prepare');

        const result = await cluster.execute(SELECT, ['x'], { maxRetry: 2 });

        expect(result.affectedRows).toBe(1);
        expect(n1.app()).toEqual(['prepare ' + SELECT]);
        expect(n2.app()).toEqual(['prepare ' + SELECT, 'execute ["x"]']);
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

    it.each([
        ['an empty array', []],
        ['an object without keys', {}]
    ])('runs a query() whose values write nothing into the text: %s', async (_kind, values) => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);

        await cluster.query(CLEAN, values);

        expect(node.app()).toEqual([NBE_ON, CLEAN]);
    });

    it.each([
        ['a string', 'x'],
        ['an object with a key', { n: 'x' }]
    ])('refuses values given as %s', async (_kind, values) => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);

        const { error } = await settle(cluster.query('SELECT ? AS v, :n AS w', values));

        expect(error.code).toBe('MDC_UNSAFE_SQL_MODE');
        expect(node.app()).toEqual([NBE_ON]);
    });

    it('learns the bit from the reply to the USE the pool sends', async () => {
        const node = await listen(1, true);
        const cluster = await clusterOf(node);

        const { error } = await settle(cluster.query(SELECT, ['x'], { database: 'other' }));

        expect(error.code).toBe('MDC_UNSAFE_SQL_MODE');
        expect(node.app()).toEqual(['USE `other`']);
    });

    it('lets values through again once a header comes without the bit', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);
        await cluster.query(NBE_OFF);

        await cluster.query(SELECT, ['x']);

        expect(node.app()).toEqual([NBE_ON, NBE_OFF, "SELECT 'x' AS v"]);
    });

    it('is unknown after a reset: DO 0 reads the mode of the server again', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        await cluster.query(NBE_ON);
        await settle(cluster.query(FAIL));

        await cluster.query(SELECT, ['x']);

        expect(node.app()).toEqual([NBE_ON, FAIL, 'reset', DO_0, "SELECT 'x' AS v"]);
    });
});

describe('a connection whose sql_mode the pool does not know', () => {
    it('a server with NO_BACKSLASH_ESCAPES, a connection that only returned rows: DO 0, ' +
        'then the query() with values is refused', async () => {
        const node = await listen(1, true);
        const cluster = await clusterOf(node);
        await cluster.query(ROWS);

        const { error } = await settle(cluster.query(SELECT, ['x']));

        expect([error.code, error.sent]).toEqual(['MDC_UNSAFE_SQL_MODE', false]);
        expect(node.app()).toEqual([ROWS, DO_0]);
    });

    it('a server without it: one DO 0, then the statement, and none on the next call',
        async () => {
            const node = await listen();
            const cluster = await clusterOf(node);

            await cluster.query(ROWS_OF, ['x']);
            await cluster.query(ROWS_OF, ['y']);

            expect(node.app()).toEqual([
                DO_0, "SELECT a FROM t WHERE a = 'x'", "SELECT a FROM t WHERE a = 'y'"
            ]);
        });

    it('sends DO 0 again after a reset, and refuses when the server has the mode',
        async () => {
            const node = await listen(1, true);
            const cluster = await clusterOf(node);
            // known after this: on
            await settle(cluster.query(SELECT, ['x']));
            await settle(cluster.query(FAIL));

            const { error } = await settle(cluster.query(SELECT, ['x']));

            expect(error.code).toBe('MDC_UNSAFE_SQL_MODE');
            expect(node.app()).toEqual([DO_0, FAIL, 'reset', DO_0]);
        });

    it('sends none for execute() or a query() that writes no value into the text',
        async () => {
            const node = await listen(1, true);
            const cluster = await clusterOf(node);

            await cluster.execute(SELECT, ['x']);
            await cluster.query(ROWS);
            await cluster.query(ROWS, []);
            await cluster.query(SELECT, ['x'], { execute: true });

            expect(node.app()).toEqual([
                'prepare ' + SELECT, 'execute ["x"]', ROWS, ROWS, 'execute ["x"]'
            ]);
        });

    it('a DO 0 that gets no answer: bounded by the timeout of the query, sent false, the ' +
        'connection destroyed', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);
        node.become('ignores DO 0');
        const closed = node.closed();

        const ended = await within(3000, cluster.query(SELECT, ['x'], { timeout: 200 }));

        expect(ended).not.toBe('still waiting');
        const { error } = ended as { error: any };
        expect([error.code, error.sent]).toEqual(['PROTOCOL_SEQUENCE_TIMEOUT', false]);
        expect(node.app()).toEqual([DO_0]);
        await until(() => node.closed() > closed);
        expect(node.closed()).toBe(closed + 1);
    });

    it('a DO 0 the node answers with 1047: sent false, the next node runs the query',
        async () => {
            const { cluster, n1, n2 } = await twoNodes();
            n1.become('is not ready for DO 0');

            await cluster.query(SELECT, ['x'], { maxRetry: 2 });

            expect(n1.app()).toEqual([DO_0]);
            expect(n2.app()).toEqual([DO_0, "SELECT 'x' AS v"]);
        });
});

describe('Pool.query() called directly', () => {
    it('with values mysql2 refuses: rejects with sent false and hands the connection back',
        async () => {
            const node = await listen();
            const cluster = await clusterOf(node);
            const outcome: any = {};

            const call = cluster.pools[0].query(SELECT, { execute: true }, outcome, {
                values: [undefined]
            });
            const ended = await within(3000, call);

            expect(ended).not.toBe('still waiting');
            expect((ended as { error: any }).error).toBeInstanceOf(TypeError);
            expect(outcome.sent).toBe(false);
            expect(node.app()).toEqual([]);
            expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1 });
        });
});

describe('named values', () => {
    it('a value that holds a quote arrives escaped, with no setting', async () => {
        const node = await listen();
        const cluster = await clusterOf(node);

        await cluster.query('SELECT :n AS v', { n: "a'b" });

        expect(node.app()).toEqual([DO_0, "SELECT 'a\\'b' AS v"]);
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
