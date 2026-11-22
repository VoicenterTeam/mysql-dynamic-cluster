import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import { parseSettings } from '../../src/configs/schema';
import { Pool } from '../../src/pool/Pool';
import { SessionState } from '../../src/pool/SessionState';
import { Settings } from '../../src/utils/Settings';

// The session of a pooled connection, with the cluster of createPoolCluster and the real mysql2
// against mysql2's own server class on the loopback interface. The fake server keeps the
// session the way a server does: a transaction, autocommit and the database, and puts the
// status flags of that session in every OK header. It writes down every command it got.
// A query sends no change of user. It sends USE only for another database, and a connection
// whose session the query left dirty is reset before the next caller gets it
const COM_CHANGE_USER = 0x11;
const COM_RESET_CONNECTION = 0x1f;
// status flags of an OK header
const IN_TRANSACTION = 1;
const AUTOCOMMIT = 2;
const MORE_RESULTS = 8;
// set by a server that tracks the session, as MySQL 8 does by default, after a change of it
const SESSION_STATE_CHANGED = 0x4000;
const LONG = 600000;
// resetTimeout of the pools here
const RESET = 300;

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

// the statements of the app, and how the fake server answers each
const CLEAN = 'UPDATE t SET a = 1';
const ROWS = 'SELECT a FROM t';
const FAIL = 'UPDATE t SET b = 1';
const BEGIN = 'START TRANSACTION';
const AUTOCOMMIT_OFF = 'SET autocommit = 0';
// rows, then a header: the reply of a procedure. The first leaves a transaction open
const CALL_OPEN = 'CALL open_transaction()';
const CALL_CLEAN = 'CALL read_rows()';
// a USE the app sends as its own statement
const APP_USE = 'USE other_db';
// two results: the header of the first says autocommit is off, the one of the second is clean
const EARLY_DIRTY = 'SET autocommit = 0; SET autocommit = 1';
// answered with 1047, as a Galera node outside the primary component does
const NOT_READY = 'UPDATE t SET c = 1';
const DEADLOCK = 1213;
// never answered, so its query timeout runs out
const HANG = 'SELECT SLEEP(10)';

// What a node does from the moment a test says so. Until then it answers everything
type Mode =
    | 'answers'
    // takes a reset and never answers it
    | 'ignores the reset'
    // answers a reset with an error
    | 'refuses the reset'
    // answers every USE with error 1049, unknown database
    | 'refuses USE'
    // answers START TRANSACTION with a deadlock
    | 'refuses START TRANSACTION';

interface INode {
    port: number,
    become: (next: Mode) => void,
    // what the connections of the pool got, in order: the statements as they are, 'reset'
    // and 'change user'. The check connection is left out: it asks SHOW GLOBAL STATUS
    app: () => string[],
    // what each connection got, the check connection included, in the order of the logins
    byConnection: () => string[][],
    logins: () => number,
    // the sockets of the client that closed
    closed: () => number
}

