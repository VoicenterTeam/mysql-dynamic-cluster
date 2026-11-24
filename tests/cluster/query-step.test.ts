import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { getEventListeners } from 'events';
import { createPoolCluster } from '../../index';
import Redis from '../../src/Redis/Redis';

// The onStep query option of cluster.query() and execute() (#140), against the real mysql2
// and mysql2's own server class on the loopback interface. onStep is called synchronously as
// an attempt enters a step, with the step and the node of the attempt, and only when one of
// the two differs from its last call: 'queue' as the attempt asks its pool for a connection,
// 'probe', 'prepare', and 'statement' once mysql2's query() or execute() returned. Jest fails
// a test that leaves a rejection unhandled while it runs, so a test that could leave one
// waits a little before it ends
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

// what a node saw, counted. closed counts the sockets of the app that closed
type Seen = 'logins' | 'statements' | 'pings' | 'uses' | 'closed';

interface INode {
    port: number,
    // keep the answer to every statement of the app from now on, until answer()
    holdStatements: () => void,
    // answer the statements held, and every later one at once
    answer: () => void,
    // answer no USE from now on
    ignoreUse: () => void,
    // answer none of the next count pings
    ignorePings: (count: number) => void,
    // keep each new login waiting from now on, until letIn()
    holdLogins: () => void,
    // let every login held in, and every later one at once
    letIn: () => void,
    seen: (what: Seen) => number,
    // resolves when the count of what went past the count it has now
    next: (what: Seen) => Promise<void>
}

const listen = async (connections: number): Promise<INode> => {
    const server: any = (mysql as any).createServer();
    const open: any[] = [];
    const held: (() => void)[] = [];
    const heldLogins: (() => void)[] = [];
    const counts: Record<Seen, number> = { logins: 0, statements: 0, pings: 0, uses: 0, closed: 0 };
    const waiters: { what: Seen, after: number, resolve: () => void }[] = [];
    const count = (what: Seen) => {
        counts[what]++;
        waiters.filter(w => w.what === what && counts[what] > w.after).forEach(w => {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve();
        });
    };
    const modes = { holding: false, ignoreUse: false, pingsToIgnore: 0, holdingLogins: false };
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
        connection.stream.on('close', () => count('closed'));
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: open.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => {
                count('logins');
                if (!modes.holdingLogins) return done(null);
                heldLogins.push(() => done(null));
            }
        });
        // the check connection changes the user before its status query, and a connection
        // the app had is reset
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || (code !== COM_CHANGE_USER && code !== COM_RESET_CONNECTION)) return;
            ok(connection);
        });
        connection.on('ping', () => {
            count('pings');
            if (modes.pingsToIgnore > 0) {
                modes.pingsToIgnore--;
                return;
            }
            ok(connection);
        });
        const statement = () => {
            count('statements');
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
                connection.sequenceId = 1;
                const columns = [column('Variable_name'), column('Value')];
                return connection.writeTextResult(status(connections), columns);
            }
            if (sql.startsWith('USE ')) {
                count('uses');
                if (modes.ignoreUse) return;
            }
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
        ignorePings: (count: number) => { modes.pingsToIgnore = count; },
        holdLogins: () => { modes.holdingLogins = true; },
        letIn: () => {
            modes.holdingLogins = false;
            heldLogins.splice(0).forEach(done => done());
        },
        seen: (what: Seen) => counts[what],
        next: (what: Seen) => new Promise<void>(resolve => {
            waiters.push({ what, after: counts[what], resolve });
        })
    };
};

const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));
afterEach(() => jest.restoreAllMocks());

// Nodes with ids 1, 2..., node 1 tried first. Each pool has one connection unless the settings
// say otherwise, so a call whose connection was not given back leaves the next call waiting.
// The health check asks on a connection of its own, and no check runs after the one of
// connect()
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
// The pool asks mysql2 a few turns after query() was called
const turns = async (until: () => boolean) => {
    for (let turn = 0; turn < 100 && !until(); turn++) await new Promise(setImmediate);
};
// a reason of the app's own, to see that it comes back as it is
const reasonOf = () => Object.assign(new Error('caller gave up'), { code: 'APP_GAVE_UP' });
const stats = (cluster: any, nodeId: number) =>
    cluster.getPoolStats().find((pool: any) => pool.nodeId === nodeId);
const listeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;
// every connection the pool of the node draws counts as idle, so the borrow probes it, a new
// one and one handed straight from another call too
const probeEvery = (cluster: any, index = 0) =>
    jest.spyOn(cluster.pools[index]._reaper, 'drawn').mockReturnValue({ aliveAt: 0 });

// what the call ends with: the result, or the error. maxRetry 2: the call may try two nodes
const call = (cluster: any, options: object = {}): Promise<{ result?: any, error?: any }> =>
    cluster.query(APP_SQL, undefined, { redis: false, maxRetry: 2, ...options }).then(
        (result: any) => ({ result }),
        (error: any) => ({ error })
    );

type Step = [string, number];
// An onStep that keeps what it is told, then runs then with it
const recorder = (then?: (step: string, nodeId: number) => void) => {
    const steps: Step[] = [];
    const onStep = jest.fn((step: string, nodeId: number) => {
        steps.push([step, nodeId]);
        then?.(step, nodeId);
    });
    return { steps, onStep };
};

describe('the steps of a call', () => {
    it('on a fresh connection: queue, prepare, statement', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const { steps, onStep } = recorder();

        const { result } = await call(cluster, { onStep });
        await pause(50);

        expect(result.affectedRows).toBe(1);
        expect(steps).toEqual([['queue', 1], ['prepare', 1], ['statement', 1]]);
    });

    it('that waits in the queue, probes an idle connection, prepares and runs', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        // a first call holds the only connection of the node
        node.holdStatements();
        const sent = node.next('statements');
        const first = cluster.query(APP_SQL, undefined, { redis: false });
        await sent;
        probeEvery(cluster);
        const { steps, onStep } = recorder();
        const pending = call(cluster, { onStep, database: OTHER });
        await turns(() => stats(cluster, 1).pending === 1);
        expect(stats(cluster, 1).pending).toBe(1);
        expect(steps).toEqual([['queue', 1]]);
        const [pings, uses] = [node.seen('pings'), node.seen('uses')];

        node.answer();
        const { result } = await pending;
        await pause(50);

        expect((await first).affectedRows).toBe(1);
        expect(result.affectedRows).toBe(1);
        expect(steps).toEqual([['queue', 1], ['probe', 1], ['prepare', 1], ['statement', 1]]);
        // the probe and the USE did go to the node
        expect([node.seen('pings') - pings, node.seen('uses') - uses]).toEqual([1, 1]);
    });

    it('that fails without sending on node 1 and runs on node 2', async () => {
        const [n1, n2] = [await listen(1), await listen(9)];
        const { cluster } = await connect([n1, n2]);
        n1.ignoreUse();
        const { steps, onStep } = recorder();

        const { result } = await call(cluster, { onStep, database: OTHER, timeout: 200 });
        await pause(50);

        expect(result.affectedRows).toBe(1);
        expect(steps).toEqual([
            ['queue', 1], ['prepare', 1], ['queue', 2], ['prepare', 2], ['statement', 2]
        ]);
        expect([n1.seen('statements'), n2.seen('statements')]).toEqual([0, 1]);
    });

    // The pool and the borrow both set queue as the attempt starts: one call. After a failed
    // probe the borrow asks mysql2 again, which is queue again
    it('two failed probes then a good one: queue and probe for each connection', async () => {
        const node = await listen(1);
        // connectionLimit 2: the borrow tries up to three connections
        const { cluster } = await connect([node], {
            connectionLimit: 2, probeTimeout: 100, idleCheckInterval: LONG
        });
        probeEvery(cluster);
        node.ignorePings(2);
        const pings = node.seen('pings');
        const { steps, onStep } = recorder();

        const { result } = await call(cluster, { onStep });
        await pause(50);

        expect(result.affectedRows).toBe(1);
        expect(node.seen('pings') - pings).toBe(3);
        expect(steps).toEqual([
            ['queue', 1], ['probe', 1], ['queue', 1], ['probe', 1], ['queue', 1], ['probe', 1],
            ['prepare', 1], ['statement', 1]
        ]);
    });

    it.each([
        ['query()', 'query', (cluster: any, options: object) => call(cluster, options)],
        ['execute()', 'execute', (cluster: any, options: object) =>
            cluster.execute(APP_SQL, undefined, { redis: false, ...options })
                .then((result: any) => ({ result }))],
        ['query() with execute: true', 'execute', (cluster: any, options: object) =>
            cluster.query(APP_SQL, undefined, { redis: false, execute: true, ...options })
                .then((result: any) => ({ result }))]
    ])('%s: statement comes once mysql2 took the statement, and not before',
        async (_name, method, ask) => {
            const node = await listen(1);
            const { cluster } = await connect([node]);
            // what mysql2 got from the pools of the app when each step was told
            const handed = jest.spyOn((mysql as any).Connection.prototype, method);
            const tookIt = () => handed.mock.calls
                .map((args, index) => [args[0], handed.mock.results[index]] as [any, any])
                .filter(([options, outcome]) => options?.sql === APP_SQL
                    && outcome.type === 'return').length;
            const atStep: [string, number][] = [];
            const { steps, onStep } = recorder(step => atStep.push([step, tookIt()]));

            const { result } = await ask(cluster, { onStep });
            await pause(50);

            expect(result.affectedRows).toBe(1);
            expect(steps).toEqual([['queue', 1], ['prepare', 1], ['statement', 1]]);
            expect(atStep).toEqual([['queue', 0], ['prepare', 0], ['statement', 1]]);
            expect(node.seen('statements')).toBe(1);
        });
});

