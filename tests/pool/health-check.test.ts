// a mysql2 that opens nothing. Every pool it creates asks the fake node of its host
jest.mock('mysql2', () => ({
    __esModule: true,
    default: { createPool: jest.fn(), createConnection: jest.fn() }
}));

import mysql from 'mysql2';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { createPoolCluster } from '../../index';
import config from '../../src/configs';

// The health check of a node that has a healthCheck block: a fixed wait between two checks,
// down after `fall` failed checks in a row, back after `rise` passed ones. Every number here
// is worked out by hand from the settings, never read from the code under test.
// The cluster is the one an app gets from createPoolCluster. Only mysql2 is replaced, and
// the clock is fake: a wait is the fake time between two requests for a connection.
// The fake node and the helpers are those of health-check-legacy.test.ts, copied: that suite
// pins the check of a node without the block and stays as it is

type Cb = (err: any, res?: any) => void;
type Rows = { Variable_name: string, Value: string }[];
// How one request for a connection ends. Rows answer the status query, 'slow' answers it
// with a pass after SLOW ms. 'refused' and 'denied' fail the request at once, 'lost' breaks
// the connection under the query, and 'hang' hands out a connection that never answers.
// 'held' hands out one that answers when the test says so, through node.held
type Step = Rows | 'slow' | 'refused' | 'denied' | 'lost' | 'hang' | 'held';
const SLOW = 1200;

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
// The same two answers with a Connections value the load factors cannot turn into a number:
// the validators say yes or no as before, and then the check throws
const unreadable = { valueOf: () => { throw new Error('no number'); } } as any;
const throwing = (rows: Rows): Rows => rows.map(row => {
    return row.Variable_name === 'Connections' ? { ...row, Value: unreadable } : row;
});
const PASS_THROWS = throwing(PASS);
const NO_THROWS = throwing(NO);

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
        // the fake time of every request for a connection
        asked: [] as number[],
        // the timeout mysql2 was handed with each status query
        timeouts: [] as number[],
        // how the next requests end, in order. The last one stays for every request after it
        plan: steps,
        // the status queries that wait for the test to answer them
        held: [] as Cb[],
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
                        node.timeouts.push(options.timeout);
                        if (step === 'lost') return done(errors.lost());
                        if (step === 'slow') return setTimeout(() => done(null, PASS), SLOW);
                        if (step === 'held') return node.held.push(done);
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
// version. `pool` goes into defaultPoolSettings, with the healthCheck block when it has one
const settingsOf = (pool: object, hosts: object[] = [{ host: 'node-a' }]): any => ({
    clusterName: 'test',
    hosts,
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [], ...pool },
    useClusterHashing: false,
    logger
});

// connect() rejects when the first check fails. ready tells when that check is over
const connect = async () => {
    cluster.connect().catch((): void => undefined);
    return cluster.ready;
};

