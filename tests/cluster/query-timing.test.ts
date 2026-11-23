import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import Redis from '../../src/Redis/Redis';

// The onTiming query option of cluster.query() and execute() (#122), against the real mysql2
// and mysql2's own server class on the loopback interface. onTiming is called once when the
// call settles, before its promise does, with the step its last attempt ended in, the time it
// waited for a connection over every node it tried, and the node of the last attempt. It is
// not called for a call that asked no node
const COM_CHANGE_USER = 0x11;
const COM_RESET_CONNECTION = 0x1f;
const LONG = 600000;
// the status flags of an OK header of a server: autocommit on, no transaction
const AUTOCOMMIT = 2;
// a database other than the one of the pools: a query on it sends USE first
const OTHER = 'other';
// the statement of the app
const APP_SQL = 'UPDATE t SET a = 1';

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
const prepareOk = () => {
    // the header of 4 bytes, then 0, the id 1, and zeros for columns, parameters and warnings
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(1, 5);
    return {
        buffer,
        length: () => buffer.length,
        writeHeader: (sequenceId: number) => {
            buffer.writeUIntLE(buffer.length - 4, 0, 3);
            buffer[3] = sequenceId;
        }
    };
};

interface INode {
    port: number,
    // keep the answer to every statement of the app from now on, until answer()
    holdStatements: () => void,
    // answer the statements held, and every later one at once
    answer: () => void,
    // answer no USE from now on
    ignoreUse: () => void,
    // keep each new login waiting this many ms from now on
    slowLogins: (ms: number) => void,
    // answer no ping and no status query of a health check from now on
    cutOff: () => void,
    // resolves when the node got the next statement of the app
    nextStatement: () => Promise<void>,
    // what the node got: logins and statements of the app
    seen: () => { logins: number, statements: number }
}

const listen = async (connections: number): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const open: any[] = [];
    const held: (() => void)[] = [];
    const waiting: (() => void)[] = [];
    const modes = { holding: false, ignoreUse: false, loginDelay: 0, cutOff: false };
    const seen = { logins: 0, statements: 0 };
    closers.push(() => {
        open.forEach(connection => connection.stream.destroy());
        server.close();
    });
    const ok = (connection: any, affectedRows = 0) => {
        connection.sequenceId = 1;
        connection.writeOk({ affectedRows, serverStatus: AUTOCOMMIT });
    };
    server.on('connection', (connection: any) => {
        open.push(connection);
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: open.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => {
                seen.logins++;
                if (!modes.loginDelay) return done(null);
                setTimeout(() => done(null), modes.loginDelay);
            }
        });
        // the check connection changes the user before its status query, and a connection
        // the app had is reset
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || (code !== COM_CHANGE_USER && code !== COM_RESET_CONNECTION)) return;
            ok(connection);
        });
        connection.on('ping', () => {
            if (!modes.cutOff) ok(connection);
        });
        const statement = () => {
            seen.statements++;
            waiting.splice(0).forEach(resolve => resolve());
            if (modes.holding) return held.push(() => ok(connection, 1));
            ok(connection, 1);
        };
        connection.on('stmt_prepare', () => {
            connection.sequenceId = 1;
            connection.writePacket(prepareOk());
        });
        connection.on('stmt_execute', statement);
        connection.on('query', (sql: string) => {
            if (sql.startsWith('SHOW GLOBAL STATUS')) {
                if (modes.cutOff) return;
                connection.sequenceId = 1;
                const columns = [column('Variable_name'), column('Value')];
                return connection.writeTextResult(status(connections), columns);
            }
            if (sql.startsWith('USE ') && modes.ignoreUse) return;
            if (sql !== APP_SQL) return ok(connection);
            statement();
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        holdStatements: () => { modes.holding = true; },
        answer: () => {
            modes.holding = false;
            held.splice(0).forEach(answer => answer());
        },
        ignoreUse: () => { modes.ignoreUse = true; },
        slowLogins: (ms: number) => { modes.loginDelay = ms; },
        cutOff: () => { modes.cutOff = true; },
        nextStatement: () => new Promise<void>(resolve => waiting.push(resolve)),
        seen: () => ({ ...seen })
    };
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));
afterEach(() => jest.restoreAllMocks());