describe('an abort inside onStep', () => {
    it('at queue, while the one connection is taken: the request asks for no connection',
        async () => {
            const [n1, n2] = [await listen(1), await listen(9)];
            const { cluster } = await connect([n1, n2]);
            n1.holdStatements();
            const sent = n1.next('statements');
            const first = cluster.query(APP_SQL, undefined, { redis: false });
            await sent;
            const controller = new AbortController();
            const reason = reasonOf();
            const { steps, onStep } = recorder(step => {
                if (step === 'queue') controller.abort(reason);
            });
            const second = jest.spyOn(cluster.pools[1], 'query');

            const { error } = await call(cluster, { signal: controller.signal, onStep });
            await pause(50);

            expect(error).toBe(reason);
            // nothing is written on the reason of the app
            expect(Object.keys(error)).toEqual(['code']);
            expect(steps).toEqual([['queue', 1]]);
            expect(second).not.toHaveBeenCalled();
            expect(stats(cluster, 1).pending).toBe(0);
            expect(listeners(controller.signal)).toBe(0);
            // the connection goes back to the pool when the first call ends
            n1.answer();
            expect((await first).affectedRows).toBe(1);
            await turns(() => stats(cluster, 1).idle === 1);
            expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 1, pending: 0 });
            expect([n1.seen('statements'), n2.seen('statements')]).toEqual([1, 0]);
        });

    it.each<[string, Step[], number]>([
        ['probe', [['queue', 1], ['probe', 1]], 0],
        ['prepare', [['queue', 1], ['probe', 1], ['prepare', 1]], 0],
        ['statement', [['queue', 1], ['probe', 1], ['prepare', 1], ['statement', 1]], 1]
    ])('at %s: the reason, no later step, the connection destroyed', async (at, told, uses) => {
        const [n1, n2] = [await listen(1), await listen(9)];
        const { cluster } = await connect([n1, n2]);
        probeEvery(cluster);
        const controller = new AbortController();
        const reason = reasonOf();
        const { steps, onStep } = recorder(step => {
            if (step === at) controller.abort(reason);
        });
        const second = jest.spyOn(cluster.pools[1], 'query');
        const closed = n1.next('closed');

        const options = { signal: controller.signal, onStep, database: OTHER };
        const { error } = await call(cluster, options);
        await closed;
        await pause(50);

        expect(error).toBe(reason);
        expect(Object.keys(error)).toEqual(['code']);
        expect(steps).toEqual(told);
        expect(n1.seen('uses')).toBe(uses);
        if (at !== 'statement') expect(n1.seen('statements')).toBe(0);
        expect(second).not.toHaveBeenCalled();
        expect(n2.seen('statements')).toBe(0);
        expect(listeners(controller.signal)).toBe(0);
        // destroyed, not given back: the slot is free, and the next call opens a new one
        expect(stats(cluster, 1)).toMatchObject({ used: 0, idle: 0, pending: 0 });
        const logins = n1.seen('logins');
        expect((await call(cluster)).result.affectedRows).toBe(1);
        expect(n1.seen('logins')).toBe(logins + 1);
    });
});