// A cluster that connected: every node had its first check
const start = async (pool: object, hosts?: object[]) => {
    cluster = createPoolCluster(settingsOf(pool, hosts));
    await connect();
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

// The values a consumer runs its legacy check with. A node with a healthCheck block
// has to ignore them
const CONSUMER = {
    timerCheckRange: { start: 15000, end: 60000 }, timerCheckMultiplier: 0.1, queryTimeout: 15000
};
// what an empty block stands for
const DEFAULT_BLOCK = {
    interval: 5000, timeout: 5000, fall: 2, rise: 2, authRetryInterval: 60000, passive: true
};

// One letter per check. P passes, S passes after SLOW ms, N is answered and the validator
// says no. The rest fail: R connection refused, D login denied, L connection lost, H hangs.
// B and X are answered and then throw: the validators accepted B and said no to X
const STEPS: { [letter: string]: Step } = {
    P: PASS, S: 'slow', N: NO, R: 'refused', D: 'denied', L: 'lost', H: 'hang',
    B: PASS_THROWS, X: NO_THROWS
};
const stepsOf = (letters: string): Step[] => letters.split(' ').map(letter => STEPS[letter]);

// Whether the node is up after each of these checks ended, U for up and d for down. The
// first check is the one of connect(), so it may not hang. `block` is the healthCheck block
const upAfterEach = async (block: any, letters: string): Promise<string> => {
    const steps = stepsOf(letters);
    const node = fakeNode([...steps]);
    await start({ healthCheck: block });
    const seen = [valid()];
    for (const step of steps.slice(1)) {
        await nextCheck(node);
        // a check that hangs ends at its timeout, a slow one when its answer comes
        if (step === 'hang') await pass(block.timeout || block.interval || 5000);
        if (step === 'slow') await pass(SLOW);
        seen.push(valid());
    }
    expect(node.asked).toHaveLength(steps.length);
    return seen.map(isUp => (isUp ? 'U' : 'd')).join(' ');
};

beforeEach(() => {
    jest.useFakeTimers();
    Object.values(logger).forEach(log => log.mockClear());
    nodes = {};
    (mysql.createPool as jest.Mock)
        .mockImplementation((options: any) => nodes[options.host].mysqlPool);
});

afterEach(async () => {
    await cluster?.disconnect();
    cluster = undefined;
    jest.useRealTimers();
});

describe('health check with a healthCheck block: the wait before the next check', () => {
    // What each check ends with, and the wait until the next check, in ms: always the
    // interval, whatever the check ended with and whatever the legacy keys say
    type Run = [Step, number][];
    const all = (letters: string, wait: number): Run => {
        return stepsOf(letters).map((step): [Step, number] => [step, wait]);
    };
    it.each<[string, object, Run]>([
        ['an empty block, a run of passes', { healthCheck: {} }, all('P P P P', 5000)],
        ['an empty block, a run of failures', { healthCheck: {} }, all('R R R R R', 5000)],
        ['an empty block, a node that fails and comes back',
            { healthCheck: {} }, all('P R D L N P P', 5000)],
        ['interval 2000', { healthCheck: { interval: 2000 } }, all('P R R N P', 2000)],
        // without the block: 15000 after a pass, 60000 after a failure
        ['an empty block next to the legacy values of a consumer',
            { ...CONSUMER, healthCheck: {} }, all('P P R R P', 5000)],
        // without the block: 6000 after the first pass, then 12000, then down to 3000
        ['interval 3000 next to a legacy range of 3000 to 12000 and multiplier 2',
            { timerCheckRange: { start: 3000, end: 12000 }, timerCheckMultiplier: 2,
                healthCheck: { interval: 3000 } },
            all('P P R R P', 3000)]
    ])('%s', async (_name, pool, run) => {
        const node = fakeNode(run.map(([step]) => step));
        await start(pool);

        await pass(run.reduce((sum, [, wait]) => sum + wait, 0));

        expect(waits(node)).toEqual(run.map(([, wait]) => wait));
    });

    // the time from one request to the next is the time the check took plus the interval
    it.each<[string, object, string, number[]]>([
        ['a check that hangs for its timeout of 5000', {}, 'P H H P', [5000, 10000, 10000]],
        ['a check that hangs for its timeout of 1000',
            { interval: 3000, timeout: 1000 }, 'P H H P', [3000, 4000, 4000]],
        ['a check answered after 1200 ms', {}, 'P S S P', [5000, 6200, 6200]]
    ])('is counted from the end of %s', async (_name, block, letters, wanted) => {
        const node = fakeNode(stepsOf(letters));
        await start({ healthCheck: block });

        await pass(wanted.reduce((sum, wait) => sum + wait, 0));

        expect(waits(node)).toEqual(wanted);
    });
});

describe('health check with a healthCheck block: the timeout of one check', () => {
    // healthCheck.timeout, and the interval of the node when it is left out. queryTimeout
    // and the legacy range have no part in it
    describe.each<[string, object, number]>([
        ['an empty block', { healthCheck: {} }, 5000],
        ['interval 2000', { healthCheck: { interval: 2000 } }, 2000],
        ['timeout 1500', { healthCheck: { timeout: 1500 } }, 1500],
        ['a timeout above its interval', { healthCheck: { interval: 2000, timeout: 8000 } }, 8000],
        // without the block: 3000
        ['an empty block, queryTimeout 3000', { queryTimeout: 3000, healthCheck: {} }, 5000],
        ['an empty block, queryTimeout 0', { queryTimeout: 0, healthCheck: {} }, 5000],
        // without the block: 15000
        ['an empty block next to the legacy values of a consumer',
            { ...CONSUMER, healthCheck: {} }, 5000]
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

describe('health check with a healthCheck block: when a node goes down', () => {
    it.each<[string, object, string, string]>([
        ['the default fall is 2: one failed check leaves the node up', {}, 'P R', 'U U'],
        ['the default fall is 2: the second in a row takes it down', {}, 'P R R', 'U U d'],
        ['a refused login counts like any other failure', {}, 'P D D', 'U U d'],
        ['a lost connection counts like any other failure', {}, 'P L L', 'U U d'],
        ['a check that hangs counts like any other failure', {}, 'P H H', 'U U d'],
        ['failures of different kinds make one run', {}, 'P L H', 'U U d'],
        ['fall 1: the first failed check takes it down', { fall: 1 }, 'P R', 'U d'],
        ['fall 3: two failed checks leave it up', { fall: 3 }, 'P R R', 'U U U'],
        ['fall 3: the third in a row takes it down', { fall: 3 }, 'P R R R', 'U U U d'],
        ['a pass resets the run of failures', {}, 'P R P R', 'U U U U'],
        ['two failures in a row after that pass take it down', {}, 'P R P R R', 'U U U U d'],
        ['fall 3: a slow pass resets the run too', { fall: 3 }, 'P R R S R R', 'U U U U U U'],
        ['fall 3: three in a row after a pass', { fall: 3 }, 'P R R P R R R', 'U U U U U U d'],
        ['a validator that says no takes it down with one check', { fall: 3 }, 'P N', 'U d'],
        ['a failed check after that leaves it down', { fall: 3 }, 'P N R', 'U d d']
    ])('%s', async (_name, block, letters, wanted) => {
        expect(await upAfterEach(block, letters)).toBe(wanted);
    });
});

describe('health check with a healthCheck block: when a node comes back', () => {
    it.each<[string, object, string, string]>([
        ['the default rise is 2: one pass leaves a down node down', {}, 'P R R P', 'U U d d'],
        ['the default rise is 2: the second in a row brings it back',
            {}, 'P R R P P', 'U U d d U'],
        ['rise 1: the first pass brings it back', { rise: 1 }, 'P R R P', 'U U d U'],
        ['rise 3: two passes leave it down', { rise: 3 }, 'P R R P P', 'U U d d d'],
        ['rise 3: the third in a row brings it back', { rise: 3 }, 'P R R P P P', 'U U d d d U'],
        ['a failed check resets the run of passes', {}, 'P R R P R P', 'U U d d d d'],
        ['two passes in a row after that failure bring it back',
            {}, 'P R R P R P P', 'U U d d d d U'],
        ['rise 3: a failed check after two passes',
            { rise: 3 }, 'P R R P P H P P', 'U U d d d d d d'],
        ['a validator that says no resets the run of passes', {}, 'P R R P N P', 'U U d d d d'],
        ['two passes in a row after that no bring it back',
            {}, 'P R R P N P P', 'U U d d d d U'],
        ['a node a validator took down needs rise passes too', {}, 'P N P', 'U d d'],
        ['and is back with the second of them', {}, 'P N P P', 'U d d U'],
        ['rise 1: one pass after a validator said no', { rise: 1 }, 'P N P', 'U d U'],
        ['rise 3: three passes after a validator said no', { rise: 3 }, 'P N P P P', 'U d d d U'],
        ['the passes of a node that is up do not count later', {}, 'P P P R R P', 'U U U U d d'],
        ['a node that came back starts a new run of failures', {}, 'P R R P P R', 'U U d d U U'],
        ['and goes down again at fall', {}, 'P R R P P R R', 'U U d d U U d']
    ])('%s', async (_name, block, letters, wanted) => {
        expect(await upAfterEach(block, letters)).toBe(wanted);
    });
});

describe('health check with a healthCheck block: a check that throws after its answer', () => {
    // The check is answered, the validators say yes or no, and then the load factors throw.
    // It is a failed check with an empty checkError. A pass it held is dropped, a no holds.
    // The legacy check leaves a node valid after the first row: see the suite of that check
    it.each<[string, object, string, string]>([
        ['cannot bring back a node a validator took down, though rise is 1',
            { rise: 1 }, 'P N B', 'U d d'],
        ['is no pass in a run of passes, and ends the run', {}, 'P R R P B P', 'U U d d d d'],
        ['counts toward fall like any failed check', {}, 'P B B', 'U U d'],
        ['is not the first pass since connect()', { rise: 3 }, 'B P', 'd U']
    ])('one the validators accepted %s', async (_name, block, letters, wanted) => {
        expect(await upAfterEach(block, letters)).toBe(wanted);
    });

    it('one a validator said no to takes the node down at once, whatever fall is', async () => {
        expect(await upAfterEach({ fall: 3 }, 'P X')).toBe('U d');

        expect(info().checkError).toEqual({});
    });

    it('one the validators accepted has the empty error of a check that threw', async () => {
        expect(await upAfterEach({}, 'P B')).toBe('U U');

        expect(info().checkError).toEqual({});
    });
});

describe('health check with a healthCheck block: the first pass after connect()', () => {
    // rise is 3 in every row. The first check that passes after connect() brings the node up
    // by itself, whenever it comes. After that the node needs `rise` passes like any other
    const block = { rise: 3 };
    it.each<[string, string, string]>([
        ['the check of connect() passes', 'P', 'U'],
        ['the check of connect() fails and the next one passes', 'R P', 'd U'],
        ['three checks fail before the first pass', 'R R R P', 'd d d U'],
        ['a validator says no before the first pass', 'N P', 'd U'],
        ['a node that passed once and went down needs rise passes', 'P R R P P', 'U U d d d'],
        ['also when its first pass came late', 'R P R R P P', 'd U U d d d'],
        ['and is back with the third of them', 'R P R R P P P', 'd U U d d d U']
    ])('%s', async (_name, letters, wanted) => {
        expect(await upAfterEach(block, letters)).toBe(wanted);
    });

    // the node after these checks, a disconnect() and a new connect() whose check ends as
    // the next letter says
    const reconnected = async (before: string, after: string): Promise<FakeNode> => {
        const node = fakeNode(stepsOf(before + ' ' + after));
        await start({ healthCheck: block });
        for (let i = 1; i < stepsOf(before).length; i++) await nextCheck(node);
        await cluster.disconnect();
        await connect();
        return node;
    };

    it('a node that was down is up with the one pass of a new connect()', async () => {
        await reconnected('P R R P', 'P');

        expect(valid()).toBe(true);
    });

    it('is up with the first pass also when the check of the new connect() failed', async () => {
        const node = await reconnected('P R R', 'R P');
        expect(valid()).toBe(false);

        await nextCheck(node);

        expect(valid()).toBe(true);
    });

    it('a failed check from before the disconnect() does not count after it', async () => {
        // one failed check, then the new connect(): its check fails too, the first of two
        const node = await reconnected('P R', 'R R');
        expect(valid()).toBe(true);

        await nextCheck(node);

        expect(valid()).toBe(false);
    });

    it('a pass still out at the disconnect() does not count after the new connect()', async () => {
        const node = fakeNode([PASS, 'refused', 'refused', 'held', 'refused', PASS]);
        await start({ healthCheck: block });
        for (let i = 0; i < 3; i++) await nextCheck(node);
        await cluster.disconnect();
        // the check of the new connect() is refused, then the old check gets its pass
        await connect();
        node.held[0](null, PASS);
        await pass(0);
        expect(valid()).toBe(false);

        // the first pass of the new connect(), not the second of three
        await nextCheck(node);

        expect(valid()).toBe(true);
    });

    it('needs rise passes again once it passed after the new connect()', async () => {
        const node = await reconnected('P R R', 'P R R P P');
        const seen = [valid()];
        for (let i = 0; i < 4; i++) {
            await nextCheck(node);
            seen.push(valid());
        }

        expect(seen).toEqual([true, true, false, false, false]);
    });
});

describe('health check with a healthCheck block: the log of a change of state', () => {
    // every line a node logs about its state, in order: the level and the fields of the
    // record, never its wording
    const changes = (): any[] => {
        const lines: { at: number, line: any[] }[] = [];
        (['info', 'warn'] as const).forEach(level => {
            logger[level].mock.calls.forEach(([, meta], index) => {
                const at = logger[level].mock.invocationCallOrder[index];
                if (meta && meta.reason) lines.push({ at, line: [level, meta] });
            });
        });
        return lines.sort((a, b) => a.at - b.at).map(({ line }) => line);
    };
    const pool = 'node-a:3306';
    const up1 = ['info', { pool, valid: true, reason: 'first_pass' }];
    const upRise = ['info', { pool, valid: true, reason: 'rise' }];
    const downFall = ['warn', { pool, valid: false, reason: 'fall' }];
    const downNo = ['warn', { pool, valid: false, reason: 'validator' }];

    it.each<[string, object, string, any[]]>([
        ['down by failed checks and back: one line per change, none for the checks between',
            {}, 'P R R R P P P', [up1, downFall, upRise]],
        ['down by a validator and back', {}, 'P N N P P', [up1, downNo, upRise]],
        ['fall 1 and rise 1',
            { fall: 1, rise: 1 }, 'P R P R P', [up1, downFall, upRise, downFall, upRise]],
        ['a node that starts down logs its first pass and no fall', {}, 'R R R P', [up1]],
        ['a node that stays up logs nothing more', {}, 'P R P R P', [up1]],
        ['a no that then throws is one line, the one of the validator',
            { fall: 1 }, 'P X', [up1, downNo]]
    ])('%s', async (_name, block, letters, wanted) => {
        await upAfterEach(block, letters);

        expect(changes()).toEqual(wanted);
    });

    it('a node without the block logs no such line, whatever its state does', async () => {
        const steps = stepsOf('P R R P N P');
        const node = fakeNode([...steps]);
        await start({});
        for (let i = 1; i < steps.length; i++) await nextCheck(node);

        expect(node.asked).toHaveLength(steps.length);
        expect(changes()).toEqual([]);
    });

    it('the debug line of a check says what the check found, not the node state', async () => {
        const steps = stepsOf('P R R P N');
        const node = fakeNode([...steps]);
        const settings = { ...settingsOf({ healthCheck: {} }), logs: { level: 'debug' } };
        cluster = createPoolCluster(settings);
        await connect();
        for (let i = 1; i < steps.length; i++) await nextCheck(node);

        // one line per answered check. The second pass is the one of a node that is down
        const found = logger.debug.mock.calls.map(([, meta]) => meta)
            .filter(meta => meta && 'passed' in meta);
        expect(found).toEqual([
            { pool, passed: true }, { pool, passed: true }, { pool, passed: false }
        ]);
    });
});

describe('health check with a healthCheck block: the two legacy keys', () => {
    // the one warn of a node: its fields, never its wording
    const ignoredWarnings = () => logger.warn.mock.calls
        .map(([, meta]) => meta)
        .filter(meta => meta && meta.ignored);
    const range = { start: 15000, end: 60000 };

    it.each<[string, object, string[]]>([
        ['timerCheckRange', { timerCheckRange: range }, ['timerCheckRange']],
        ['half of timerCheckRange', { timerCheckRange: { end: 60000 } }, ['timerCheckRange']],
        ['timerCheckMultiplier', { timerCheckMultiplier: 0.1 }, ['timerCheckMultiplier']],
        ['both', CONSUMER, ['timerCheckRange', 'timerCheckMultiplier']]
    ])('an app that wrote %s next to the block gets one warn per node', async (_n, old, keys) => {
        fakeNode([PASS], 'node-a');
        fakeNode([PASS], 'node-b');
        await start({ ...old, healthCheck: {} }, [{ host: 'node-a' }, { host: 'node-b' }]);

        expect(ignoredWarnings()).toEqual([
            { pool: 'node-a:3306', ignored: keys },
            { pool: 'node-b:3306', ignored: keys }
        ]);
    });

    it('the warn comes once: not again with a check, a disconnect() or a connect()', async () => {
        const node = fakeNode([PASS, 'refused', PASS]);
        await start({ ...CONSUMER, healthCheck: {} });
        await nextCheck(node);
        await nextCheck(node);
        await cluster.disconnect();
        await connect();

        expect(ignoredWarnings()).toHaveLength(1);
    });

    it('an app that wrote neither gets no warn: schema defaults do not count', async () => {
        fakeNode([PASS]);
        await start({ healthCheck: {} });

        expect(config.current.hosts[0].timerCheckRange).toEqual({ start: 5000, end: 15000 });
        expect(config.current.hosts[0].timerCheckMultiplier).toBe(1.3);
        expect(ignoredWarnings()).toEqual([]);
    });

    it.each<[string, object, object]>([
        ['the default settings', {}, {}],
        ['legacy values in the default pool settings', CONSUMER, {}],
        ['legacy values on the host as well', CONSUMER, { timerCheckMultiplier: 0.2 }]
    ])('a node without the block gets no such warn: %s', async (_name, pool, onHost) => {
        fakeNode([PASS]);
        await start(pool, [{ host: 'node-a', ...onHost }]);

        expect(ignoredWarnings()).toEqual([]);
    });

    it.each<[string, object, object[]]>([
        ['a key the app wrote on that host', {},
            [{ host: 'node-a' }, { host: 'node-b', healthCheck: {}, timerCheckMultiplier: 2 }]],
        ['a key the app wrote in the default pool settings', { timerCheckMultiplier: 2 },
            [{ host: 'node-a' }, { host: 'node-b', healthCheck: {} }]]
    ])('a host that has the block alone is warned about %s', async (_name, pool, hosts) => {
        fakeNode([PASS], 'node-a');
        fakeNode([PASS], 'node-b');
        await start(pool, hosts);

        expect(ignoredWarnings()).toEqual([
            { pool: 'node-b:3306', ignored: ['timerCheckMultiplier'] }
        ]);
    });

    it('a legacy key set to undefined was not written', async () => {
        fakeNode([PASS]);
        const host = {
            host: 'node-a', healthCheck: {}, timerCheckRange: undefined as any,
            timerCheckMultiplier: undefined as any
        };
        await start({ timerCheckRange: undefined, timerCheckMultiplier: undefined }, [host]);

        expect(ignoredWarnings()).toEqual([]);
    });

    it('a host with the block and one without each follow their own rules', async () => {
        const a = fakeNode([PASS, PASS, 'refused'], 'node-a');
        const b = fakeNode([PASS, PASS, 'refused'], 'node-b');
        await start({}, [{ host: 'node-a' }, { host: 'node-b', healthCheck: {} }]);

        await pass(39538);

        // node-a: 10000 * 1.3, held at 15000, then 15000 / 1.3
        expect(waits(a)).toEqual([13000, 15000, 11538]);
        expect(waits(b)).toEqual([5000, 5000, 5000, 5000, 5000, 5000, 5000]);
        expect([a.timeouts[0], b.timeouts[0]]).toEqual([15000, 5000]);
    });

    it('in one cluster the host without the block is back with one pass', async () => {
        const hosts = [{ host: 'node-a' }, { host: 'node-b', healthCheck: {} }];
        // both go down by two failed checks and pass once. node-b then hangs for good
        const a = fakeNode([PASS, 'refused', 'refused', PASS], 'node-a');
        fakeNode([PASS, 'refused', 'refused', PASS, 'hang'], 'node-b');
        await start({}, hosts);
        await pass(23000);
        expect([valid(0), valid(1)]).toEqual([false, false]);

        // the pass of node-a is its fourth request, after 13000, 10000 and 7692 ms
        await pass(7692);

        expect(a.asked).toHaveLength(4);
        expect([valid(0), valid(1)]).toEqual([true, false]);
    });
});

describe('health check with a healthCheck block: the settings', () => {
    const blocks = () => config.current.hosts.map(host => host.healthCheck);
    const twoHosts = (b: object = {}) => [{ host: 'node-a' }, { host: 'node-b', ...b }];

    it('an empty block in the default pool settings gives every host the defaults', () => {
        createPoolCluster(settingsOf({ healthCheck: {} }, twoHosts()));

        expect(blocks()).toEqual([DEFAULT_BLOCK, DEFAULT_BLOCK]);
    });

    it('an empty block on one host gives that host the defaults and the other no block', () => {
        createPoolCluster(settingsOf({}, twoHosts({ healthCheck: {} })));

        expect(blocks()).toEqual([undefined, DEFAULT_BLOCK]);
        expect('healthCheck' in config.current.hosts[0]).toBe(false);
    });

    it('all six keys are accepted, in the default pool settings and on a host', () => {
        const written = {
            interval: 2000, timeout: 8000, fall: 1, rise: 5, authRetryInterval: 30000,
            passive: false
        };
        const onHost = { healthCheck: written };
        createPoolCluster(settingsOf({ healthCheck: written }, twoHosts(onHost)));

        expect(blocks()).toEqual([written, written]);
    });

    it('a host overrides single keys of the default block and keeps the rest', () => {
        const pool = { healthCheck: { interval: 2000, fall: 3, rise: 4 } };
        createPoolCluster(settingsOf(pool, twoHosts({ healthCheck: { fall: 1 } })));

        const shared = { ...DEFAULT_BLOCK, interval: 2000, timeout: 2000, rise: 4 };
        expect(blocks()).toEqual([{ ...shared, fall: 3 }, { ...shared, fall: 1 }]);
    });

    // the block of the default pool settings, the block of the host, the timeout of the host
    it.each<[string, object | undefined, object | undefined, number]>([
        ['is the default interval when nothing is written', {}, {}, 5000],
        ['is the interval of the default block', { interval: 2000 }, undefined, 2000],
        ['is the interval of the host when the host has its own',
            { interval: 2000 }, { interval: 7000 }, 7000],
        ['is the interval of a host that alone has a block', undefined, { interval: 300 }, 300],
        ['is the one written in the default block, whatever the interval of the host',
            { interval: 2000, timeout: 1500 }, { interval: 7000 }, 1500],
        ['is the one written on the host first', { timeout: 1500 }, { timeout: 900 }, 900]
    ])('timeout %s', (_name, onDefaults, onHost, timeout) => {
        const hosts = [{ host: 'node-a', ...(onHost ? { healthCheck: onHost } : {}) }];
        createPoolCluster(settingsOf(onDefaults ? { healthCheck: onDefaults } : {}, hosts));

        expect(blocks()[0].timeout).toBe(timeout);
    });

    it('a block set to undefined counts as left out, in both places', () => {
        const hosts = [{ host: 'node-a', healthCheck: undefined as any }];
        createPoolCluster(settingsOf({ healthCheck: undefined }, hosts));

        expect('healthCheck' in config.current.hosts[0]).toBe(false);
        expect('healthCheck' in config.current.defaultPoolSettings).toBe(false);
    });

    it('a key set to undefined counts as left out, in both places', () => {
        const pool = { healthCheck: { interval: 2000, fall: undefined as any } };
        const onHost = { healthCheck: { interval: undefined as any, rise: undefined as any } };
        createPoolCluster(settingsOf(pool, [{ host: 'node-a', ...onHost }]));

        expect(blocks()).toEqual([{ ...DEFAULT_BLOCK, interval: 2000, timeout: 2000 }]);
    });

    it('the block of the default pool settings is kept as the app wrote it', () => {
        createPoolCluster(settingsOf({ healthCheck: { interval: 2000 } }, twoHosts()));

        expect(config.current.defaultPoolSettings.healthCheck).toEqual({ interval: 2000 });
    });

    it('every host gets a block of its own', () => {
        createPoolCluster(settingsOf({ healthCheck: { interval: 2000 } }, twoHosts()));
        const [first, second] = config.current.hosts;

        first.healthCheck.interval = 1;

        expect(second.healthCheck.interval).toBe(2000);
        expect(config.current.defaultPoolSettings.healthCheck.interval).toBe(2000);
    });

    it('the overrides of a host reach its checks, and only its own', async () => {
        const a = fakeNode([PASS, PASS, PASS, 'refused'], 'node-a');
        const b = fakeNode([PASS, 'refused'], 'node-b');
        const onHost = { healthCheck: { interval: 7000, fall: 1 } };
        await start({ healthCheck: { interval: 2000 } }, twoHosts(onHost));

        await pass(7000);

        expect(waits(a)).toEqual([2000, 2000, 2000]);
        expect(waits(b)).toEqual([7000]);
        expect([a.timeouts[0], b.timeouts[0]]).toEqual([2000, 7000]);
        // the last check of each failed, the ones before passed: fall 2 and fall 1
        expect([valid(0), valid(1)]).toEqual([true, false]);
    });
});

describe('health check with a healthCheck block: settings the schema refuses', () => {
    const errorLines = (settings: object): string[] => {
        try {
            createPoolCluster(settings as any);
        } catch (e) {
            return e.message.split('\n');
        }
        return [];
    };
    // the settings with this block in one of the two places, and the path of that place
    const places: [string, (block: any) => object, string][] = [
        ['the default pool settings', block => settingsOf({ healthCheck: block }),
            'defaultPoolSettings.healthCheck'],
        ['a host', block => settingsOf({}, [{ host: 'node-a', healthCheck: block }]),
            'hosts[0].healthCheck']
    ];

    describe.each(places)('in %s', (_place, settingsWith, at) => {
        // the block, and the path of the one problem below the block
        it.each<[string, any, string]>([
            ['a key the block does not have', { bogus: 1 }, ''],
            ['a legacy key inside the block', { timerCheckMultiplier: 2 }, ''],
            ['a block that is null', null, ''],
            ['a block that is true', true, ''],
            ['a block that is an array', [], ''],
            ['interval 0', { interval: 0 }, '.interval'],
            ['an interval below one ms', { interval: 0.5 }, '.interval'],
            ['an interval of 99 ms', { interval: 99 }, '.interval'],
            ['a negative interval', { interval: -1 }, '.interval'],
            ['an interval that is a string', { interval: '5000' }, '.interval'],
            ['an interval that is NaN', { interval: NaN }, '.interval'],
            ['an interval that is Infinity', { interval: Infinity }, '.interval'],
            ['an interval that is null', { interval: null }, '.interval'],
            ['an interval above the longest timer of Node', { interval: 2147483648 }, '.interval'],
            ['timeout 0', { timeout: 0 }, '.timeout'],
            ['a timeout below one ms', { timeout: 0.5 }, '.timeout'],
            ['a timeout that is a string', { timeout: '1s' }, '.timeout'],
            ['a timeout above the longest timer of Node', { timeout: 2147483648 }, '.timeout'],
            ['fall 0', { fall: 0 }, '.fall'],
            ['a negative fall', { fall: -2 }, '.fall'],
            ['a fall that is no integer', { fall: 1.5 }, '.fall'],
            ['a fall that is a string', { fall: '2' }, '.fall'],
            ['rise 0', { rise: 0 }, '.rise'],
            ['a rise that is no integer', { rise: 2.5 }, '.rise'],
            ['a rise that is Infinity', { rise: Infinity }, '.rise'],
            ['authRetryInterval 0', { authRetryInterval: 0 }, '.authRetryInterval'],
            ['an authRetryInterval of 99 ms', { authRetryInterval: 99 }, '.authRetryInterval'],
            ['a passive that is a string', { passive: 'yes' }, '.passive'],
            ['a passive that is a number', { passive: 1 }, '.passive']
        ])('%s is one problem, named by its path', (_name, block, below) => {
            const lines = errorLines(settingsWith(block));

            expect(lines[0]).toBe('Invalid mysql-dynamic-cluster settings:');
            expect(lines.filter(line => line.startsWith('✖'))).toHaveLength(1);
            expect(lines).toContain(`  → at ${at}${below}`);
        });

        it.each<[string, any]>([
            ['the longest timer of Node as interval and timeout',
                { interval: 2147483647, timeout: 2147483647 }],
            ['the shortest of each: interval 100, timeout 1, authRetryInterval 100',
                { interval: 100, timeout: 1, authRetryInterval: 100 }],
            ['an interval with a fraction', { interval: 100.5 }],
            ['fall 1 and rise 1', { fall: 1, rise: 1 }],
            ['a timeout above the interval', { interval: 1000, timeout: 30000 }]
        ])('%s is accepted', (_name, block) => {
            expect(errorLines(settingsWith(block))).toEqual([]);
        });
    });

    it('two wrong keys are two problems in one error', () => {
        const lines = errorLines(settingsOf({ healthCheck: { fall: 0, rise: 'x' } }));

        expect(lines.filter(line => line.startsWith('✖'))).toHaveLength(2);
        expect(lines).toContain('  → at defaultPoolSettings.healthCheck.fall');
        expect(lines).toContain('  → at defaultPoolSettings.healthCheck.rise');
    });
});

// A node that passed three checks and stops right after the last of them: from here on
// every request ends as `how` says
const dying = async (pool: object, how: Step): Promise<FakeNode> => {
    const node = fakeNode([PASS, PASS, PASS, how]);
    await start(pool);
    await nextCheck(node);
    await nextCheck(node);
    return node;
};

// isValid is `before` until 1 ms ahead of `total` ms from now, and the opposite at `total`
const flipsAt = async (total: number, before: boolean) => {
    await pass(total - 1);
    expect(valid()).toBe(before);
    await pass(1);
    expect(valid()).toBe(!before);
};

describe('health check with a healthCheck block: the time to leave rotation', () => {
    // from the moment the node stops until it is out, at the `fall`th failed check. The node
    // stops right after a check that passed, which is the longest it can take
    it.each<[string, object, Step, number]>([
        // wait 5000, fail, wait 5000, fail
        ['the defaults, connections refused: 10000 ms', { healthCheck: {} }, 'refused', 10000],
        // wait 5000, hang 5000, wait 5000, hang 5000
        ['the defaults, checks that hang: 20000 ms', { healthCheck: {} }, 'hang', 20000],
        // wait 5000, fail
        ['fall 1, connections refused: 5000 ms', { healthCheck: { fall: 1 } }, 'refused', 5000],
        // three times: wait 2000, hang 1000
        ['interval 2000, timeout 1000 and fall 3, checks that hang: 9000 ms',
            { healthCheck: { interval: 2000, timeout: 1000, fall: 3 } }, 'hang', 9000],
        // wait 15000, fail, wait 15000, fail
        ['interval 15000, connections refused: 30000 ms',
            { healthCheck: { interval: 15000 } }, 'refused', 30000],
        // wait 15000, hang 15000, wait 15000, hang 15000
        ['interval 15000, checks that hang: 60000 ms',
            { healthCheck: { interval: 15000 } }, 'hang', 60000],
        // the legacy values next to the block change nothing. Without the block: 75000
        ['the defaults next to the legacy values of a consumer, connections refused: 10000 ms',
            { ...CONSUMER, healthCheck: {} }, 'refused', 10000],
        // without the block: 105000
        ['the defaults next to the legacy values of a consumer, checks that hang: 20000 ms',
            { ...CONSUMER, healthCheck: {} }, 'hang', 20000]
    ])('%s', async (_name, pool, how, total) => {
        await dying(pool, how);

        await flipsAt(total, true);
    });

    it('the defaults, a node that stops 1 ms before its check is due: 5001 ms', async () => {
        const node = await dying({ healthCheck: {} }, PASS);
        await pass(4999);
        node.plan = ['refused'];

        // fail after 1 ms, wait 5000, fail
        await flipsAt(5001, true);
    });
});

describe('health check with a healthCheck block: the time a node takes to come back', () => {
    // A node that is down, with its last check just failed. From here on it answers
    const returning = async (pool: object, downBy: string): Promise<FakeNode> => {
        const steps = stepsOf(downBy);
        const node = fakeNode([...steps]);
        await start(pool);
        for (let i = 1; i < steps.length; i++) await nextCheck(node);
        expect(valid()).toBe(false);
        node.plan = [PASS];
        return node;
    };

    // from the moment the node answers again until it is up, at the `rise`th pass. The node
    // returns right after a failed check, which is the longest it can take
    it.each<[string, object, number]>([
        // wait 5000, pass, wait 5000, pass
        ['the defaults: 10000 ms', {}, 10000],
        // wait 5000, pass
        ['rise 1: 5000 ms', { rise: 1 }, 5000],
        // three times: wait 2000, pass
        ['interval 2000 and rise 3: 6000 ms', { interval: 2000, rise: 3 }, 6000]
    ])('%s', async (_name, block, total) => {
        await returning({ healthCheck: block }, 'P R R');

        await flipsAt(total, false);
    });

    it('the defaults, a node that returns while a check hangs: 15000 ms', async () => {
        // down by two checks that hung. The third one just started and hangs too
        await returning({ healthCheck: {} }, 'P H H H');

        // hang 5000, wait 5000, pass, wait 5000, pass
        await flipsAt(15000, false);
    });

    // The legacy check for the same two cases, for the table in the docs: one answered
    // check brings the node back, after the wait its failures left it with
    it.each<[string, object, string, number]>([
        // after five failures in a row the wait is 5000
        ['the legacy defaults, a node down for a while: 5000 ms', {}, 'P R R R R R', 5000],
        // hang 15000, wait 5000
        ['the legacy defaults, returning while a check hangs: 20000 ms',
            {}, 'P H H H H H H', 20000],
        // one failure sets the wait to 60000
        ['the legacy values of a consumer: 60000 ms', CONSUMER, 'P R R', 60000],
        // hang 15000, wait 60000
        ['the legacy values of a consumer, returning while a check hangs: 75000 ms',
            CONSUMER, 'P H H H', 75000]
    ])('%s', async (_name, pool, downBy, total) => {
        await returning(pool, downBy);

        await flipsAt(total, false);
    });
});

describe('health check with a healthCheck block: what stays as it was', () => {
    // an SDK of the app that is read on demand and sets no timer
    class Reader extends MetricReader {
        protected onForceFlush(): Promise<void> { return Promise.resolve(); }
        protected onShutdown(): Promise<void> { return Promise.resolve(); }
    }
    let provider: MeterProvider;
    let reader: Reader;

    const HEALTH = 'mysql_dynamic_cluster.health_check.duration';
    const RESULT = 'mysql_dynamic_cluster.health_check.result';
    // the points of every metric, by its name
    const collect = async (): Promise<{ [name: string]: any[] }> => {
        const points: { [name: string]: any[] } = {};
        const { resourceMetrics } = await reader.collect();
        for (const scope of resourceMetrics.scopeMetrics) {
            for (const metric of scope.metrics) points[metric.descriptor.name] = metric.dataPoints;
        }
        return points;
    };
    // what the app reads of the node: the checks by their result, and the two gauges
    const read = async () => {
        const points = await collect();
        const checks: { [result: string]: number } = {};
        for (const point of points[HEALTH] || []) {
            checks[point.attributes[RESULT]] = point.value.count;
        }
        return {
            checks,
            valid: points['mysql_dynamic_cluster.node.valid'][0].value,
            loadScore: points['mysql_dynamic_cluster.node.load_score'][0].value
        };
    };

    beforeEach(() => {
        reader = new Reader();
        provider = new MeterProvider({ readers: [reader] });
        metrics.setGlobalMeterProvider(provider);
    });

    afterEach(async () => {
        await provider.shutdown();
        metrics.disable();
    });

    it('a pass of a node that is still down is a valid check, the node is not valid', async () => {
        // down after the third check. The fourth passes with 9 connections: one pass of two
        expect(await upAfterEach({}, 'P R R')).toBe('U U d');
        nodes['node-a'].plan = [up(9)];
        await nextCheck(nodes['node-a']);

        const wanted = { checks: { valid: 2, error: 2 }, valid: 0, loadScore: 23 };
        expect(await read()).toEqual(wanted);
    });

    it('the second pass in a row is one more valid check, and the node is valid', async () => {
        expect(await upAfterEach({}, 'P R R P P')).toBe('U U d d U');

        const wanted = { checks: { valid: 3, error: 2 }, valid: 1, loadScore: 19 };
        expect(await read()).toEqual(wanted);
    });

    it('a validator that says no is an invalid check, and the node is not valid', async () => {
        expect(await upAfterEach({}, 'P N')).toBe('U d');

        const wanted = { checks: { valid: 1, invalid: 1 }, valid: 0, loadScore: 19 };
        expect(await read()).toEqual(wanted);
    });

    it('nodes() tells of a node as before: state, score, error of the last check', async () => {
        const node = fakeNode([up(7), 'refused', 'refused', up(9), up(11)]);
        await start({ healthCheck: {} });
        const seen = [info()];
        for (let i = 0; i < 4; i++) {
            await nextCheck(node);
            seen.push(info());
        }

        const base = { id: 0, name: 'node-a:3306', host: 'node-a', port: 3306 };
        const refused = { code: 'ECONNREFUSED', errno: -111 };
        expect(seen).toEqual([
            { ...base, isValid: true, loadScore: 19 },
            { ...base, isValid: true, loadScore: 19, checkError: refused },
            { ...base, isValid: false, loadScore: 19, checkError: refused },
            // an answered check clears the error and sets the score, also of a node that is down
            { ...base, isValid: false, loadScore: 23 },
            { ...base, isValid: true, loadScore: 27 }
        ]);
    });

    it('ready and firstReady resolve with a node that passed the check of connect()', async () => {
        fakeNode([PASS]);
        cluster = createPoolCluster(settingsOf({ healthCheck: { rise: 3 } }));
        const connecting = cluster.connect();

        expect(await cluster.ready).toEqual([{ nodeId: 0, ok: true }]);
        expect(await cluster.firstReady).toEqual([{ nodeId: 0, ok: true }]);
        await expect(connecting).resolves.toBeUndefined();
    });

    it('ready resolves with the error of a node that failed the check of connect()', async () => {
        fakeNode(['denied']);
        cluster = createPoolCluster(settingsOf({ healthCheck: {} }));
        const connecting = cluster.connect();
        connecting.catch((): void => undefined);

        const [result] = await cluster.ready;
        expect(result).toMatchObject({
            nodeId: 0, ok: false,
            checkError: { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }
        });
        expect(result.error).toBeInstanceOf(Error);
        await expect(connecting).rejects.toBe('pool in host node-a is not valid');
    });

    it('pool_check_failed comes with every failed check, also of a down node', async () => {
        const failed: any[] = [];
        const node = fakeNode([PASS, 'refused', 'refused', 'refused', NO, PASS]);
        await start({ healthCheck: {} });
        cluster.on('pool_check_failed', (args: any[]) => failed.push([args[0].code, args[1]]));
        for (let i = 0; i < 5; i++) await nextCheck(node);

        expect(failed).toEqual([['ECONNREFUSED', 0], ['ECONNREFUSED', 0], ['ECONNREFUSED', 0]]);
    });
});
