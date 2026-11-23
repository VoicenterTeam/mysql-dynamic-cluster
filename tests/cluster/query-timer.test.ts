import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import { PoolStatus } from '../../src/pool/PoolStatus';
import { recordTimers } from '../timers';

// The time limit of a command of the pool (#120), against the real mysql2 and mysql2's own
// server class on the loopback interface. mysql2 clears the timer of its `timeout` option only
// when the command ends, on an error reply or when the timer fires, not when the connection is
// destroyed. So a command still out on a connection the pool dropped kept that timer, and the
// process could not exit until it fired. The pool bounds its commands with a timer of its own.
// A test records the timers its scenario starts, from before the cluster to after its
// disconnect(): none of them may still keep the process alive then, see ../timers.ts
const COM_CHANGE_USER = 0x11;
const COM_RESET_CONNECTION = 0x1f;
const LONG = 600000;
// the status flags of an OK header: autocommit on, and a transaction open
const AUTOCOMMIT = 2;
const IN_TRANSACTION = 1;
// a database other than the one of the pools: a query on it sends USE first
const OTHER = 'other';
// the statement of the app, and the same with its value written in by the cluster
const APP_SQL = 'UPDATE t SET a = 1';
const WITH_VALUE = 'UPDATE t SET a = ?';
// the timeout of a call that is aborted or loses its connection long before it
const LATER = 4000;
// the timeout of a call that runs out
const SHORT = 500;
const ABORT_AFTER = 300;

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
afterEach(() => jest.restoreAllMocks());

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

// The answer to a prepare of the protocol: a statement with no columns and no parameters,
// in the shape writePacket() of mysql2's server class takes
const prepareOk = (statementId: number) => {
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

// What a node does with the call of the app. It answers everything else, the prepare of
// execute() too
type Mode =
    | 'answers'
    // takes the statement, or the execute of a bound one, and never answers it
    | 'ignores the statement'
    // closes the connection the statement, or the execute of a bound one, comes on
    | 'hangs up on the statement'
    | 'ignores USE'
    | 'ignores DO 0';

interface INode {
    port: number,
    become: (next: Mode) => void,
    // what the pooled connections sent, in order: the text of a query, 'execute', 'rollback'
    order: () => string[],
    // pooled connections open at the node right now
    open: () => number
}

const listen = async (connections: number): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const opened: any[] = [];
    // the connections that changed the user: the check connection
    const checks = new Set<any>();
    const seen: { what: string, connection: any }[] = [];
    let mode: Mode = 'answers';
    let statements = 0;
    const ok = (connection: any, serverStatus = AUTOCOMMIT) => {
        connection.sequenceId = 1;
        connection.writeOk({ affectedRows: 1, serverStatus });
    };
    closers.push(() => {
        server.close();
        opened.forEach(connection => connection.stream.destroy());
    });
    server.on('connection', (connection: any) => {
        opened.push(connection);
        connection.on('error', () => undefined);
        const note = (what: string) => seen.push({ what, connection });
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: opened.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => done(null)
        });
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || (code !== COM_CHANGE_USER && code !== COM_RESET_CONNECTION)) return;
            if (code === COM_CHANGE_USER) checks.add(connection);
            ok(connection);
        });
        // the statement of the app, as text or as the execute of a bound one
        const statement = () => {
            if (mode === 'ignores the statement') return;
            if (mode === 'hangs up on the statement') return connection.stream.destroy();
            ok(connection);
        };
        connection.on('stmt_prepare', () => {
            connection.sequenceId = 1;
            connection.writePacket(prepareOk(++statements));
        });
        connection.on('stmt_execute', () => {
            note('execute');
            statement();
        });
        connection.on('query', (sql: string) => {
            if (sql.startsWith('SHOW GLOBAL STATUS')) {
                connection.sequenceId = 1;
                const columns = [column('Variable_name'), column('Value')];
                return connection.writeTextResult(status(connections), columns);
            }
            note(sql);
            if (sql === APP_SQL) return statement();
            if (sql.startsWith('USE ') && mode === 'ignores USE') return;
            if (sql === 'DO 0' && mode === 'ignores DO 0') return;
            if (sql === 'START TRANSACTION') return ok(connection, IN_TRANSACTION | AUTOCOMMIT);
            ok(connection);
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const pooled = (connection: any) => !checks.has(connection);
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        order: () => seen.filter(entry => pooled(entry.connection)).map(entry => entry.what),
        open: () => opened.filter(c => pooled(c) && !c.stream.destroyed).length
    };
};

// Poll until `done` says yes, about 5 s at most
const until = async (done: () => boolean, what: string): Promise<void> => {
    for (let turn = 0; turn < 500 && !done(); turn++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!done()) throw new Error('gave up waiting for ' + what);
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));

// Nodes with ids 1, 2, ..., and node 1 is tried first. The health check asks on a connection
// of its own, and no check runs and no idle connection is pinged after the ones of connect()
const connectCluster = async (...nodes: INode[]): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: nodes.map((node, index) => ({ host: '127.0.0.1', port: node.port, id: index + 1 })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            healthCheck: { interval: LONG, passive: false }, idleCheckInterval: LONG
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
    return { cluster: await connectCluster(n1, n2), n1, n2 };
};