describe('what onStep throws or rejects with', () => {
    const THREW = 'onStep of a query threw or rejected, the call keeps its result: ';
    const warnings = (logger: { warn: jest.Mock }) => logger.warn.mock.calls
        .filter(([message]: unknown[]) => String(message).includes('onStep'));

    it('a throw at every step: the call resolves, one warning', async () => {
        const node = await listen(1);
        const { cluster, logger } = await connect([node]);
        const onStep = jest.fn(() => { throw new Error('bad step'); });

        const { result } = await call(cluster, { onStep });
        await pause(50);

        expect(result.affectedRows).toBe(1);
        expect(onStep).toHaveBeenCalledTimes(3);
        expect(warnings(logger)).toEqual([[THREW + 'bad step', { nodeId: 1 }]]);
    });

    it('a throw, and a call that fails on its node: the same error as without onStep',
        async () => {
            const node = await listen(1);
            const { cluster, logger } = await connect([node]);
            node.ignoreUse();
            const options = { database: OTHER, timeout: 200 };
            const without = (await call(cluster, options)).error;
            const onStep = jest.fn(() => { throw new Error('bad step'); });

            const { error } = await call(cluster, { ...options, onStep });
            await pause(50);

            expect([error.code, error.nodeId, error.sent]).toEqual([without.code, 1, false]);
            expect(Object.keys(error).sort()).toEqual(Object.keys(without).sort());
            expect(onStep).toHaveBeenCalledTimes(2);
            expect(warnings(logger)).toEqual([[THREW + 'bad step', { nodeId: 1 }]]);
        });

    it('an abort, then a throw, at statement: the reason as it is, one warning', async () => {
        const node = await listen(1);
        const { cluster, logger } = await connect([node]);
        const controller = new AbortController();
        const reason = reasonOf();
        const onStep = jest.fn((step: string) => {
            if (step !== 'statement') return;
            controller.abort(reason);
            throw new Error('bad step');
        });

        const { error } = await call(cluster, { signal: controller.signal, onStep });
        await pause(50);

        expect(error).toBe(reason);
        expect(Object.keys(error)).toEqual(['code']);
        expect(warnings(logger)).toEqual([[THREW + 'bad step', { nodeId: 1 }]]);
    });

    it('an async one that rejects at every step: the call resolves, one warning', async () => {
        const node = await listen(1);
        const { cluster, logger } = await connect([node]);
        const onStep = jest.fn(async () => { throw new Error('async boom'); });

        const { result } = await call(cluster, { onStep });
        // the rejections are handled on a later turn
        await pause(50);

        expect(result.affectedRows).toBe(1);
        expect(onStep).toHaveBeenCalledTimes(3);
        expect(warnings(logger)).toEqual([[THREW + 'async boom', { nodeId: 1 }]]);
    });
});