const listen = async (connections = 1): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const sockets: any[] = [];
    const got: { id: number, what: string }[] = [];
    const checks = new Set<number>();
    const seen = { logins: 0, closed: 0 };
    let mode: Mode = 'answers';
    closers.push(() => {
        sockets.forEach(connection => connection.stream.destroy());
        server.close();
    });
    server.on('connection', (connection: any) => {
        const id = sockets.push(connection);
        // the session of this connection, as a server keeps it
        const session = { inTransaction: false, autocommit: true };
        const flags = () =>
            (session.inTransaction ? IN_TRANSACTION : 0) | (session.autocommit ? AUTOCOMMIT : 0);
        const ok = (changed = 0) => {
            connection.sequenceId = 1;
            connection.writeOk({ serverStatus: flags() | changed });
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
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known) return;
            if (code === COM_CHANGE_USER) {
                got.push({ id, what: 'change user' });
                return ok();
            }
            if (code !== COM_RESET_CONNECTION) return;
            got.push({ id, what: 'reset' });
            if (mode === 'ignores the reset') return;
            if (mode === 'refuses the reset') return refuse(1047, 'Unknown command');
            // a reset rolls back and turns autocommit on. The database stays
            Object.assign(session, { inTransaction: false, autocommit: true });
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
            if (sql.startsWith('USE ')) {
                if (mode === 'refuses USE') return refuse(1049, 'Unknown database');
                // the schema is tracked: the header says the session changed
                return ok(SESSION_STATE_CHANGED);
            }
            if (sql === BEGIN && mode === 'refuses START TRANSACTION') {
                return refuse(DEADLOCK, 'Deadlock found when trying to get lock');
            }
            if (sql === ROWS) return connection.writeTextResult([{ a: '1' }], [column('a')]);
            if (sql === FAIL) return refuse(DEADLOCK, 'Deadlock found when trying to get lock');
            if (sql === NOT_READY) return refuse(1047, 'WSREP has not yet prepared node');
            if (sql === HANG) return;
            if (sql === EARLY_DIRTY) {
                connection.writeOk({ serverStatus: MORE_RESULTS });
                // the second result goes on with the sequence numbers of the first, as a
                // server's does: the pool destroys a connection whose packets come out of order
                return connection.writeOk({ serverStatus: flags() });
            }
            if (sql === BEGIN || sql === CALL_OPEN) session.inTransaction = true;
            if (sql === 'COMMIT' || sql === 'ROLLBACK') session.inTransaction = false;
            if (sql === AUTOCOMMIT_OFF) session.autocommit = false;
            if (sql === CALL_OPEN || sql === CALL_CLEAN) {
                connection.writeColumns([column('a')]);
                connection.writeTextRow(['1']);
                connection.writeEof(0, MORE_RESULTS | flags());
                // the header goes on with the sequence numbers of the rows
                return connection.writeOk({ serverStatus: flags() });
            }
            ok();
        };
        connection.on('query', answer);
        // mysql2's server class hands a SET statement to this event instead
        connection.on('stmt_prepare', answer);
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        app: () => got.filter(entry => !checks.has(entry.id)).map(entry => entry.what),
        byConnection: () => sockets.map((_connection, index) =>
            got.filter(entry => entry.id === index + 1).map(entry => entry.what)),
        logins: () => seen.logins,
        closed: () => seen.closed
    };
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));
afterEach(() => jest.restoreAllMocks());

// Nodes with ids 1, 2, ... on the database d, each pool with one connection: the next call on
// a node gets the connection the call before it had. The health check asks on a connection of
// its own, and no check runs after the one of connect(). `legacy`: no healthCheck block, the
// check asks through the pool
const clusterOf = async (nodes: INode[], legacy = false): Promise<any> => {
    const defaultPoolSettings: any = {
        user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 1,
        healthCheck: { interval: LONG, passive: false },
        idleCheckInterval: LONG, queryTimeout: 2000, resetTimeout: RESET
    };
    if (legacy) delete defaultPoolSettings.healthCheck;
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: nodes.map((node, index) => ({ host: '127.0.0.1', port: node.port, id: index + 1 })),
        defaultPoolSettings,
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // every node has had its first check, so every node takes queries
    await cluster.ready;
    return cluster;
};

// what the call ends with: the result, or the error
const call = (
    cluster: any, sql: string, options: object = {}
): Promise<{ result?: any, error?: any }> =>
    cluster.query(sql, undefined, { redis: false, ...options }).then(
        (result: any) => ({ result }),
        (error: any) => ({ error })
    );
const stats = (cluster: any, nodeId: number) =>
    cluster.getPoolStats().find((pool: any) => pool.nodeId === nodeId);
const until = async (done: () => boolean) => {
    for (let waited = 0; waited < 5000 && !done(); waited += 5) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};

describe('a query on the database of the pool', () => {
    it('is one command: no change of user, no USE, no reset', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        const { result } = await call(cluster, CLEAN);
        await call(cluster, CLEAN);

        expect(result.serverStatus).toBe(AUTOCOMMIT);
        expect(node.app()).toEqual([CLEAN, CLEAN]);
    });

    it('that holds rows only: no reset', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        expect((await call(cluster, ROWS)).result).toEqual([{ a: '1' }]);
        await call(cluster, CLEAN);

        expect(node.app()).toEqual([ROWS, CLEAN]);
    });

    it('of a procedure whose header is clean: no reset', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await call(cluster, CALL_CLEAN);
        await call(cluster, CLEAN);

        expect(node.app()).toEqual([CALL_CLEAN, CLEAN]);
    });
});

