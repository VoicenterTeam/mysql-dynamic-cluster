// a mysql2 that opens nothing. Every pool it creates asks the fake node of its host
jest.mock('mysql2', () => ({
    __esModule: true,
    default: { createPool: jest.fn(), createConnection: jest.fn() }
}));

import mysql from 'mysql2';
import { createPoolCluster } from '../../index';
import config from '../../src/configs';

// The health check as 4.6.0 runs it for an app that sets no healthCheck block. The redesign
// of the health check (issue #76) has to leave all of it as it is. Every number here is
// worked out by hand from the settings, never read from the code under test.
// The cluster is the one an app gets from createPoolCluster. Only mysql2 is replaced, and
// the clock is fake: a wait is the fake time between two requests for a connection

type Cb = (err: any, res?: any) => void;
type Rows = { Variable_name: string, Value: string }[];
// How one request for a connection ends. Rows answer the status query. 'refused' and
// 'denied' fail the request at once, 'lost' breaks the connection under the query, and
// 'hang' hands out a connection that never answers
type Step = Rows | 'refused' | 'denied' | 'lost' | 'hang';

// SHOW GLOBAL STATUS of a node that every default validator accepts. With the default load
// factors its score is 2 * connections + 10 * 0.5
const up = (connections = 7, ready = 'ON'): Rows => [
    { Variable_name: 'wsrep_ready', Value: ready },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '3' },
    { Variable_name: 'Connections', Value: String(connections) },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0.5' }
];
// the same node while it is not ready: it answers, and the first default validator says no
const notReady = (connections = 7): Rows => up(connections, 'OFF');
const PASS = up();
const NO = notReady();