describe('the option itself', () => {
    it.each([
        ['a number', 1, 'query'],
        ['a string', 'onStep', 'query'],
        ['an object', {}, 'query'],
        ['a number, to execute()', 1, 'execute']
    ])('%s rejects with a TypeError and sent: false, and no node is asked',
        async (_name, onStep, method) => {
            const node = await listen(1);
            const { cluster } = await connect([node]);
            const asked = jest.spyOn(cluster.pools[0], 'query');
            const logins = node.seen('logins');

            const error = await cluster[method](APP_SQL, undefined, { redis: false, onStep })
                .catch((e: unknown) => e);

            expect(error).toBeInstanceOf(TypeError);
            expect(error.message).toBe('query: options.onStep must be a function');
            expect(error.sent).toBe(false);
            expect(asked).not.toHaveBeenCalled();
            expect(node.seen('logins')).toBe(logins);
        });

    it('null counts as no onStep', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);

        const { result } = await call(cluster, { onStep: null });

        expect(result.affectedRows).toBe(1);
    });

    it('without it, the timing of an attempt holds no function', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const asked = jest.spyOn(cluster.pools[0], 'query');

        await call(cluster);

        const { timing } = asked.mock.calls[0][3] as any;
        expect(Object.values(timing).filter(value => typeof value === 'function')).toEqual([]);
    });

    it('a Redis hit: not called', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const fresh = JSON.stringify({ data: 'fresh', expired: Date.now() + LONG });
        jest.spyOn(Redis, 'get').mockResolvedValue(fresh);
        const onStep = jest.fn();

        const { result } = await call(cluster, { onStep, redis: true });

        expect(result).toBe('fresh');
        expect(onStep).not.toHaveBeenCalled();
    });

    it('getConnection() and multiStatementQuery() of a pool do not take it', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        const onStep = jest.fn();

        const { connection } = await cluster.getConnection({ onStep });
        connection.release();
        const results = await cluster.pools[0].multiStatementQuery([APP_SQL], { onStep });

        expect(results[0].affectedRows).toBe(1);
        expect(onStep).not.toHaveBeenCalled();
    });
});

describe('onStep beside onTiming', () => {
    // onTiming of a call with no onStep, then of the same call with one
    const twice = async (cluster: any, options: object) => {
        const timings: unknown[][] = [[], []];
        await call(cluster, { ...options, onTiming: (timing: unknown) => timings[0].push(timing) });
        const { onStep } = recorder();
        const order: string[] = [];
        await call(cluster, { ...options, onStep, onTiming: (timing: unknown) => {
            timings[1].push(timing);
            order.push('timing');
        } }).then(() => order.push('settled'));
        return { timings, order, onStep };
    };

    it('a call that resolves on its node: onTiming once, with the same values', async () => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        await call(cluster);

        const { timings, order, onStep } = await twice(cluster, {});

        const once = [{ step: 'statement', queuedMs: expect.any(Number), nodeId: 1 }];
        expect(timings[0]).toEqual(once);
        expect(timings[1]).toEqual(once);
        expect(order).toEqual(['timing', 'settled']);
        expect(onStep).toHaveBeenCalledTimes(3);
    });

    it('a call that fails without sending on node 1 and runs on node 2: the same values',
        async () => {
            const [n1, n2] = [await listen(1), await listen(9)];
            const { cluster } = await connect([n1, n2]);
            n1.ignoreUse();

            const { timings, order, onStep } =
                await twice(cluster, { database: OTHER, timeout: 200 });

            expect(timings[0]).toEqual([
                { step: 'statement', queuedMs: expect.any(Number), nodeId: 2 }
            ]);
            expect(timings[1]).toEqual([
                { step: 'statement', queuedMs: expect.any(Number), nodeId: 2 }
            ]);
            expect(order).toEqual(['timing', 'settled']);
            expect(onStep.mock.calls.map(([step, nodeId]) => [step, nodeId])).toEqual([
                ['queue', 1], ['prepare', 1], ['queue', 2], ['prepare', 2], ['statement', 2]
            ]);
        });
});