// what the call ends with: the result, or the error
const settle = (call: Promise<any>): Promise<{ result?: any, error?: any }> =>
    call.then(result => ({ result }), error => ({ error }));
const isOwn = (error: object) => (PoolStatus as any)._ownErrors.has(error);

// The calls whose command a node never answers, aborted by the signal well before their
// timeout. The abort destroys the connection, and nothing of the call may keep the process
// alive once the cluster disconnected. Before the fix each left the timer of mysql2, LATER ms
describe('an aborted call leaves no timer', () => {
    const aborted = async (
        mode: Mode, ask: (cluster: any, signal: AbortSignal) => Promise<any>
    ) => {
        const record = recordTimers();
        const { cluster, n1, n2 } = await twoNodes();
        n1.become(mode);
        const controller = new AbortController();
        const reason = new Error('caller gave up');

        const pending = settle(ask(cluster, controller.signal));
        await pause(ABORT_AFTER);
        controller.abort(reason);
        const { error } = await pending;
        await until(() => n1.open() === 0, 'the connection to close');
        await cluster.disconnect();
        const left = await record.stop();

        expect(error).toBe(reason);
        expect(n2.order()).toEqual([]);
        expect(left).toEqual([]);
        return n1.order();
    };

    it('query(): the statement', async () => {
        const order = await aborted('ignores the statement', (cluster, signal) =>
            cluster.query(APP_SQL, undefined, { signal, timeout: LATER, redis: false }));
        expect(order).toEqual([APP_SQL]);
    });

    // What made a count of every timer flaky: a ref'd timer of other code, as of jest under
    // load, that started before the scenario and ended during it
    it('query(): a timer of other code that ends meanwhile does not count', async () => {
        setTimeout(() => undefined, 50);
        const order = await aborted('ignores the statement', (cluster, signal) =>
            cluster.query(APP_SQL, undefined, { signal, timeout: LATER, redis: false }));
        expect(order).toEqual([APP_SQL]);
    });

    it('execute(): the statement, its prepare answered', async () => {
        const order = await aborted('ignores the statement', (cluster, signal) =>
            cluster.execute(APP_SQL, [1], { signal, timeout: LATER }));
        expect(order).toEqual(['execute']);
    });

    it('the USE before a statement on another database', async () => {
        const order = await aborted('ignores USE', (cluster, signal) =>
            cluster.query(APP_SQL, undefined, {
                signal, timeout: LATER, redis: false, database: OTHER
            }));
        expect(order).toEqual(['USE `other`']);
    });

    it('the DO 0 before values in the text, on a connection whose sql_mode is unknown',
        async () => {
            const order = await aborted('ignores DO 0', (cluster, signal) =>
                cluster.query(WITH_VALUE, [1], { signal, timeout: LATER, redis: false }));
            expect(order).toEqual(['DO 0']);
        });
});

// The node closes the connection while the statement is out. mysql2 calls back with
// PROTOCOL_CONNECTION_LOST, and before the fix a second time when its timer fired
describe('a lost connection leaves no timer', () => {
    it('query(): rejects once, with the error of mysql2, and tries no other node', async () => {
        const record = recordTimers();
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('hangs up on the statement');
        const attempts = jest.spyOn(cluster.pools[0], 'query');

        const { error } = await settle(cluster.query(APP_SQL, undefined, {
            timeout: LATER, redis: false, maxRetry: 2
        }));
        await cluster.disconnect();
        const left = await record.stop();

        expect([error.code, error.fatal, error.sent, error.nodeId])
            .toEqual(['PROTOCOL_CONNECTION_LOST', true, true, 1]);
        expect(attempts).toHaveBeenCalledTimes(1);
        expect(n2.order()).toEqual([]);
        expect(left).toEqual([]);
    });

    it('multiStatementQuery(): the statement of the transaction', async () => {
        const record = recordTimers();
        const node = await listen(1);
        const cluster = await connectCluster(node);
        node.become('hangs up on the statement');

        const { error } = await settle(
            cluster.pools[0].multiStatementQuery([APP_SQL], { timeout: LATER })
        );
        await cluster.disconnect();
        const left = await record.stop();

        expect([error.code, error.fatal]).toEqual(['PROTOCOL_CONNECTION_LOST', true]);
        expect(node.order()).toEqual(['START TRANSACTION', APP_SQL]);
        expect(left).toEqual([]);
    });
});