describe('a query on another database', () => {
    it('sends USE first, then the statement, and no USE while the database stays', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await call(cluster, CLEAN, { database: 'other' });
        await call(cluster, CLEAN, { database: 'other' });
        await call(cluster, CLEAN);

        expect(node.app()).toEqual(['USE `other`', CLEAN, CLEAN, 'USE `d`', CLEAN]);
    });

    it('escapes the name of the database', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await call(cluster, CLEAN, { database: 'we`ird' });

        expect(node.app()).toEqual(['USE `we``ird`', CLEAN]);
    });

    it('whose USE fails: the statement is not sent, and the connection is reset', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);
        node.become('refuses USE');

        const { error } = await call(cluster, CLEAN, { database: 'nope' });
        node.become('answers');
        await call(cluster, CLEAN);

        expect([error.errno, error.sent]).toEqual([1049, false]);
        // the server kept the database of the pool, so the next query sends no USE
        expect(node.app()).toEqual(['USE `nope`', 'reset', CLEAN]);
    });
});

describe('a statement of the app that changes the session', () => {
    // as a USE the app sends through query() does on a server that tracks the schema
    it.each([
        ['a header that says the session changed: the next query sends USE', APP_USE,
            [APP_USE, 'USE `d`', CLEAN]],
        ['a header that does not: no USE', CLEAN, [CLEAN, CLEAN]]
    ])('%s', async (_what, sql, sent) => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        const { result } = await call(cluster, sql);
        await call(cluster, CLEAN);

        expect(node.app()).toEqual(sent);
        // no reset: the session is not dirty, only its database is not known
        expect(result.serverStatus & IN_TRANSACTION).toBe(0);
    });
});

describe('a query that leaves the session dirty', () => {
    it.each([
        ['an error reply', FAIL],
        ['a header with a transaction open', BEGIN],
        ['a header with autocommit off', AUTOCOMMIT_OFF],
        ['a procedure whose last header has a transaction open', CALL_OPEN],
        ['a reply of many results whose earlier header only is dirty', EARLY_DIRTY]
    ])('%s: one reset before the next caller', async (_what, sql) => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await call(cluster, sql);
        const { result } = await call(cluster, CLEAN);

        expect(node.app()).toEqual([sql, 'reset', CLEAN]);
        // the next caller is outside a transaction, with autocommit on
        expect(result.serverStatus).toBe(AUTOCOMMIT);
    });

    it('rolls back a transaction left open before the next caller gets the connection',
        async () => {
            const node = await listen();
            const cluster = await clusterOf([node]);

            const first = call(cluster, BEGIN);
            // waits for the one connection of the pool
            const second = call(cluster, CLEAN);
            const [{ result: opened }, { result: next }] = await Promise.all([first, second]);

            expect(opened.serverStatus & IN_TRANSACTION).toBe(IN_TRANSACTION);
            expect(next.serverStatus & IN_TRANSACTION).toBe(0);
            expect(node.app()).toEqual([BEGIN, 'reset', CLEAN]);
        });

    it('the connection is not handed out again until the reset answered', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await call(cluster, BEGIN);

        expect(stats(cluster, 1)).toMatchObject({ used: 1, idle: 0 });
        await until(() => stats(cluster, 1).idle === 1);
        expect(node.app()).toEqual([BEGIN, 'reset']);
    });
});

// The connection is destroyed with its socket, and the slot of the pool comes back: the next
// call logs in on a new connection. `logins`: what the node counted while the connection was open
const expectDropped = async (cluster: any, node: INode, logins: number) => {
    expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 0, pending: 0 });
    node.become('answers');
    expect((await call(cluster, CLEAN)).result.serverStatus).toBe(AUTOCOMMIT);
    expect(node.logins()).toBe(logins + 1);
};