// Each scenario runs one call with the options it is handed, and says the step and the node
// onTiming should report, so the scenario is known to reach that case
type Scenario = [string, string, number, (both: any) => Promise<unknown>];
const abortInside = (at: string): Scenario => [`an abort inside onStep at ${at}`, at, 1,
    async both => {
        const [n1, n2] = [await listen(1), await listen(9)];
        const { cluster } = await connect([n1, n2]);
        probeEvery(cluster);
        const controller = new AbortController();
        const onStep = (step: string, nodeId: number) => {
            both.onStep(step, nodeId);
            if (step === at) controller.abort(reasonOf());
        };
        return call(cluster, { ...both, onStep, signal: controller.signal, database: OTHER });
    }];
const scenarios: Scenario[] = [
    ['a call on a fresh connection', 'statement', 1, async both => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        return call(cluster, both);
    }],
    ['a call that waits in the queue, probes, prepares and runs', 'statement', 1, async both => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        node.holdStatements();
        const sent = node.next('statements');
        const first = cluster.query(APP_SQL, undefined, { redis: false });
        await sent;
        probeEvery(cluster);
        const pending = call(cluster, { ...both, database: OTHER });
        await turns(() => stats(cluster, 1).pending === 1);
        node.answer();
        await first;
        return pending;
    }],
    ['a call that fails without sending on node 1 and runs on node 2', 'statement', 2,
        async both => {
            const [n1, n2] = [await listen(1), await listen(9)];
            const { cluster } = await connect([n1, n2]);
            n1.ignoreUse();
            return call(cluster, { ...both, database: OTHER, timeout: 200 });
        }],
    ['a call whose only node answers no USE', 'prepare', 1, async both => {
        const node = await listen(1);
        const { cluster } = await connect([node]);
        node.ignoreUse();
        return call(cluster, { ...both, database: OTHER, timeout: 200 });
    }],
    ['two failed probes then a good one', 'statement', 1, async both => {
        const node = await listen(1);
        const { cluster } = await connect([node], {
            connectionLimit: 2, probeTimeout: 100, idleCheckInterval: LONG
        });
        probeEvery(cluster);
        node.ignorePings(2);
        return call(cluster, both);
    }],
    ['every connection fails its probe', 'probe', 1, async both => {
        const node = await listen(1);
        const { cluster } = await connect([node], { probeTimeout: 100, idleCheckInterval: LONG });
        probeEvery(cluster);
        node.ignorePings(2);
        return call(cluster, both);
    }],
    ['an abort while a new connection logs in after a failed probe', 'queue', 1, async both => {
        const node = await listen(1);
        const { cluster } = await connect([node], { probeTimeout: 100, idleCheckInterval: LONG });
        probeEvery(cluster);
        node.ignorePings(1);
        const controller = new AbortController();
        const pinged = node.next('pings');
        const pending = call(cluster, { ...both, signal: controller.signal });
        await pinged;
        // the probe runs out, and the borrow asks mysql2 for a new connection
        node.holdLogins();
        await node.next('logins');
        controller.abort(reasonOf());
        const ended = await pending;
        node.letIn();
        return ended;
    }],
    ...['queue', 'probe', 'prepare', 'statement'].map(abortInside)
];

describe('the last onStep of a call is the step and the node onTiming reports', () => {
    it.each(scenarios)('%s: %s on node %i', async (_name, step, nodeId, run) => {
        const steps: Step[] = [];
        const timings: any[] = [];
        const both = {
            onStep: (told: string, node: number) => { steps.push([told, node]); },
            onTiming: (timing: unknown) => { timings.push(timing); }
        };

        await run(both);
        await pause(50);

        expect(timings).toEqual([{ step, queuedMs: expect.any(Number), nodeId }]);
        expect(steps[steps.length - 1]).toEqual([step, nodeId]);
        // never the same step on the same node twice in a row
        const repeated = steps.filter((told, index) => index > 0
            && told[0] === steps[index - 1][0] && told[1] === steps[index - 1][1]);
        expect(repeated).toEqual([]);
    });
});
