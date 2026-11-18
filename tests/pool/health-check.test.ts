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
// 'held' hands out one that answers when the test says so, through node.held, and 'waits'
// leaves the request in the queue of mysql2, as a pool at its limit does.
// A ServerError is an error packet of the server, at the place its `at` names
type Step = Rows | 'slow' | 'refused' | 'denied' | 'lost' | 'hang' | 'held' | 'waits'
    | ServerError;
// Where a check can get an error packet: at the login of a new connection, at the change of
// user it sends on an open one, or as the answer to its status query
type Where = 'login' | 'changeUser' | 'query';
type ServerError = { at: Where, error: () => any };
const isServerError = (step: Step): step is ServerError => {
    return typeof step === 'object' && !Array.isArray(step);
};
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

// An error packet as mysql2 hands it out: the errno and the SQL state of the server, and the
// name mysql2 has for that errno as the code. Never fatal as it comes from the parser
const packet = (errno: number, code: string, sqlState: string = 'HY000') => {
    return () => Object.assign(new Error('error ' + errno + ' of the server'),
        { code, errno, sqlState, sqlMessage: 'error ' + errno + ' of the server' });
};
const serverError = (at: Where, error: () => any): ServerError => ({ at, error });

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
            _allConnections: [], _freeConnections: [], _connectionQueue: [] as Cb[],
            getConnection: (cb: Cb) => {
                node.asked.push(Date.now());
                const step = node.plan.length > 1 ? node.plan.shift() : node.plan[0];
                if (step === 'refused' || step === 'denied') return cb(errors[step]());
                if (step === 'waits') return node.mysqlPool._connectionQueue.push(cb);
                const answer = isServerError(step) ? step : undefined;
                if (answer?.at === 'login') return cb(answer.error());
                cb(null, {
                    // mysql2 marks every error of a change of user as fatal, whatever it is
                    changeUser: (_options: any, done: Cb) => {
                        if (answer?.at !== 'changeUser') return done(null);
                        done(Object.assign(answer.error(), { fatal: true }));
                    },
                    query: (options: any, done: Cb) => {
                        node.timeouts.push(options.timeout);
                        if (answer) return done(answer.error());
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
// the time of each request for a connection, counted from the first one
const askedAt = (node: FakeNode): number[] => node.asked.map(at => at - node.asked[0]);

// The values a consumer runs its legacy check with. A node with a healthCheck block
// has to ignore them
const CONSUMER = {
    timerCheckRange: { start: 15000, end: 60000 }, timerCheckMultiplier: 0.1, queryTimeout: 15000
};
// what an empty block stands for
const DEFAULT_BLOCK = {
    interval: 5000, timeout: 5000, fall: 2, rise: 2, authRetryInterval: 60000, passive: true
};

// The errors of the server that refuse the login or the account of a check, by errno, with
// the name mysql2 3.24.6 has for each as the code, and the SQL state
const REFUSALS: [number, string, string][] = [
    [1044, 'ER_DBACCESS_DENIED_ERROR', '42000'],
    [1045, 'ER_ACCESS_DENIED_ERROR', '28000'],
    [1049, 'ER_BAD_DB_ERROR', '42000'],
    [1129, 'ER_HOST_IS_BLOCKED', 'HY000'],
    [1130, 'ER_HOST_NOT_PRIVILEGED', 'HY000'],
    [1862, 'ER_MUST_CHANGE_PASSWORD_LOGIN', 'HY000'],
    [3118, 'ER_ACCOUNT_HAS_BEEN_LOCKED', 'HY000'],
    [3159, 'ER_SECURE_TRANSPORT_REQUIRED', 'HY000'],
    [3955, 'ER_USER_ACCESS_DENIED_FOR_USER_ACCOUNT_BLOCKED_BY_PASSWORD_LOCK', 'HY000'],
    // The two of MariaDB. mysql2 names them by the table of MySQL, where these numbers
    // belong to the bulk loader
    [4150, 'ER_BULK_PARSER_UNEXPECTED_CHAR_AFTER_COLUMN_TERMINATOR', 'HY000'],
    [4151, 'ER_BULK_PARSER_INCOMPLETE_ESCAPE_SEQUENCE', 'HY000']
];
// The three places such an error reaches a check. Only the second one is fatal
const PLACES: [string, Where][] = [
    ['at the login of a new connection', 'login'],
    ['at the change of user on an open connection, where mysql2 marks it fatal', 'changeUser'],
    ['as the answer to the status query', 'query']
];
const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };
const denied = packet(1045, 'ER_ACCESS_DENIED_ERROR', '28000');
const tooMany = packet(1040, 'ER_CON_COUNT_ERROR', '08004');
// 1226 is what a server answers when an account is over a limit per hour, and also while it
// has too many connections open at once, which passes when one of them closes
const overLimit = packet(1226, 'ER_USER_LIMIT_REACHED', '42000');

// What the connect timeout of mysql2 ends a login with: a code, no errno, fatal. No server
// sent it, the helper only puts it at the login
const connectTimeout = () => {
    return Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', fatal: true });
};

// One letter per check. P passes, S passes after SLOW ms, N is answered and the validator
// says no. The rest fail: R connection refused, L connection lost, H hangs, T too many
// connections, U a limit of the account (1226), E the connect timeout of mysql2, M an error
// of the server that mysql2 has no name for, so one with an errno and no code, Z the query
// timeout of mysql2, which has a code and no errno.
// Three are refused by the server: D the login of a new connection with 1045,
// C the change of user on an open one with 1045, Q the status query with 1044.
// B and X are answered and then throw: the validators accepted B and said no to X
const STEPS: { [letter: string]: Step } = {
    P: PASS, S: 'slow', N: NO, R: 'refused', D: 'denied', L: 'lost', H: 'hang',
    T: serverError('login', tooMany),
    U: serverError('login', overLimit),
    E: serverError('login', connectTimeout),
    M: serverError('query', () => Object.assign(new Error('unnamed'), { errno: 1927 })),
    Z: serverError('query', () => Object.assign(new Error('Query inactivity timeout'),
        { code: 'PROTOCOL_SEQUENCE_TIMEOUT' })),
    C: serverError('changeUser', denied),
    Q: serverError('query', packet(1044, 'ER_DBACCESS_DENIED_ERROR', '42000')),
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
    // What each check ends with, and the wait until the next check, in ms: the interval,
    // whatever the legacy keys say, and authRetryInterval after a check the server refused
    type Run = [Step, number][];
    const each = (letters: string, waitList: number[]): Run => {
        return stepsOf(letters).map((step, index): [Step, number] => [step, waitList[index]]);
    };
    const all = (letters: string, wait: number): Run => {
        return stepsOf(letters).map((step): [Step, number] => [step, wait]);
    };
    it.each<[string, object, Run]>([
        ['an empty block, a run of passes', { healthCheck: {} }, all('P P P P', 5000)],
        ['an empty block, a run of failures', { healthCheck: {} }, all('R R R R R', 5000)],
        ['an empty block, a node that fails and comes back: only the refused login waits 60000',
            { healthCheck: {} },
            each('P R D L N P P', [5000, 5000, 60000, 5000, 5000, 5000, 5000])],
        ['an empty block, logins refused from the check of connect() on',
            { healthCheck: {} }, all('D D D', 60000)],
        ['an empty block: the passes after a refusal wait the interval again',
            { healthCheck: {} }, each('P D P P', [5000, 60000, 5000, 5000])],
        ['an empty block, a refusal at each of the three places',
            { healthCheck: {} }, each('P D C Q P', [5000, 60000, 60000, 60000, 5000])],
        ['authRetryInterval 20000',
            { healthCheck: { authRetryInterval: 20000 } },
            each('P D C Q P', [5000, 20000, 20000, 20000, 5000])],
        ['an authRetryInterval below the interval is used as it is written',
            { healthCheck: { interval: 10000, authRetryInterval: 2000 } },
            each('P D D P', [10000, 2000, 2000, 10000])],
        ['authRetryInterval 20000, failures that are no refusal wait the interval',
            { healthCheck: { authRetryInterval: 20000 } }, all('P T R L T H', 5000).slice(0, 5)],
        // without the block: 15000 after a pass, 60000 after a failure
        ['authRetryInterval 30000 next to the legacy values of a consumer',
            { ...CONSUMER, healthCheck: { authRetryInterval: 30000 } },
            each('P D R P', [5000, 30000, 5000, 5000])],
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
        ['too many connections count like any other failure', {}, 'P T T', 'U U d'],
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

describe('health check with a healthCheck block: a login or account refusal', () => {
    describe.each(REFUSALS)('errno %i, %s', (errno, code, sqlState) => {
        // fall is 3: no count of failed checks takes this node down with one check
        it.each(PLACES)('%s takes an up node down with one check', async (_name, at) => {
            const node = fakeNode([PASS, serverError(at, packet(errno, code, sqlState)), 'hang']);
            await start({ healthCheck: { fall: 3 } });
            expect(valid()).toBe(true);

            await nextCheck(node);

            expect([valid(), info().checkError]).toEqual([false, { code, errno, sqlState }]);
        });

        // the check of connect() at 0, the refused one at 5000, the next one `wait` ms
        // later and not 1 ms sooner
        describe.each<[string, object, number]>([
            ['the default authRetryInterval of 60000', {}, 60000],
            ['authRetryInterval 20000', { authRetryInterval: 20000 }, 20000]
        ])('with %s', (_block, block, wait) => {
            it.each(PLACES)(`%s makes the next check wait ${wait} ms`, async (_place, at) => {
                const refusal = serverError(at, packet(errno, code, sqlState));
                const node = fakeNode([PASS, refusal, PASS]);
                await start({ healthCheck: block });

                await pass(5000 + wait - 1);
                const before = node.asked.length;
                await pass(1);

                expect([before, waits(node)]).toEqual([2, [5000, wait]]);
            });
        });
    });

    it('reaches the check as fatal from a change of user only', async () => {
        const seen: any[] = [];
        const node = fakeNode([PASS, ...PLACES.map(([, at]) => serverError(at, denied)), 'hang']);
        await start({ healthCheck: {} });
        cluster.on('pool_check_failed', ([error]: any[]) => seen.push([error.errno, error.fatal]));
        for (let i = 0; i < 3; i++) await nextCheck(node);

        expect(seen).toEqual([[1045, undefined], [1045, true], [1045, undefined]]);
    });

    // Errors that are no refusal: a limit that passes with time, an error of a query, a
    // connection that is gone, and errors that only look like one of the list
    const lostWith2013 = () => Object.assign(errors.lost(), { errno: 2013 });
    const codeOnly = () => Object.assign(new Error('Access denied'), { code: DENIED.code });
    const OTHERS: [string, Step, object][] = [
        ['too many connections, errno 1040, at the login',
            serverError('login', tooMany), { code: 'ER_CON_COUNT_ERROR', errno: 1040 }],
        ['too many connections, errno 1040, at a change of user, so fatal',
            serverError('changeUser', tooMany), { code: 'ER_CON_COUNT_ERROR', errno: 1040 }],
        ['too many connections of the user, errno 1203',
            serverError('login', packet(1203, 'ER_TOO_MANY_USER_CONNECTIONS', '42000')),
            { errno: 1203 }],
        ['a limit of the account, errno 1226, at the login',
            serverError('login', overLimit), { code: 'ER_USER_LIMIT_REACHED', errno: 1226 }],
        ['a limit of the account, errno 1226, at a change of user, so fatal',
            serverError('changeUser', overLimit), { errno: 1226 }],
        ['a limit of the account, errno 1226, as the answer to the status query',
            serverError('query', overLimit), { errno: 1226 }],
        ['a deadlock, errno 1213',
            serverError('query', packet(1213, 'ER_LOCK_DEADLOCK', '40001')), { errno: 1213 }],
        ['a lock wait timeout, errno 1205',
            serverError('query', packet(1205, 'ER_LOCK_WAIT_TIMEOUT')), { errno: 1205 }],
        ['a node that is not ready, errno 1047',
            serverError('query', packet(1047, 'ER_UNKNOWN_COM_ERROR', '08S01')), { errno: 1047 }],
        ['a lost connection with the errno 2013 of the client library',
            serverError('query', lostWith2013), { code: 'PROTOCOL_CONNECTION_LOST', errno: 2013 }],
        ['a lost connection as mysql2 has it, fatal and with no errno',
            'lost', { code: 'PROTOCOL_CONNECTION_LOST' }],
        ['the code of a refused login with no errno',
            serverError('login', codeOnly), { code: 'ER_ACCESS_DENIED_ERROR' }],
        ['the errno of a refused login as a string',
            serverError('login', () => Object.assign(codeOnly(), { errno: '1045' })),
            { code: 'ER_ACCESS_DENIED_ERROR' }],
        ['a refused connection, errno -111', 'refused', { code: 'ECONNREFUSED', errno: -111 }]
    ];
    describe.each(OTHERS)('%s', (_name, step, checkError) => {
        it('leaves an up node up the first time, like any failed check', async () => {
            const node = fakeNode([PASS, step, 'hang']);
            await start({ healthCheck: {} });
            await nextCheck(node);

            expect(info()).toMatchObject({ isValid: true, checkError });
        });

        it('takes it down the second time in a row', async () => {
            const node = fakeNode([PASS, step, step, 'hang']);
            await start({ healthCheck: {} });
            await nextCheck(node);
            await nextCheck(node);

            expect(valid()).toBe(false);
        });

        it('makes the next check wait the interval, not authRetryInterval', async () => {
            const node = fakeNode([PASS, step, step, PASS]);
            await start({ healthCheck: { authRetryInterval: 20000 } });

            await pass(15000);

            expect(waits(node)).toEqual([5000, 5000, 5000]);
        });
    });

    it('an error the app passed to failWaiting() is none, whatever its errno', async () => {
        const node = fakeNode([PASS, 'waits', 'hang']);
        await start({ healthCheck: {} });
        await nextCheck(node);

        expect(cluster.failWaiting(0, Object.assign(new Error('leaving'), DENIED))).toBe(1);
        await pass(0);

        // the check failed with an error the package was handed: nothing of the server
        expect([valid(), info().checkError]).toEqual([true, {}]);
        // and the next check comes after the interval
        await pass(5000);
        expect(waits(node)).toEqual([5000, 5000]);
    });

    it.each<[string, object, string, string]>([
        ['takes an up node down with one check, whatever fall is', { fall: 5 }, 'P D', 'U d'],
        ['does so on an open connection', { fall: 5 }, 'P C', 'U d'],
        ['and as the answer to the status query', { fall: 5 }, 'P Q', 'U d'],
        ['takes the node down after one failed check of another kind', {}, 'P R D', 'U U d'],
        ['leaves a node that is down as it is', {}, 'P R R D', 'U U d d'],
        ['a failed check after it leaves the node down', {}, 'P D R', 'U d d'],
        ['one pass after it leaves the node down: the default rise is 2', {}, 'P D P', 'U d d'],
        ['the second pass in a row brings the node back', {}, 'P D P P', 'U d d U'],
        ['rise 1: one pass brings the node back', { rise: 1 }, 'P D P', 'U d U'],
        ['rise 3: the third pass in a row brings the node back',
            { rise: 3 }, 'P C P P P', 'U d d d U'],
        ['ends a run of passes', { rise: 3 }, 'P R R P P D P P', 'U U d d d d d d'],
        ['and the run starts again after it',
            { rise: 3 }, 'P R R P P D P P P', 'U U d d d d d d U'],
        ['a failed check between the passes after it ends their run',
            {}, 'P D P R P', 'U d d d d'],
        ['a node that came back goes down again with the next one', {}, 'P D P P Q', 'U d d U d'],
        ['the check of connect() is refused: the first pass brings the node up',
            { rise: 3 }, 'D P', 'd U'],
        ['three refused checks from connect() on, then the first pass',
            { rise: 3 }, 'D D D P', 'd d d U'],
        ['one after the first pass does not make the next pass a first pass',
            { rise: 3 }, 'P D P P', 'U d d d']
    ])('a refusal: %s', async (_name, block, letters, wanted) => {
        expect(await upAfterEach(block, letters)).toBe(wanted);
    });

    it('a node without the block needs two of them, also on an open connection', async () => {
        const refusal = serverError('changeUser', denied);
        const node = fakeNode([PASS, refusal, refusal, 'hang']);
        await start({});
        await nextCheck(node);
        const afterOne = valid();
        await nextCheck(node);

        expect([afterOne, valid()]).toEqual([true, false]);
    });

    it('in one cluster only the host with the block goes down with one', async () => {
        const hosts = [{ host: 'node-a' }, { host: 'node-b', healthCheck: { fall: 3 } }];
        const a = fakeNode([PASS, 'denied', 'denied', 'hang'], 'node-a');
        const b = fakeNode([PASS, 'denied', 'hang'], 'node-b');
        await start({}, hosts);
        await nextCheck(b);
        await nextCheck(a);
        const afterOne = [valid(0), valid(1)];
        await nextCheck(a);

        expect([afterOne, [valid(0), valid(1)]]).toEqual([[true, false], [false, false]]);
    });

    it('in one cluster the host without the block keeps its own waits after one', async () => {
        const hosts = [{ host: 'node-a' }, { host: 'node-b', healthCheck: {} }];
        const a = fakeNode([PASS, 'denied'], 'node-a');
        const b = fakeNode([PASS, 'denied'], 'node-b');
        await start({}, hosts);

        await pass(65000);

        // node-a: 10000 * 1.3, then divided by 1.3 after each refused login, held at 5000
        expect(waits(a)).toEqual([13000, 10000, 7692, 5917, 5000, 5000, 5000, 5000, 5000]);
        expect(waits(b)).toEqual([5000, 60000]);
    });

    it('a node without the block waits as before after one on an open connection', async () => {
        const refusal = serverError('changeUser', denied);
        const node = fakeNode([PASS, PASS, refusal, refusal, PASS]);
        await start(CONSUMER);

        await pass(150000);

        // the legacy values of a consumer: 15000 after a pass, 60000 after a failure
        expect(waits(node)).toEqual([15000, 15000, 60000, 60000]);
    });
});

describe('health check with a healthCheck block: the slow pace after a refusal', () => {
    // The time from each request for a connection to the next. A check that hangs takes
    // its timeout, 5000 with an empty block, and the wait after it comes on top.
    // After a refusal every check that gets no answer is followed by authRetryInterval too
    it.each<[string, object, string, number[]]>([
        ['a check that hangs after a refusal waits authRetryInterval again',
            {}, 'P D H P', [5000, 60000, 65000]],
        ['three checks that hang in a row after a refusal each do',
            {}, 'P D H H H P', [5000, 60000, 65000, 65000, 65000]],
        ['a refusal from the check of connect() on, then two that hang',
            {}, 'D H H P P', [60000, 65000, 65000, 5000]],
        ['a refusal between two that hang keeps it going',
            {}, 'P D H C H P', [5000, 60000, 65000, 60000, 65000]],
        ['the connect timeout of mysql2 after a refusal waits authRetryInterval again',
            {}, 'P D E E P P', [5000, 60000, 60000, 60000, 5000]],
        ['interval 2000, timeout 1000 and authRetryInterval 20000',
            { interval: 2000, timeout: 1000, authRetryInterval: 20000 },
            'P D H H P P', [2000, 20000, 21000, 21000, 2000]],
        ['an authRetryInterval below the interval holds for the checks that hang too',
            { interval: 10000, timeout: 3000, authRetryInterval: 2000 },
            'P D H P P', [10000, 2000, 5000, 10000]]
    ])('%s', async (_name, block, letters, wanted) => {
        const node = fakeNode(stepsOf(letters));
        await start({ healthCheck: block });

        await pass(wanted.reduce((sum, wait) => sum + wait, 0));

        expect(waits(node)).toEqual(wanted);
    });

    // The slow pace holds through the first check that hangs. Then a check gets `answer`,
    // and the check that hangs after it is followed by the interval again: 5000 of its
    // timeout and 5000 of the wait
    it.each<[string, string]>([
        ['a pass', 'P'],
        ['a validator that says no', 'N'],
        ['a refused connection', 'R'],
        ['a lost connection', 'L'],
        ['too many connections, errno 1040', 'T'],
        ['a limit of the account, errno 1226', 'U'],
        ['an error of the server with an errno and no code', 'M'],
        ['the query timeout of mysql2, PROTOCOL_SEQUENCE_TIMEOUT', 'Z'],
        ['a pass that then throws in the package', 'B'],
        ['a validator no that then throws in the package', 'X']
    ])('%s ends it: the next check that hangs waits the interval', async (_name, answer) => {
        const node = fakeNode(stepsOf('P D H ' + answer + ' H P'));
        await start({ healthCheck: {} });

        await pass(5000 + 60000 + 65000 + 5000 + 10000);

        expect(waits(node)).toEqual([5000, 60000, 65000, 5000, 10000]);
    });

    it.each<[string, string, number[]]>([
        ['a check that hangs', 'P H H P', [5000, 10000, 10000]],
        ['the connect timeout of mysql2', 'P E E P', [5000, 5000, 5000]],
        ['a check that hangs after a refused connection', 'P R H H P', [5000, 5000, 10000, 10000]]
    ])('with no refusal before it %s waits the interval', async (_name, letters, wanted) => {
        const node = fakeNode(stepsOf(letters));
        await start({ healthCheck: {} });

        await pass(wanted.reduce((sum, wait) => sum + wait, 0));

        expect(waits(node)).toEqual(wanted);
    });

    it('a connect timeout of the socket, with errno -110, keeps it as well', async () => {
        const socketTimeout = () => Object.assign(connectTimeout(), { errno: -110 });
        const node = fakeNode([PASS, 'denied', serverError('login', socketTimeout), PASS]);
        await start({ healthCheck: {} });

        await pass(125000);

        expect(askedAt(node)).toEqual([0, 5000, 65000, 125000]);
    });

    it('a check the app failed with failWaiting() after a refusal keeps it too', async () => {
        const node = fakeNode([PASS, 'denied', 'waits', PASS]);
        await start({ healthCheck: {} });
        await pass(65000);

        expect(cluster.failWaiting(0, Object.assign(new Error('leaving'), DENIED))).toBe(1);
        await pass(60000);

        expect(askedAt(node)).toEqual([0, 5000, 65000, 125000]);
    });

    it('the state is as after any failed check: the node comes back by rise', async () => {
        expect(await upAfterEach({}, 'P D H P H P P')).toBe('U d d d d d U');
    });

    it('a node without the block waits by its range after such checks', async () => {
        const node = fakeNode([PASS, 'denied', 'hang', 'hang', PASS]);
        await start({});

        await pass(13000 + 10000 + 22692 + 20917);

        // 10000 * 1.3, then divided by 1.3 each time. A check that hangs takes 15000
        expect(waits(node)).toEqual([13000, 10000, 22692, 20917]);
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

    it('a node a refusal took down is up with the one pass of a new connect()', async () => {
        await reconnected('P D', 'P');

        expect(valid()).toBe(true);
    });

    it('is up with the first pass also when the new connect() is refused first', async () => {
        const node = await reconnected('P D', 'C P');
        expect(valid()).toBe(false);

        await nextCheck(node);

        expect(valid()).toBe(true);
    });

    it('a refusal still out at the disconnect() does not count after it', async () => {
        const node = fakeNode([PASS, 'held', PASS, 'hang']);
        await start({ healthCheck: block });
        await nextCheck(node);
        await cluster.disconnect();
        // the check of the new connect() passes, then the old check gets its refusal
        await connect();
        node.held[0](denied());
        await pass(0);

        expect([valid(), info().checkError]).toEqual([true, undefined]);
        // and the next check comes one interval after the check of the new connect()
        await pass(5000);
        expect(askedAt(node)).toEqual([0, 5000, 5000, 10000]);
    });

    it('a new connect() starts with no slow pace from before', async () => {
        // refused before the disconnect(). The check of the new connect() runs into the
        // connect timeout of mysql2, which would keep a slow pace going
        const node = await reconnected('P D', 'E P');

        await pass(5000);

        expect(askedAt(node)).toEqual([0, 5000, 5000, 10000]);
    });

    it('a new connect() after a refusal checks at once, and waits when refused', async () => {
        const node = await reconnected('P D', 'D P');
        // the check of connect() at 0, the refused one at 5000, the new connect() right then
        expect(askedAt(node)).toEqual([0, 5000, 5000]);

        await pass(59999);
        const before = node.asked.length;
        await pass(1);

        expect([before, askedAt(node)]).toEqual([3, [0, 5000, 5000, 65000]]);
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
    // the record of a refusal also has the errno the server refused with, and the ms
    // until the next check as retryIn
    const downRefusal = (errno: number, retryIn: number = 60000) => {
        return ['warn', { pool, valid: false, reason: 'refusal', errno, retryIn }];
    };

    it.each<[string, object, string, any[]]>([
        ['down by failed checks and back: one line per change, none for the checks between',
            {}, 'P R R R P P P', [up1, downFall, upRise]],
        ['down by a validator and back', {}, 'P N N P P', [up1, downNo, upRise]],
        ['fall 1 and rise 1',
            { fall: 1, rise: 1 }, 'P R P R P', [up1, downFall, upRise, downFall, upRise]],
        ['a node that starts down logs its first pass and no fall', {}, 'R R R P', [up1]],
        ['a node that stays up logs nothing more', {}, 'P R P R P', [up1]],
        ['a no that then throws is one line, the one of the validator',
            { fall: 1 }, 'P X', [up1, downNo]],
        ['down by a refused login and back: one line for the first refusal',
            {}, 'P D C P P', [up1, downRefusal(1045), upRise]],
        ['a refusal that is the answer to the status query has its own errno',
            {}, 'P Q', [up1, downRefusal(1044)]],
        ['fall 1: a refusal is not logged as the fall',
            { fall: 1 }, 'P D', [up1, downRefusal(1045)]],
        ['retryIn is the authRetryInterval the app wrote',
            { authRetryInterval: 20000 }, 'P D', [up1, downRefusal(1045, 20000)]],
        ['retryIn is the interval when that is the longer default',
            { interval: 90000 }, 'P C', [up1, downRefusal(1045, 90000)]],
        ['a refusal of a node that is down already logs no line', {}, 'P R R D', [up1, downFall]],
        ['a node refused from its connect() on logs its first pass only', {}, 'D D P', [up1]]
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
        // and no line in the words of the legacy check, which tell of the node
        const legacyLines = logger.debug.mock.calls
            .filter(([text]) => String(text).startsWith('Is status ok'));
        expect(legacyLines).toEqual([]);
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

    // The block of the default pool settings, the block of the host, and the
    // authRetryInterval of the host: what the app wrote, or the longer of 60000 and the
    // interval of that host when nobody wrote it
    it.each<[string, object | undefined, object | undefined, number]>([
        ['is 60000 with the default interval', {}, undefined, 60000],
        ['is 60000 with an interval below it', { interval: 59999 }, undefined, 60000],
        ['is 60000 with an interval of 60000', { interval: 60000 }, undefined, 60000],
        ['is the interval once that is longer', { interval: 60001 }, undefined, 60001],
        ['is the interval of 300000 of the default block', { interval: 300000 }, {}, 300000],
        ['follows the interval of a host that has its own',
            { interval: 2000 }, { interval: 90000 }, 90000],
        ['is 60000 again for a host with a shorter interval of its own',
            { interval: 300000 }, { interval: 2000 }, 60000],
        ['follows the interval of a host that alone has a block',
            undefined, { interval: 120000 }, 120000],
        ['is the value the app wrote, also below the interval',
            { interval: 300000, authRetryInterval: 1000 }, undefined, 1000],
        ['is the value written in the default block, whatever the interval of the host',
            { authRetryInterval: 60000 }, { interval: 300000 }, 60000],
        ['is the value written on the host first',
            { interval: 300000, authRetryInterval: 1000 }, { authRetryInterval: 500 }, 500],
        ['set to undefined on the host counts as left out',
            { interval: 300000 }, { authRetryInterval: undefined }, 300000],
        ['set to undefined in both places counts as left out',
            { interval: 90000, authRetryInterval: undefined },
            { authRetryInterval: undefined }, 90000]
    ])('authRetryInterval %s', (_name, onDefaults, onHost, wanted) => {
        const hosts = [{ host: 'node-a', ...(onHost ? { healthCheck: onHost } : {}) }];
        createPoolCluster(settingsOf(onDefaults ? { healthCheck: onDefaults } : {}, hosts));

        expect(blocks()[0].authRetryInterval).toBe(wanted);
    });

    it('the default authRetryInterval is not written into the default pool settings', () => {
        createPoolCluster(settingsOf({ healthCheck: { interval: 300000 } }, twoHosts()));

        expect(config.current.defaultPoolSettings.healthCheck).toEqual({ interval: 300000 });
        expect(blocks().map(block => block.authRetryInterval)).toEqual([300000, 300000]);
    });

    it('an interval of 90000 alone makes a refused login wait 90000 too', async () => {
        const node = fakeNode([PASS, 'denied', 'denied', PASS]);
        await start({ healthCheck: { interval: 90000 } });

        await pass(270000);

        expect(waits(node)).toEqual([90000, 90000, 90000]);
    });

    it('a host overrides the authRetryInterval of the default block', async () => {
        const a = fakeNode([PASS, 'denied', PASS], 'node-a');
        const b = fakeNode([PASS, 'denied', PASS], 'node-b');
        const onHost = { healthCheck: { authRetryInterval: 7000 } };
        await start({ healthCheck: { authRetryInterval: 30000 } }, twoHosts(onHost));

        await pass(35000);

        expect(waits(a)).toEqual([5000, 30000]);
        expect(waits(b)).toEqual([5000, 7000, 5000, 5000, 5000, 5000]);
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
            ['an authRetryInterval that is a string',
                { authRetryInterval: '60000' }, '.authRetryInterval'],
            ['an authRetryInterval above the longest timer of Node',
                { authRetryInterval: 2147483648 }, '.authRetryInterval'],
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
            ['a timeout above the interval', { interval: 1000, timeout: 30000 }],
            ['the longest timer of Node as authRetryInterval', { authRetryInterval: 2147483647 }],
            ['an authRetryInterval below the interval', { interval: 9000, authRetryInterval: 100 }]
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
        // wait 5000, refused: one check is enough, whatever fall is
        ['the defaults, logins refused: 5000 ms', { healthCheck: {} }, 'denied', 5000],
        ['fall 3, logins refused: 5000 ms', { healthCheck: { fall: 3 } }, 'denied', 5000],
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

    // The same for a node a refused login took down. The login is put right just after a
    // refused check, so the node waits out authRetryInterval before its first pass
    it.each<[string, object, number]>([
        // wait 60000, pass, wait 5000, pass
        ['the defaults: 65000 ms', {}, 65000],
        // wait 60000, pass
        ['rise 1: 60000 ms', { rise: 1 }, 60000],
        // wait 20000, pass, then twice: wait 2000, pass
        ['authRetryInterval 20000, interval 2000 and rise 3: 24000 ms',
            { authRetryInterval: 20000, interval: 2000, rise: 3 }, 24000]
    ])('after a refused login, %s', async (_name, block, total) => {
        await returning({ healthCheck: block }, 'P D');

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

describe('health check with a healthCheck block: the logins of refused checks in an hour', () => {
    const HOUR = 3600000;
    // A node that passed the check of connect() and from then on ends its checks as `steps`
    // say, the last one for good. The times of its checks in the hour after the first of
    // them, counted from it.
    // Every such check is one login at the server: the pool holds no connection to use again
    const hourAfterFirst = async (pool: object, ...steps: Step[]): Promise<number[]> => {
        const node = fakeNode([PASS, ...steps]);
        await start(pool);
        await nextCheck(node);
        const first = Date.now();
        await pass(HOUR);
        return node.asked.filter(at => at > first).map(at => at - first);
    };
    // `count` times, one every `ms`
    const every = (ms: number, count: number, from: number = 0): number[] => {
        return Array.from({ length: count }, (_, index) => from + (index + 1) * ms);
    };

    it.each<[string, object, number[]]>([
        ['an empty block: 60, one a minute', { healthCheck: {} }, every(60000, 60)],
        ['authRetryInterval 5000: 720',
            { healthCheck: { authRetryInterval: 5000 } }, every(5000, 720)],
        ['authRetryInterval 300000: 12',
            { healthCheck: { authRetryInterval: 300000 } }, every(300000, 12)],
        ['interval 1000 and the default authRetryInterval: 60',
            { healthCheck: { interval: 1000 } }, every(60000, 60)],
        ['an empty block next to the legacy values of a consumer: 60',
            { ...CONSUMER, healthCheck: {} }, every(60000, 60)],
        // the wait is 10000, 7692 and 5917, and then stays at the start of the range
        ['the legacy defaults: 718',
            {}, [10000, 17692, 23609, ...every(5000, 715, 23609)]],
        // the wait after a failed check is the end of the range
        ['the legacy values of a consumer: 60', CONSUMER, every(60000, 60)]
    ])('a login refused with 1045, %s', async (_name, pool, wanted) => {
        const times = await hourAfterFirst(pool, 'denied');

        expect(times).toEqual(wanted);
    });

    // The server holds every refusal after the first back for longer than a check waits,
    // as the connection control plugin of MySQL does. Each check hangs for 5000 and is
    // followed by 60000, so the logins are 65000 apart
    it('refusals that come too late after the first, an empty block: 55', async () => {
        const times = await hourAfterFirst({ healthCheck: {} }, 'denied', 'hang');

        expect(times).toEqual([60000, ...every(65000, 54, 60000)]);
    });

    // The floor of the setting: ten logins a second for as long as the server refuses,
    // which is 36000 in an hour. Counted over one minute here
    it('authRetryInterval 100, the lowest the schema takes: 600 in a minute', async () => {
        const node = fakeNode([PASS, 'denied']);
        await start({ healthCheck: { authRetryInterval: 100 } });
        await nextCheck(node);

        await pass(60000);

        expect(waits(node)).toEqual([5000, ...new Array(600).fill(100)]);
    });

    // what a refused login cost before the list: a failure like these, at the interval
    it.each<[string, () => any]>([
        ['too many connections, errno 1040', tooMany],
        ['a limit of the account, errno 1226', overLimit]
    ])('%s, an empty block: 720, one every interval', async (_name, error) => {
        const times = await hourAfterFirst({ healthCheck: {} }, serverError('login', error));

        expect(times).toEqual(every(5000, 720));
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

    it('a refused check is an error check, and the node is not valid', async () => {
        expect(await upAfterEach({}, 'P D')).toBe('U d');

        const wanted = { checks: { valid: 1, error: 1 }, valid: 0, loadScore: 19 };
        expect(await read()).toEqual(wanted);
    });

    it('nodes() shows a refused node as not valid, with the error of the server', async () => {
        const node = fakeNode([up(7), 'denied', up(9), up(11)]);
        await start({ healthCheck: {} });
        const seen = [];
        for (let i = 0; i < 3; i++) {
            await nextCheck(node);
            seen.push(info());
        }

        const base = { id: 0, name: 'node-a:3306', host: 'node-a', port: 3306 };
        expect(seen).toEqual([
            { ...base, isValid: false, loadScore: 19, checkError: DENIED },
            { ...base, isValid: false, loadScore: 23 },
            { ...base, isValid: true, loadScore: 27 }
        ]);
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

    it('firstReady and nodes() have the error of a refused check of connect() too', async () => {
        fakeNode(['denied']);
        cluster = createPoolCluster(settingsOf({ healthCheck: {} }));
        cluster.connect().catch((): void => undefined);

        const [result] = await cluster.firstReady;
        expect([result.nodeId, result.ok, result.checkError]).toEqual([0, false, DENIED]);
        expect(info()).toMatchObject({ isValid: false, checkError: DENIED });
    });

    it('pool_check_failed comes with every refused check, with the error of mysql2', async () => {
        const failed: any[] = [];
        const node = fakeNode(stepsOf('P D C Q P'));
        await start({ healthCheck: {} });
        cluster.on('pool_check_failed', (args: any[]) => failed.push([args[0].errno, args[1]]));
        for (let i = 0; i < 4; i++) await nextCheck(node);

        expect(failed).toEqual([[1045, 0], [1045, 0], [1044, 0]]);
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