// Nodes with ids 1, 2..., node 1 tried first. Each pool has one connection, so a call whose
// connection was not given back leaves the next call waiting. The health check asks on a
// connection of its own, and no check runs after the one of connect()
const connect = async (nodes: INode[], settings: object = {}) => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: nodes.map((node, index) => ({ host: '127.0.0.1', port: node.port, id: index + 1 })),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit: 1,
            healthCheck: { interval: LONG, passive: false },
            // mysql2 keeps the timer of a query whose connection was destroyed. A short one
            // lets the file end
            queryTimeout: 2000,
            ...settings
        },
        useClusterHashing: false,
        logger
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // every node has had its first check, so every node takes queries
    await cluster.ready;
    return { cluster, logger };
};

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// a reason of the app's own, to see that it comes back as it is
const reasonOf = () => Object.assign(new Error('caller gave up'), { code: 'APP_GAVE_UP' });

type Ask = (options: object) => Promise<any>;
const query = (cluster: any): Ask => options => cluster.query(APP_SQL, undefined, options);
const execute = (cluster: any): Ask => options => cluster.execute(APP_SQL, undefined, options);

// The call with an onTiming that keeps what it got. `order` says whether onTiming came before
// the promise settled. maxRetry 2: the call may try two nodes
const timed = async (ask: Ask, options: object = {}) => {
    const timings: any[] = [];
    const order: string[] = [];
    const onTiming = (timing: unknown) => {
        timings.push(timing);
        order.push('timing');
    };
    const ended = await ask({ redis: false, maxRetry: 2, ...options, onTiming }).then(
        (result: any) => {
            order.push('settled');
            return { result, error: undefined as any };
        },
        (error: any) => {
            order.push('settled');
            return { result: undefined as any, error };
        }
    );
    return { ...ended, timings, order };
};
// the one timing a call got
const timing = (step: string, nodeId: number) => [{ step, queuedMs: expect.any(Number), nodeId }];

describe('a call that waits for the one connection of its node', () => {
    // node 1 holds the statement of a first call, so its only connection stays taken
    const taken = async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        node.holdStatements();
        const sent = node.nextStatement();
        const first = cluster.query(APP_SQL, undefined, { redis: false });
        await sent;
        return { node, cluster, first };
    };

    it('aborted while queued: step queue, queuedMs the time until the abort', async () => {
        const { node, cluster, first } = await taken();
        const controller = new AbortController();
        const reason = reasonOf();
        const started = Date.now();
        const pending = timed(query(cluster), { signal: controller.signal });
        await pause(200);
        const untilAbort = Date.now() - started;

        controller.abort(reason);
        const { error, timings, order } = await pending;
        const elapsed = Date.now() - started;

        // the reason as it is: nothing is written on it
        expect(error).toBe(reason);
        expect(Object.keys(reason)).toEqual(['code']);
        expect(order).toEqual(['timing', 'settled']);
        expect(timings).toEqual(timing('queue', 1));
        expect(timings[0].queuedMs).toBeGreaterThanOrEqual(untilAbort - 50);
        expect(timings[0].queuedMs).toBeLessThanOrEqual(elapsed);
        node.answer();
        expect((await first).affectedRows).toBe(1);
    });

    it('the connection frees in time: step statement, queuedMs about the hold', async () => {
        const { node, cluster, first } = await taken();
        const started = Date.now();
        const pending = timed(query(cluster));
        await pause(200);
        const held = Date.now() - started;

        node.answer();
        const { result, timings, order } = await pending;
        const elapsed = Date.now() - started;

        expect(result.affectedRows).toBe(1);
        expect((await first).affectedRows).toBe(1);
        expect(order).toEqual(['timing', 'settled']);
        expect(timings).toEqual(timing('statement', 1));
        expect(timings[0].queuedMs).toBeGreaterThanOrEqual(held - 50);
        expect(timings[0].queuedMs).toBeLessThanOrEqual(elapsed);
    });
});