// the errors mysql2 gives for a node that takes no connection, for a refused login and for
// a connection that broke. Only the first and the last are fatal
const errors = {
    refused: () => Object.assign(new Error('connect ECONNREFUSED'),
        { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', fatal: true }),
    denied: () => Object.assign(new Error('Access denied'),
        { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }),
    lost: () => Object.assign(new Error('Connection lost: The server closed the connection.'),
        { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })
};

const makeNode = (steps: Step[]) => {
    const node = {
        // the fake time of every request for a connection: the checks and the app's own
        asked: [] as number[],
        // the timeout mysql2 was handed with each status query
        timeouts: [] as number[],
        // how the next requests end, in order. The last one stays for every request after it
        plan: steps,
        mysqlPool: {
            on: jest.fn(), end: jest.fn(),
            _allConnections: [], _freeConnections: [], _connectionQueue: [],
            getConnection: (cb: Cb) => {
                node.asked.push(Date.now());
                const step = node.plan.length > 1 ? node.plan.shift() : node.plan[0];
                if (step === 'refused' || step === 'denied') return cb(errors[step]());
                cb(null, {
                    changeUser: (_options: any, done: Cb) => done(null),
                    query: (options: any, done: Cb) => {
                        const isCheck = options.sql === 'SHOW GLOBAL STATUS;';
                        if (isCheck) node.timeouts.push(options.timeout);
                        if (step === 'lost') return done(errors.lost());
                        if (step !== 'hang') done(null, step);
                    },
                    release: jest.fn(), destroy: jest.fn()
                });
            }
        }
    };
    return node;
};
type FakeNode = ReturnType<typeof makeNode>;

let nodes: { [host: string]: FakeNode };
let cluster: any;
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// the fake node behind a host, with how its requests end
const fakeNode = (steps: Step[], host: string = 'node-a'): FakeNode => {
    nodes[host] = makeNode(steps);
    return nodes[host];
};

// The settings an app passes. flags are set so that connect() asks no server for its
// version. The check settings are the ones of the schema unless `pool` or a host sets them
const settingsOf = (pool: object, hosts: object[] = [{ host: 'node-a' }]): any => ({
    clusterName: 'test',
    hosts,
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [], ...pool },
    useClusterHashing: false,
    logger
});

// A cluster that connected: every node had its first check
const start = async (pool: object, hosts?: object[]) => {
    cluster = createPoolCluster(settingsOf(pool, hosts));
    // connect() rejects when the first check fails. ready tells when that check is over
    cluster.connect().catch((): void => undefined);
    await cluster.ready;
};

// run the fake clock up to the next request for a connection of this node
const nextCheck = async (node: FakeNode) => {
    const before = node.asked.length;
    // other timers run in between: the timeout of a check that hangs, the idle reaper
    for (let i = 0; i < 20 && node.asked.length === before; i++) {
        await jest.advanceTimersToNextTimerAsync();
    }
    expect(node.asked.length).toBe(before + 1);
};
const pass = (ms: number) => jest.advanceTimersByTimeAsync(ms);

const info = (index: number = 0) => cluster.nodes()[index];
const valid = (index: number = 0): boolean => info(index).isValid;
// the time between each request for a connection and the one before it
const waits = (node: FakeNode): number[] => node.asked.slice(1).map((at, i) => at - node.asked[i]);

// The two settings sets that have to keep their timing. The default one is range 5000 to
// 15000, multiplier 1.3 and queryTimeout 120000. The other is what a consumer runs with
const DEFAULTS = {};
const CONSUMER = {
    timerCheckRange: { start: 15000, end: 60000 }, timerCheckMultiplier: 0.1, queryTimeout: 15000
};

beforeEach(() => {
    jest.useFakeTimers();
    nodes = {};
    (mysql.createPool as jest.Mock)
        .mockImplementation((options: any) => nodes[options.host].mysqlPool);
});

afterEach(async () => {
    await cluster?.disconnect();
    cluster = undefined;
    jest.useRealTimers();
});

describe('legacy health check: the wait before the next check', () => {
    // What each check ends with, and the wait the next check is set to after it, in ms.
    // The wait starts at 10000. A check that got its answer multiplies it by
    // timerCheckMultiplier, a failed one divides it, and the result is held inside
    // timerCheckRange. The wait keeps its fraction from one check to the next. The timer
    // runs on whole ms, so the fraction is cut off there
    type Run = [Step, number][];
    it.each<[string, object, Run]>([
        ['the default settings, a run of passes', DEFAULTS, [
            [PASS, 13000],       // 10000 * 1.3
            [PASS, 15000],       // 16900, held at the end of the range
            [PASS, 15000],
            [PASS, 15000]
        ]],
        ['the default settings, a run of failures', DEFAULTS, [
            ['refused', 7692],   // 10000 / 1.3 = 7692.31
            ['refused', 5917],   // 7692.31 / 1.3 = 5917.16
            ['refused', 5000],   // 4551.66, held at the start of the range
            ['refused', 5000],
            ['refused', 5000]
        ]],
        ['the default settings, a node that fails and comes back', DEFAULTS, [
            [PASS, 13000],
            [PASS, 15000],
            ['refused', 11538],  // 15000 / 1.3 = 11538.46
            ['refused', 8875],   // 8875.74
            ['refused', 6827],   // 6827.49
            ['refused', 5251],   // 5251.92
            ['refused', 5000],   // 4039.94, held at the start of the range
            [PASS, 6500],        // 5000 * 1.3
            [PASS, 8450],
            [PASS, 10985],
            [PASS, 14280],       // 14280.5
            [PASS, 15000]        // 18564.65, held at the end of the range
        ]],
        ['the default settings, one failed check between passes', DEFAULTS, [
            [PASS, 13000],
            [PASS, 15000],
            ['refused', 11538],  // 15000 / 1.3 = 11538.461538461537
            [PASS, 14999],       // times 1.3 is 14999.999999999998, and the timer cuts it
            [PASS, 15000]        // 19500, held at the end of the range
        ]],
        ['the default settings, whatever a check fails with', DEFAULTS, [
            [PASS, 13000],
            [PASS, 15000],
            ['denied', 11538],   // a refused login waits like any other failure
            ['lost', 8875],
            ['refused', 6827]
        ]],
        ['the default settings, a validator that says no', DEFAULTS, [
            [PASS, 13000],
            [NO, 15000],         // the check got its answer: 16900, held at the end
            ['refused', 11538],
            [NO, 14999]          // as after a pass: 14999.999999999998, cut by the timer
        ]],
        ['the settings of a consumer, a run of passes', CONSUMER, [
            [PASS, 15000],       // 10000 * 0.1 = 1000, held at the start of the range
            [PASS, 15000],       // 15000 * 0.1 = 1500, held at the start again
            [PASS, 15000]
        ]],
        ['the settings of a consumer, a run of failures', CONSUMER, [
            ['refused', 60000],  // 10000 / 0.1 = 100000, held at the end of the range
            ['refused', 60000],  // 60000 / 0.1 = 600000, held at the end again
            ['refused', 60000]
        ]],
        ['the settings of a consumer, a node that fails and comes back', CONSUMER, [
            [PASS, 15000],
            ['refused', 60000],  // 15000 / 0.1 = 150000, held at the end
            [PASS, 15000],       // 60000 * 0.1 = 6000, held at the start
            ['denied', 60000],
            ['lost', 60000],
            [NO, 15000],
            [PASS, 15000]
        ]]
    ])('%s', async (_name, pool, run) => {
        const node = fakeNode(run.map(([step]) => step));
        await start(pool);

        await pass(run.reduce((sum, [, wait]) => sum + wait, 0));

        expect(waits(node)).toEqual(run.map(([, wait]) => wait));
    });
});

describe('legacy health check: the timeout of one check', () => {
    // min(queryTimeout, timerCheckRange.end). queryTimeout 0 means no query timeout, so
    // the end of the range is the limit then
    describe.each<[string, object, number]>([
        // min(120000, 15000)
        ['the default settings', DEFAULTS, 15000],
        ['the default range, queryTimeout 3000', { queryTimeout: 3000 }, 3000],
        ['the default range, queryTimeout 0', { queryTimeout: 0 }, 15000],
        // min(15000, 60000)
        ['the settings of a consumer', CONSUMER, 15000],
        ['the range of a consumer, queryTimeout 120000',
            { ...CONSUMER, queryTimeout: 120000 }, 60000],
        ['the range of a consumer, queryTimeout 0', { ...CONSUMER, queryTimeout: 0 }, 60000]
    ])('%s', (_name, pool, timeout) => {
        it(`hands ${timeout} to mysql2 with the status query`, async () => {
            const node = fakeNode([PASS]);
            await start(pool);
            await nextCheck(node);

            expect(node.timeouts).toEqual([timeout, timeout]);
        });

        it(`fails a check that hangs at ${timeout} ms, not 1 ms sooner`, async () => {
            const node = fakeNode([PASS, 'hang']);
            await start(pool);
            await nextCheck(node);

            await pass(timeout - 1);
            expect(info().checkError).toBeUndefined();
            await pass(1);
            // a check that ran into its own timer reports an empty error
            expect(info().checkError).toEqual({});
        });
    });
});

describe('legacy health check: when a node goes down and comes back', () => {
    // every step is one check. The first one is the check of connect()
    const afterChecks = async (steps: Step[]): Promise<FakeNode> => {
        const node = fakeNode([...steps]);
        await start(DEFAULTS);
        for (let i = 1; i < steps.length; i++) await nextCheck(node);
        return node;
    };

    describe.each<[string, Step]>([
        ['a refused connection', 'refused'],
        ['a refused login', 'denied'],
        ['a lost connection', 'lost'],
        ['its own timeout', 'hang']
    ])('a check that fails with %s', (_name, failure) => {
        // the check after the failures hangs, so nothing but the failures has ended yet
        it('leaves a valid node valid the first time', async () => {
            const node = await afterChecks([PASS, failure, 'hang']);

            expect(node.asked).toHaveLength(3);
            expect(valid()).toBe(true);
        });

        it('takes the node out the second time in a row', async () => {
            const node = await afterChecks([PASS, failure, failure, 'hang']);

            expect(node.asked).toHaveLength(4);
            expect(valid()).toBe(false);
        });
    });

    it.each<[string, Step[], boolean]>([
        ['a pass between two failures resets the count',
            [PASS, 'refused', PASS, 'refused'], true],
        ['two failures in a row after that pass take the node out',
            [PASS, 'refused', PASS, 'refused', 'refused'], false],
        ['one answered check brings a node back that failed twice',
            [PASS, 'refused', 'refused', PASS], true],
        ['one answered check brings in a node that never passed',
            ['refused', 'refused', 'refused', PASS], true],
        ['a validator that says no takes the node out with one check',
            [PASS, NO], false],
        ['one pass brings a node back that a validator took out',
            [PASS, NO, PASS], true],
        ['a failed check after a validator said no leaves the node out',
            [PASS, NO, 'refused'], false]
    ])('%s', async (_name, steps, wanted) => {
        const node = await afterChecks(steps);

        expect(node.asked).toHaveLength(steps.length);
        expect(valid()).toBe(wanted);
    });

    it('a failed check keeps the load score, an answered one sets it, valid or not', async () => {
        const steps: Step[] = [up(7), 'refused', up(9), notReady(11), 'refused', 'refused'];
        const node = fakeNode([...steps]);
        await start(DEFAULTS);
        const scores = [info().loadScore];
        for (let i = 1; i < steps.length; i++) {
            await nextCheck(node);
            scores.push(info().loadScore);
        }

        // 2 * Connections + 10 * 0.5 after each answered check
        expect(scores).toEqual([19, 19, 23, 27, 27, 27]);
    });

    it('a node that never got an answer keeps the load score it starts with', async () => {
        const node = fakeNode(['refused']);
        await start(DEFAULTS);
        await nextCheck(node);

        expect(info().loadScore).toBe(100000);
    });
});

// A node that passed three checks, so its wait is the longest one, and stops right after
// the last of them: from here on every request ends as `how` says
const dying = async (pool: object, how: Step): Promise<FakeNode> => {
    const node = fakeNode([PASS, PASS, PASS, how]);
    await start(pool);
    await nextCheck(node);
    await nextCheck(node);
    return node;
};

describe('legacy health check: the time a dead node takes to leave rotation', () => {
    // from the moment the node stops until it is out, at the second failed check
    it.each<[string, object, Step, number]>([
        // wait 15000, fail, wait 11538, fail
        ['the default settings, connections refused: 26538 ms', DEFAULTS, 'refused', 26538],
        // wait 15000, hang 15000, wait 11538, hang 15000
        ['the default settings, checks that hang: 56538 ms', DEFAULTS, 'hang', 56538],
        // wait 15000, fail, wait 60000, fail
        ['the settings of a consumer, connections refused: 75000 ms', CONSUMER, 'refused', 75000],
        // wait 15000, hang 15000, wait 60000, hang 15000
        ['the settings of a consumer, checks that hang: 105000 ms', CONSUMER, 'hang', 105000]
    ])('%s', async (_name, pool, how, total) => {
        await dying(pool, how);

        await pass(total - 1);
        expect(valid()).toBe(true);
        await pass(1);
        expect(valid()).toBe(false);
    });
});

describe('legacy health check: no passive health', () => {
    // What the queries and connections of the app run into changes nothing: only a check
    // moves isValid, the count of failed checks or the time of the next check
    const app = {
        query: () => cluster.query('SELECT 1'),
        getConnection: () => cluster.getConnection()
    };
    type Call = keyof typeof app;
    // the fake times of the requests for a connection since the node stopped
    const since = (died: number, node: FakeNode) => node.asked.slice(3).map(at => at - died);

    // `steady` is the wait of a node that keeps passing, `afterFailure` the wait after
    // its first failed check
    describe.each<[string, object, number, number]>([
        ['the default settings', DEFAULTS, 15000, 11538],
        ['the settings of a consumer', CONSUMER, 15000, 60000]
    ])('%s', (_name, pool, steady, afterFailure) => {
        describe.each<[string, Step, Call]>([
            ['a query that finds the connection refused', 'refused', 'query'],
            ['a query that loses its connection', 'lost', 'query'],
            ['a getConnection() that is refused', 'refused', 'getConnection']
        ])('%s', (_what, how, call) => {
            it('leaves the node valid and its next check where it was', async () => {
                const node = await dying(pool, how);
                const died = Date.now();

                await pass(5000);
                await expect(app[call]()).rejects.toBeInstanceOf(Error);
                expect(valid()).toBe(true);
                await pass(steady - 5000);

                // the request of the app, then the check that was due. That check failed,
                // and it is the first failure: the node is still valid
                expect(since(died, node)).toEqual([5000, steady]);
                expect(valid()).toBe(true);
            });

            it('neither adds to one failed check nor clears it', async () => {
                const node = await dying(pool, how);
                const died = Date.now();

                await pass(steady + 1000);
                await expect(app[call]()).rejects.toBeInstanceOf(Error);
                expect(valid()).toBe(true);
                await pass(afterFailure - 1000 - 1);
                expect(valid()).toBe(true);
                await pass(1);

                // out at the second failed check, at the time it was due
                expect(valid()).toBe(false);
                expect(since(died, node)).toEqual([steady, steady + 1000, steady + afterFailure]);
            });
        });
    });
});

describe('legacy health check: a host with check settings of its own', () => {
    // node-b sets the end of its range and its multiplier. The start of its range and its
    // queryTimeout are the default ones
    const hosts = [
        { host: 'node-a' },
        { host: 'node-b', timerCheckRange: { end: 30000 }, timerCheckMultiplier: 2 }
    ];
    const twoNodes = async () => {
        const a = fakeNode([PASS], 'node-a');
        const b = fakeNode([PASS, PASS, PASS, 'refused'], 'node-b');
        await start(DEFAULTS, hosts);
        return { a, b };
    };

    it('is checked by its own range and multiplier, the other host by the defaults', async () => {
        const { a, b } = await twoNodes();

        await pass(112500);

        // 10000 * 2, then 40000 held at 30000, then halved down to the default start
        expect(waits(b)).toEqual([20000, 30000, 30000, 15000, 7500, 5000, 5000]);
        expect(waits(a).slice(0, 3)).toEqual([13000, 15000, 15000]);
    });

    it('has the check timeout of its own range', async () => {
        const { a, b } = await twoNodes();

        // min(120000, 30000) for node-b, min(120000, 15000) for node-a
        expect(b.timeouts).toEqual([30000]);
        expect(a.timeouts).toEqual([15000]);
    });
});

describe('legacy health check: the settings', () => {
    const errorLines = (settings: object): string[] => {
        try {
            createPoolCluster(settings as any);
        } catch (e) {
            return e.message.split('\n');
        }
        return [];
    };

    it('settings without a healthCheck key are accepted and get none from the defaults', () => {
        const hosts = [{ host: 'node-a' }, { host: 'node-b', ...CONSUMER }];
        expect(() => createPoolCluster(settingsOf(CONSUMER, hosts))).not.toThrow();

        expect('healthCheck' in config.current.defaultPoolSettings).toBe(false);
        expect(config.current.hosts.map(host => 'healthCheck' in host)).toEqual([false, false]);
    });

    // TODAY'S FACT, AND THE ONE TEST HERE THAT STEP 2 OF THE REDESIGN IS EXPECTED TO CHANGE.
    // 4.6.0 knows no healthCheck block, so its strict schema refuses the key. Step 2 adds
    // the block to the schema: this test then turns into one that accepts it
    it.each<[string, object, string]>([
        ['defaultPoolSettings', settingsOf({ healthCheck: {} }), 'defaultPoolSettings'],
        ['a host', settingsOf({}, [{ host: 'node-a', healthCheck: {} }]), 'hosts[0]']
    ])('a healthCheck key in %s is refused by the strict schema', (_where, settings, at) => {
        const lines = errorLines(settings);

        expect(lines[0]).toBe('Invalid mysql-dynamic-cluster settings:');
        expect(lines).toContain('✖ Unrecognized key: "healthCheck"');
        expect(lines).toContain(`  → at ${at}`);
    });
});