// The pool's own timer: the same error and the same outcome as the timeout of mysql2 before
describe('a command that runs out of its timeout', () => {
    // the error of mysql2 for a command that ran out of time, field for field
    const ofMysql = {
        message: 'Query inactivity timeout', code: 'PROTOCOL_SEQUENCE_TIMEOUT',
        errorno: 'PROTOCOL_SEQUENCE_TIMEOUT', syscall: 'query'
    };
    const fieldsOf = (error: any) => ({
        message: error.message, code: error.code, errorno: error.errorno, syscall: error.syscall
    });

    it('query(): rejects with PROTOCOL_SEQUENCE_TIMEOUT and sent: true, destroys the ' +
        'connection, tries no other node', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores the statement');

        const started = Date.now();
        const { error } = await settle(cluster.query(APP_SQL, undefined, {
            timeout: SHORT, redis: false, maxRetry: 2
        }));
        const took = Date.now() - started;
        await until(() => n1.open() === 0, 'the connection to close');

        expect(fieldsOf(error)).toEqual(ofMysql);
        expect([error.sent, error.nodeId, error.fatal, isOwn(error)])
            .toEqual([true, 1, undefined, false]);
        expect(took).toBeGreaterThanOrEqual(SHORT - 50);
        expect(took).toBeLessThan(SHORT + 1000);
        expect(n2.order()).toEqual([]);
    });

    // The prepare under the same timer: execute.test.ts, 'gives the prepare the timeout of the
    // query'
    it('execute(): a silent execute fails with the package\'s own error, as in 5.0.0',
        async () => {
            const { cluster, n1, n2 } = await twoNodes();
            n1.become('ignores the statement');

            const { error } = await settle(cluster.execute(APP_SQL, [1], {
                timeout: SHORT, maxRetry: 2
            }));
            await until(() => n1.open() === 0, 'the connection to close');

            expect([error.message, error.code, error.sent, error.nodeId, isOwn(error)])
                .toEqual(['Query inactivity timeout', 'PROTOCOL_SEQUENCE_TIMEOUT', true, 1, true]);
            expect(n2.order()).toEqual([]);
        });

    it('USE: sent: false, the connection destroyed, and the next node is tried', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores USE');

        const { result } = await settle(cluster.query(APP_SQL, undefined, {
            timeout: SHORT, redis: false, maxRetry: 2, database: OTHER
        }));
        await until(() => n1.open() === 0, 'the connection to close');

        expect(result.affectedRows).toBe(1);
        expect(n1.order()).toEqual(['USE `other`']);
        expect(n2.order()).toEqual(['USE `other`', APP_SQL]);
    });

    it('USE: the error is the one of mysql2, with sent: false', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores USE');
        n2.become('ignores USE');

        const { error } = await settle(cluster.query(APP_SQL, undefined, {
            timeout: SHORT, redis: false, maxRetry: 2, database: OTHER
        }));

        expect(fieldsOf(error)).toEqual(ofMysql);
        expect([error.sent, error.nodeId, isOwn(error)]).toEqual([false, 2, false]);
        expect(fieldsOf(error.errors[0].error)).toEqual(ofMysql);
        expect([error.errors[0].nodeId, error.errors[0].error.sent]).toEqual([1, false]);
    });

    it('DO 0: sent: false, and the next node is tried', async () => {
        const { cluster, n1, n2 } = await twoNodes();
        n1.become('ignores DO 0');

        const { result } = await settle(cluster.query(WITH_VALUE, [1], {
            timeout: SHORT, redis: false, maxRetry: 2
        }));
        await until(() => n1.open() === 0, 'the connection to close');

        expect(result.affectedRows).toBe(1);
        expect(n1.order()).toEqual(['DO 0']);
        expect(n2.order()).toEqual(['DO 0', APP_SQL]);
    });

    it('multiStatementQuery(): the error of mysql2, no ROLLBACK, the connection destroyed',
        async () => {
            const node = await listen(1);
            const cluster = await connectCluster(node);
            node.become('ignores the statement');

            const { error } = await settle(
                cluster.pools[0].multiStatementQuery([APP_SQL], { timeout: SHORT })
            );
            await until(() => node.open() === 0, 'the connection to close');

            expect(fieldsOf(error)).toEqual(ofMysql);
            expect(isOwn(error)).toBe(false);
            expect(node.order()).toEqual(['START TRANSACTION', APP_SQL]);
        });
});

describe('the timeout option of a call', () => {
    it('0 means no limit', async () => {
        const { cluster, n1 } = await twoNodes();
        n1.become('ignores the statement');
        const controller = new AbortController();

        const pending = settle(cluster.query(APP_SQL, undefined, {
            timeout: 0, redis: false, signal: controller.signal
        }));
        await pause(SHORT);
        controller.abort('gave up');

        expect(await pending).toEqual({ error: 'gave up' });
    });

    it.each([
        ['query()', (cluster: any) => cluster.query(APP_SQL, undefined, { timeout: -1 })],
        ['execute()', (cluster: any) => cluster.execute(APP_SQL, [1], { timeout: -1 })]
    ])('%s: a negative one rejects with a TypeError, and no node is asked', async (_, ask) => {
        const { cluster, n1, n2 } = await twoNodes();
        const attempts = cluster.pools.map((pool: any) => jest.spyOn(pool, 'query'));

        const { error } = await settle(ask(cluster));

        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toBe('query: options.timeout must not be negative');
        attempts.forEach((attempt: jest.SpyInstance) => expect(attempt).not.toHaveBeenCalled());
        expect([n1.order(), n2.order()]).toEqual([[], []]);
    });
});