describe('a reset before release', () => {
    it('that never answers: the connection is destroyed within resetTimeout', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);
        node.become('ignores the reset');

        const { error } = await call(cluster, FAIL);
        const failed = Date.now();
        const logins = node.logins();
        await until(() => node.closed() === 1);
        const took = Date.now() - failed;

        expect(error.errno).toBe(DEADLOCK);
        expect(node.closed()).toBe(1);
        expect(took).toBeGreaterThanOrEqual(RESET - 50);
        expect(took).toBeLessThan(RESET + 500);
        await expectDropped(cluster, node, logins);
        expect(node.app()).toEqual([FAIL, 'reset', CLEAN]);
    });

    it('that fails: the connection is destroyed at once', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);
        node.become('refuses the reset');

        await call(cluster, BEGIN);
        const logins = node.logins();
        await until(() => node.closed() === 1);

        expect(node.closed()).toBe(1);
        await expectDropped(cluster, node, logins);
    });
});

describe('a statement that runs out of time', () => {
    it('destroys the socket of its connection, not only ends it', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);
        await call(cluster, CLEAN);
        const connection = cluster.pools[0]._pool._allConnections.get(0);

        // read as the call fails: an ended socket stays open until the server closes its
        // side, which a cut path never does
        const failed = await cluster.pools[0].query(HANG, { timeout: 200 }).then(
            () => ({ code: 'answered' }),
            (error: any) => ({ code: error.code, destroyed: connection.stream.destroyed })
        );

        expect(failed).toEqual({ code: 'PROTOCOL_SEQUENCE_TIMEOUT', destroyed: true });
    });
});

describe('an answer 1047, not ready', () => {
    // a node outside the primary component answers no reset (#93): the slot would wait for
    // resetTimeout
    it('drops the connection at once, with no reset', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        const { error } = await call(cluster, NOT_READY);
        const failed = Date.now();
        const logins = node.logins();
        await until(() => node.closed() === 1);
        const took = Date.now() - failed;

        expect([error.errno, node.closed()]).toEqual([1047, 1]);
        expect(took).toBeLessThan(RESET / 2);
        await expectDropped(cluster, node, logins);
        expect(node.app()).toEqual([NOT_READY, CLEAN]);
    });
});

describe('multiStatementQuery()', () => {
    it('a USE among its statements: the next query sends USE', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await cluster.pools[0].multiStatementQuery([APP_USE], {});
        await call(cluster, CLEAN);

        expect(node.app()).toEqual([BEGIN, APP_USE, 'COMMIT', 'USE `d`', CLEAN]);
    });

    it('autocommit turned off among its statements: a reset before the next caller',
        async () => {
            const node = await listen();
            const cluster = await clusterOf([node]);

            await cluster.pools[0].multiStatementQuery([AUTOCOMMIT_OFF], {});
            const { result } = await call(cluster, CLEAN);

            expect(node.app()).toEqual([BEGIN, AUTOCOMMIT_OFF, 'COMMIT', 'reset', CLEAN]);
            expect(result.serverStatus).toBe(AUTOCOMMIT);
        });

    it('sends no reset after its own COMMIT, and one after an error reply and its ROLLBACK',
        async () => {
            const node = await listen();
            const cluster = await clusterOf([node]);
            const pool = cluster.pools[0];

            await pool.multiStatementQuery([CLEAN], {});
            const failed = await pool.multiStatementQuery([FAIL], {}).catch((e: any) => e);
            await call(cluster, CLEAN);

            expect(failed.errno).toBe(DEADLOCK);
            // an error reply carries no status flags: the session is dirty until a reset
            expect(node.app()).toEqual([
                BEGIN, CLEAN, 'COMMIT', BEGIN, FAIL, 'ROLLBACK', 'reset', CLEAN
            ]);
        });

    it('sends USE first for another database, and no change of user', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);

        await cluster.pools[0].multiStatementQuery([CLEAN], { database: 'h' });

        expect(node.app()).toEqual(['USE `h`', BEGIN, CLEAN, 'COMMIT']);
    });

    it('a START TRANSACTION the node refuses: a reset before the next caller', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);
        node.become('refuses START TRANSACTION');

        const failed = await cluster.pools[0].multiStatementQuery([CLEAN], {})
            .catch((e: any) => e);
        node.become('answers');
        await call(cluster, CLEAN);

        expect(failed.errno).toBe(DEADLOCK);
        expect(node.app()).toEqual([BEGIN, 'reset', CLEAN]);
    });

    it('an answer 1047 among its statements: the connection is dropped, with no reset',
        async () => {
            const node = await listen();
            const cluster = await clusterOf([node]);

            const failed = await cluster.pools[0].multiStatementQuery([NOT_READY], {})
                .catch((e: any) => e);
            const logins = node.logins();
            await until(() => node.closed() === 1);

            expect([failed.errno, node.closed()]).toEqual([1047, 1]);
            await expectDropped(cluster, node, logins);
            expect(node.app()).toEqual([BEGIN, NOT_READY, 'ROLLBACK', CLEAN]);
        });
});