describe('a call that ends after its connection came', () => {
    it('aborted while its statement runs: step statement, queuedMs about 0', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        // a call before: the connection is open and idle, so the next call waits for none
        expect((await cluster.query(APP_SQL, undefined, { redis: false })).affectedRows).toBe(1);
        node.holdStatements();
        const controller = new AbortController();
        const reason = reasonOf();
        const sent = node.nextStatement();
        const pending = timed(query(cluster), { signal: controller.signal });
        await sent;
        // the time of the statement is not time queued
        await pause(100);

        controller.abort(reason);
        const { error, timings, order } = await pending;

        expect(error).toBe(reason);
        expect(order).toEqual(['timing', 'settled']);
        expect(timings).toEqual(timing('statement', 1));
        expect(timings[0].queuedMs).toBeLessThan(50);
    });

    it('execute(): step statement', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);

        const { result, timings, order } = await timed(execute(cluster));

        expect(result.affectedRows).toBe(1);
        expect(order).toEqual(['timing', 'settled']);
        expect(timings).toEqual(timing('statement', 1));
    });

    // Each node keeps the login of the connection the call opens LOGIN ms, which is time
    // queued, and node 1 answers no USE: its attempt ends at the timeout of the call
    const LOGIN = 150;
    const TIMEOUT = 200;
    it.each([
        ['answers no USE either', 'prepare', 'PROTOCOL_SEQUENCE_TIMEOUT'],
        ['answers', 'statement', undefined]
    ])('a USE that times out on node 1, and node 2 %s: step %s, queuedMs summed, nodeId 2',
        async (_name, step, code) => {
            const [n1, n2] = [await listen(1), await listen(9)];
            const { cluster } = await connect([n1, n2]);
            [n1, n2].forEach(node => node.slowLogins(LOGIN));
            n1.ignoreUse();
            if (step === 'prepare') n2.ignoreUse();
            const started = Date.now();

            const { result, error, timings } =
                await timed(query(cluster), { database: OTHER, timeout: TIMEOUT });
            const elapsed = Date.now() - started;

            expect(error?.code).toBe(code);
            if (error) {
                expect(error.nodeId).toBe(2);
                expect(error).not.toHaveProperty('queuedMs');
                expect(error).not.toHaveProperty('step');
            } else {
                expect(result.affectedRows).toBe(1);
            }
            expect(timings).toEqual(timing(step, 2));
            // a login of each node: more than one alone, and not the time of the USE
            expect(timings[0].queuedMs).toBeGreaterThanOrEqual(2 * LOGIN - 20);
            expect(timings[0].queuedMs).toBeLessThanOrEqual(elapsed - TIMEOUT + 10);
        });

    it('every connection fails its probe on a node health gave up: step probe', async () => {
        const node = await listen(1);
        // a check every 100 ms, and one failed check takes the node down: well before the
        // probe runs out of time
        const { cluster } = await connect([node], {
            probeIdle: 200, probeTimeout: 1000, idleCheckInterval: LONG,
            healthCheck: { interval: 100, timeout: 300, fall: 1, passive: false }
        });
        expect((await cluster.query(APP_SQL, undefined, { redis: false })).affectedRows).toBe(1);
        // the connection is idle past probeIdle, then the node answers no ping and no check
        await pause(300);
        node.cutOff();

        const { error, timings } = await timed(query(cluster));

        expect(error.code).toBe('PROTOCOL_SEQUENCE_TIMEOUT');
        expect(error.message).toBe('Probe timeout');
        expect(timings).toEqual(timing('probe', 1));
        expect(node.seen().statements).toBe(1);
    });
});