describe('a connection the app had through getConnection()', () => {
    it('is reset and put on the database of the query before the next query', async () => {
        const node = await listen();
        const cluster = await clusterOf([node]);
        const { connection } = await cluster.getConnection();
        const app = connection.promise();
        await app.query('USE other_db');
        await app.query(BEGIN);
        connection.release();

        const { result } = await call(cluster, CLEAN);
        await call(cluster, CLEAN);

        expect(node.app()).toEqual(['USE other_db', BEGIN, 'reset', 'USE `d`', CLEAN, CLEAN]);
        expect(result.serverStatus).toBe(AUTOCOMMIT);
    });

    // The release() of the app resets the connection. The query waits for the one slot of
    // the pool meanwhile, and gets a new connection when the reset ran out of time
    it('whose reset at release() never answers: dropped within resetTimeout, the query that ' +
        'waits gets a new connection', async () => {
        const [n1, n2] = [await listen(1), await listen(9)];
        const cluster = await clusterOf([n1, n2]);
        const { connection, nodeId } = await cluster.getConnection();
        expect(nodeId).toBe(1);
        const logins = n1.logins();
        n1.become('ignores the reset');
        connection.release();
        const started = Date.now();

        const { result } = await call(cluster, CLEAN, { maxRetry: 2 });
        const took = Date.now() - started;
        await until(() => n1.closed() === 1);

        expect(result.serverStatus).toBe(AUTOCOMMIT);
        expect(took).toBeGreaterThanOrEqual(RESET - 50);
        expect(took).toBeLessThan(RESET + 500);
        expect([n1.app(), n2.app(), n1.logins() - logins]).toEqual([['reset', CLEAN], [], 1]);
        expect(n1.closed()).toBe(1);
        expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1, pending: 0 });
    });
});

describe('the health check of a node without a healthCheck block', () => {
    it('asks through the pool on its database: no change of user, no USE', async () => {
        const node = await listen();
        const cluster = await clusterOf([node], true);

        await call(cluster, CLEAN);

        expect(node.byConnection()).toEqual([['SHOW GLOBAL STATUS;', CLEAN]]);
    });
});

describe('the resetTimeout setting', () => {
    it('defaults to 1000 ms', () => {
        expect(parseSettings({}).defaultPoolSettings.resetTimeout).toBe(1000);
    });

    it('is 1000 ms for a Pool built without the settings schema, as its siblings', () => {
        // the settings of a host, less the one key
        const settings = Settings.mixSettings({ hosts: [{ host: 'h' }] } as any);
        const { resetTimeout, ...host } = settings.hosts[0];
        const pool: any = new Pool({ id: 1, ...host } as any, 'test');

        expect(pool._session._resetTimeout).toBe(1000);
    });

    it.each([0, -1])('refuses %d: a reset always has a time limit', (value) => {
        expect(() => parseSettings({ defaultPoolSettings: { resetTimeout: value } })).toThrow();
        expect(() => parseSettings({ hosts: [{ host: 'a', resetTimeout: value }] })).toThrow();
    });
});

// The timer of a command of the pool (#120): mysql2 gets no timeout, whose timer it clears
// only when the command ends. The timer of the pool goes at the reply, on expiry, at a throw
// of mysql2 and at drop() of the connection
describe('send(): the time limit of a command', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const LIMIT = 1000;
    const state = () => new SessionState('test', 'd', RESET, 100, 1000);
    // a connection whose command gets no reply until the test hands one to answer()
    const silent = () => {
        let pending: (error: any, result?: any) => void = () => undefined;
        const connection: any = {
            query: jest.fn((_options: object, done: any) => { pending = done; }),
            destroy: jest.fn(), stream: { destroy: jest.fn() }
        };
        const ask = (sent: any) => connection.query({ sql: 'SELECT 1' }, sent);
        return { connection, ask, answer: (error: any, result?: any) => pending(error, result) };
    };

    it('hands mysql2 no timeout, and clears its timer at the reply', () => {
        const { connection, ask, answer } = silent();
        const reply = jest.fn();

        state().send(connection, LIMIT, ask, reply);
        expect(connection.query.mock.calls[0][0]).toEqual({ sql: 'SELECT 1' });
        expect(jest.getTimerCount()).toBe(1);
        answer(null, 'rows');
        jest.advanceTimersByTime(LIMIT);

        expect(jest.getTimerCount()).toBe(0);
        expect(reply.mock.calls).toEqual([[null, 'rows']]);
    });

    it('on expiry: the error of mysql2 once, and no reply of mysql2 after it', () => {
        const { connection, ask, answer } = silent();
        const reply = jest.fn();

        state().send(connection, LIMIT, ask, reply);
        jest.advanceTimersByTime(LIMIT - 1);
        expect(reply).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        answer(null, 'late');

        expect(reply).toHaveBeenCalledTimes(1);
        const [error] = reply.mock.calls[0];
        expect([error.message, error.code, error.errorno, error.syscall]).toEqual([
            'Query inactivity timeout', 'PROTOCOL_SEQUENCE_TIMEOUT',
            'PROTOCOL_SEQUENCE_TIMEOUT', 'query'
        ]);
    });

    it('on expiry with timedOut: the error it makes', () => {
        const { connection, ask } = silent();
        const reply = jest.fn();
        const own = new Error('own');

        state().send(connection, LIMIT, ask, reply, () => own);
        jest.advanceTimersByTime(LIMIT);

        expect(reply.mock.calls).toEqual([[own, undefined]]);
    });

    it('drop() of the connection clears the timer', () => {
        const { connection, ask } = silent();
        const reply = jest.fn();
        const session = state();

        session.send(connection, LIMIT, ask, reply);
        session.drop(connection);
        jest.advanceTimersByTime(LIMIT);

        expect(jest.getTimerCount()).toBe(0);
        expect(connection.destroy).toHaveBeenCalledTimes(1);
        expect(reply).not.toHaveBeenCalled();
    });

    it('a throw of mysql2 at the send: thrown on, and the timer cleared', () => {
        const { connection } = silent();
        const reply = jest.fn();
        const thrown = new Error('refused');

        expect(() => state().send(connection, LIMIT, () => { throw thrown; }, reply))
            .toThrow(thrown);
        jest.advanceTimersByTime(LIMIT);

        expect(jest.getTimerCount()).toBe(0);
        expect(reply).not.toHaveBeenCalled();
    });

    it.each([0, undefined])('timeout %s: no timer', (timeout) => {
        const { connection, ask } = silent();

        state().send(connection, timeout, ask, jest.fn());

        expect(jest.getTimerCount()).toBe(0);
    });

    it('the timer keeps no process alive', () => {
        jest.useRealTimers();
        const { connection, ask } = silent();
        const session = state();
        // Node 17.3 and later. An unref'd timer is not listed
        const timers = () => (process as unknown as { getActiveResourcesInfo: () => string[] })
            .getActiveResourcesInfo().filter(name => name === 'Timeout').length;
        const before = timers();

        session.send(connection, LIMIT, ask, jest.fn());
        const during = timers();
        session.drop(connection);

        expect(during).toBe(before);
    });
});