describe('a call served stale data of Redis after its node failed', () => {
    it('is told once, with the step of the last attempt', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const stale = JSON.stringify({ data: 'stale', expired: 0 });
        jest.spyOn(Redis, 'get').mockResolvedValue(stale);
        node.ignoreUse();

        const { result, timings, order } =
            await timed(query(cluster), { redis: true, database: OTHER, timeout: 200 });

        expect(result).toBe('stale');
        expect(order).toEqual(['timing', 'settled']);
        expect(timings).toEqual(timing('prepare', 1));
    });
});

describe('onTiming itself', () => {
    it('a throw in it is logged once and changes no result, and no rejection', async () => {
        const node = await listen(1);
        const { cluster, logger } = await connect([node]);
        const onTiming = jest.fn(() => { throw new Error('bad callback'); });

        const result = await cluster.query(APP_SQL, undefined, { redis: false, onTiming });
        node.holdStatements();
        const controller = new AbortController();
        const reason = reasonOf();
        const sent = node.nextStatement();
        const pending = cluster.query(APP_SQL, undefined, {
            redis: false, onTiming, signal: controller.signal
        }).catch((e: unknown) => e);
        await sent;
        controller.abort(reason);

        expect(result.affectedRows).toBe(1);
        expect(await pending).toBe(reason);
        expect(onTiming).toHaveBeenCalledTimes(2);
        const warned = logger.warn.mock.calls.filter(([message]: unknown[]) =>
            String(message).includes('onTiming'));
        expect(warned).toHaveLength(2);
        expect(warned[0][0]).toContain('bad callback');
    });

    it.each([
        ['a number', 1],
        ['a string', 'onTiming'],
        ['an object', {}],
        ['null', null]
    ])('%s rejects with a TypeError, and no node is asked', async (_name, onTiming) => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const asked = jest.spyOn(cluster.pools[0], 'query');
        const seen = node.seen();

        const error = await cluster.query(APP_SQL, undefined, { redis: false, onTiming })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toBe('query: options.onTiming must be a function');
        expect(asked).not.toHaveBeenCalled();
        expect(node.seen()).toEqual(seen);
    });
});

type Start = (cluster: any, options: object) => Promise<any>;
describe('a call that asks no node gets no onTiming', () => {
    const fresh = JSON.stringify({ data: 'fresh', expired: Date.now() + LONG });
    it.each<[string, Start, string]>([
        ['a Redis hit', (cluster, options) => {
            jest.spyOn(Redis, 'get').mockResolvedValue(fresh);
            return query(cluster)({ ...options, redis: true });
        }, 'fresh'],
        ['a signal already aborted', (cluster, options) =>
            query(cluster)({ ...options, signal: AbortSignal.abort(reasonOf()) }), 'APP_GAVE_UP'],
        ['a signal that is no AbortSignal', (cluster, options) =>
            query(cluster)({ ...options, signal: { aborted: false } }), 'TypeError'],
        ['a negative timeout', (cluster, options) =>
            query(cluster)({ ...options, timeout: -1 }), 'TypeError'],
        ['values execute() cannot bind', (cluster, options) =>
            cluster.execute(APP_SQL, [undefined], options), 'TypeError'],
        ['a :name inside quotes', (cluster, options) =>
            cluster.query("UPDATE t SET a = ':a'", { a: 1 }, options), 'MDC_QUOTED_PLACEHOLDER']
    ])('%s', async (_name, start, ends) => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const asked = jest.spyOn(cluster.pools[0], 'query');
        const seen = node.seen();

        const { result, error, timings } = await timed(options => start(cluster, options));

        expect(result ?? (error instanceof TypeError ? 'TypeError' : error.code)).toBe(ends);
        expect(timings).toEqual([]);
        expect(asked).not.toHaveBeenCalled();
        expect(node.seen()).toEqual(seen);
    });
});
