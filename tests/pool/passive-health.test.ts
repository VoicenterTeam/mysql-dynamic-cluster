// a mysql2 that opens nothing. Every pool it creates asks the fake node of its host
jest.mock('mysql2', () => ({
    __esModule: true,
    default: { createPool: jest.fn(), createConnection: jest.fn() }
}));

import mysql from 'mysql2';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { createPoolCluster } from '../../index';

// Passive health of a node that has a healthCheck block: what a query or a getConnection()
// of the app runs into moves the node between two checks. A connection that cannot be
// refused takes the node down at once. A connection that was lost, one that was not there
// within the connect timeout and one that no route led to start a check at once, and that
// check takes the node down when it fails. Nothing else counts, and the check itself never does. Every number
// here is worked out by hand from the settings.
// The cluster is the one an app gets from createPoolCluster. Only mysql2 is replaced, and
// the clock is fake: a check that passive health starts is a request for a connection at
// the fake time of the call that failed.
// The fake node and the helpers are those of health-check.test.ts, copied and grown by the
// places a query of the app can fail at: that suite stays as it is

type Cb = (err: any, res?: any) => void;
type Rows = { Variable_name: string, Value: string }[];
// An error at one place of a request. 'open' fails the request for a connection itself,
// 'changeUser' the change of user on the connection it got, 'query' the first query on it,
// and any other text the query with that sql. `then` is one more failure of that request
type Failure = { at: string, error: () => any, then?: Failure };
// How one request for a connection ends. Rows answer every query on the connection. 'hang'
// hands out a connection that never answers, 'stuck' one whose change of user never
// answers, and 'held' one whose first query answers when the test says so, through
// node.held. 'opening' keeps the request until the test answers it, through node.opening,
// and 'waits' leaves it in the queue of mysql2, as a pool at its limit does
type Step = Rows | 'hang' | 'stuck' | 'held' | 'opening' | 'waits' | Failure;
const isFailure = (step: Step): step is Failure => {
    return typeof step === 'object' && !Array.isArray(step);
};
const failuresOf = (step: Step): Failure[] => {
    const all: Failure[] = [];
    for (let next = isFailure(step) ? step : undefined; next; next = next.then) all.push(next);
    return all;
};

// SHOW GLOBAL STATUS of a node that every default validator accepts. With the default load
// factors its score is 2 * connections + 10 * 0.5
const up = (connections = 7, ready = 'ON'): Rows => [
    { Variable_name: 'wsrep_ready', Value: ready },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '3' },
    { Variable_name: 'Connections', Value: String(connections) },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0.5' }
];
const PASS = up();
// the same node while it is not ready: it answers, and the first default validator says no
const NO = up(7, 'OFF');

const makeNode = (steps: Step[]) => {
    const node = {
        // the fake time of every request for a connection: the checks and the app's own
        asked: [] as number[],
        // every sql that reached a connection of this node
        sqls: [] as string[],
        // how the next requests end, in order. The last one stays for every request after it
        plan: steps,
        // the first queries that wait for the test to answer them
        held: [] as Cb[],
        // the requests for a connection that wait for the test to answer them
        opening: [] as Cb[],
        mysqlPool: {
            on: jest.fn(), end: jest.fn(),
            _allConnections: [], _freeConnections: [], _connectionQueue: [] as Cb[],
            getConnection: (cb: Cb) => {
                node.asked.push(Date.now());
                const step = node.plan.length > 1 ? node.plan.shift() : node.plan[0];
                if (step === 'opening') return node.opening.push(cb);
                if (step === 'waits') return node.mysqlPool._connectionQueue.push(cb);
                const failures = failuresOf(step);
                const failureAt = (at: string) => failures.find(failure => failure.at === at);
                if (failureAt('open')) return cb(failureAt('open').error());
                let first = true;
                cb(null, {
                    // mysql2 marks every error of a change of user as fatal, whatever it is
                    changeUser: (_options: any, done: Cb) => {
                        const failure = failureAt('changeUser');
                        if (failure) return done(Object.assign(failure.error(), { fatal: true }));
                        if (step !== 'stuck') done(null);
                    },
                    query: (options: any, done: Cb) => {
                        node.sqls.push(options.sql);
                        const failure = failureAt(options.sql) || (first && failureAt('query'));
                        first = false;
                        if (failure) return done(failure.error());
                        if (step === 'held') return node.held.push(done);
                        if (step !== 'hang') done(null, isFailure(step) ? [] : step);
                    },
                    release: jest.fn(), destroy: jest.fn()
                });
            }
        }
    };
    return node;
};
type FakeNode = ReturnType<typeof makeNode>;

// Nothing here waits for a real clock. A call that never settles is a bug of the code or of
// a test: it fails after 30 s, not after the 300 s the project gives a test
jest.setTimeout(30000);

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

const pass = (ms: number) => jest.advanceTimersByTimeAsync(ms);
const info = (index: number = 0) => cluster.nodes()[index];
const valid = (index: number = 0): boolean => info(index).isValid;
// the time of each request for a connection, counted from the first one
const askedAt = (node: FakeNode): number[] => node.asked.map(at => at - node.asked[0]);

// An error of the network as mysql2 hands it out: the code, fatal, and what Node adds for
// an error of a socket. The connect timeout of mysql2 and its lost connection have no errno
const network = (code: string, errno?: number, syscall?: string) => () => {
    const error: any = Object.assign(new Error(code), { code, fatal: true });
    if (errno !== undefined) Object.assign(error, { errno, syscall });
    return error;
};
// An error packet as mysql2 hands it out: the errno and the SQL state of the server, and the
// name mysql2 has for that errno as the code. Never fatal as it comes from the parser
const packet = (errno: number, code: string, sqlState: string = 'HY000') => {
    return () => Object.assign(new Error('error ' + errno + ' of the server'),
        { code, errno, sqlState, sqlMessage: 'error ' + errno + ' of the server' });
};
const failure = (at: string, error: () => any, then?: Failure): Failure => ({ at, error, then });

// The code of a connection the node refused, with the errno of Linux
const CONNECT: [string, number | undefined, string | undefined][] = [
    ['ECONNREFUSED', -111, 'connect']
];
// The codes of a connection that no route led to: this host, or a router on the path,
// said so. Nobody asked the node
const UNREACHABLE: [string, number | undefined, string | undefined][] = [
    ['EHOSTUNREACH', -113, 'connect'],
    ['ENETUNREACH', -101, 'connect']
];
// Codes of the network that are left out on purpose, each with the errno of Linux. A name
// lookup is shared by every node addressed by name, and the others say something about
// this host or about one connection, not about the node
const LEFT_OUT: [string, string, number, string][] = [
    ['a host name that does not resolve', 'ENOTFOUND', -3008, 'getaddrinfo'],
    ['a resolver that does not answer', 'EAI_AGAIN', -3001, 'getaddrinfo'],
    ['no local address to connect from', 'EADDRNOTAVAIL', -99, 'connect'],
    ['a connection this host aborted', 'ECONNABORTED', -103, 'read'],
    ['a host that is reported down', 'EHOSTDOWN', -112, 'connect'],
    ['a network of this host that is down', 'ENETDOWN', -100, 'connect']
];
// The codes of a connection that was lost
const LOST: [string, number | undefined, string | undefined][] = [
    // made by mysql2 when the socket closed: no errno
    ['PROTOCOL_CONNECTION_LOST', undefined, undefined],
    ['ECONNRESET', -104, 'read'],
    ['EPIPE', -32, 'write']
];
// the connect timeout of mysql2 itself: no errno. In place of a connection
const timedOut = network('ETIMEDOUT');
const TIMED_OUT = failure('open', timedOut);
// no route to the network of the node, in place of a connection
const NO_ROUTE = failure('open', network('ENETUNREACH', -101, 'connect'));
const NO_ROUTE_CHECK = { code: 'ENETUNREACH', errno: -101 };
const refused = network('ECONNREFUSED', -111, 'connect');
const reset = network('ECONNRESET', -104, 'read');
const REFUSED = failure('open', refused);
// what a check that found the connection refused, or reset under its query, reports
const REFUSED_CHECK = { code: 'ECONNREFUSED', errno: -111 };
const RESET_CHECK = { code: 'ECONNRESET', errno: -104 };
const RESET = failure('query', reset);
const denied = packet(1045, 'ER_ACCESS_DENIED_ERROR', '28000');
const deadlock = packet(1213, 'ER_LOCK_DEADLOCK', '40001');
const limit = packet(1226, 'ER_USER_LIMIT_REACHED', '42000');
const tooMany = packet(1040, 'ER_CON_COUNT_ERROR', '08004');
// a check the server refuses the login of: on a new connection, and on an open one
const DENIED = failure('open', denied);
const DENIED_OPEN = failure('changeUser', denied);

// The three ways an app reaches a node. A transaction has no cluster call of its own
const SQLS = ['UPDATE t SET a = 1'];
const app = {
    query: () => cluster.query('SELECT 1'),
    multiStatementQuery: () => cluster.pools[0].multiStatementQuery(SQLS, {}),
    getConnection: () => cluster.getConnection()
};
type Call = keyof typeof app;
const CALLS = Object.keys(app) as Call[];
// straight to the pool of the node, as the cluster does for a node it picked
const direct = (index: number = 0) => cluster.pools[index].query('SELECT 1');
const failed = (call: Promise<any>): Promise<any> => call.then(() => {
    throw new Error('the call of the app passed');
}, (error: any) => error);

// A node with a healthCheck block that passed the check of connect(). 1000 ms later a call
// of the app ends as `step` says, and each request after it as `after` says, in order.
// The clock stands still from there: a request at 1000 that is not the app's own is a
// check passive health started
const hit = async (
    step: Step, call: Call = 'query', block: object = {}, after: Step[] = [PASS]
) => {
    const node = fakeNode([PASS, step, ...after]);
    await start({ healthCheck: block });
    await pass(1000);
    const error = await failed(app[call]());
    return { node, error };
};

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

// where a query or a transaction of the app can get an error on the connection it was handed
const deadlocked = (then: Failure) => failure(SQLS[0], deadlock, then);
const places = (error: () => any): [string, Call, Step][] => [
    ['at the change of user of a query', 'query', failure('changeUser', error)],
    ['under a query', 'query', failure('query', error)],
    ['at the change of user of a transaction', 'multiStatementQuery',
        failure('changeUser', error)],
    ['at the start of a transaction', 'multiStatementQuery',
        failure('START TRANSACTION', error)],
    ['under a statement of a transaction', 'multiStatementQuery', failure(SQLS[0], error)],
    ['at the commit of a transaction', 'multiStatementQuery', failure('COMMIT', error)],
    ['at the rollback after a deadlock', 'multiStatementQuery',
        deadlocked(failure('ROLLBACK', error))]
];

describe('passive health: a connection that cannot be opened', () => {
    describe.each(CONNECT)('%s', (code, errno, syscall) => {
        const step = failure('open', network(code, errno, syscall));

        // fall is 3: no count of failed checks takes this node down so soon
        it.each(CALLS)('of %s takes the node down at once', async call => {
            const { node } = await hit(step, call, { fall: 3 });

            // before any check: only the call of the app asked the node
            expect([valid(), askedAt(node)]).toEqual([false, [0, 1000]]);
        });

        it.each(CALLS)('of %s starts a check at once', async call => {
            const { node } = await hit(step, call, { fall: 3 });
            await pass(0);

            // the status query of that check reached the node, 0 ms after the call
            expect(askedAt(node)).toEqual([0, 1000, 1000]);
            expect(node.sqls.slice(-1)).toEqual(['SHOW GLOBAL STATUS;']);
        });
    });

    // Told by the place too. A code of this list on a connection that was handed out, and
    // a socket that timed out there, is a lost connection: the node is up after the call,
    // and down by the check
    describe.each([...CONNECT, ...UNREACHABLE, ['ETIMEDOUT', -110, 'read']])(
        '%s on a connection that was handed out', (code, errno, syscall) => {
            it.each(places(network(code as string, errno as number, syscall as string)))(
                '%s is a lost connection', async (_name, call, step) => {
                    const { node } = await hit(step, call, { fall: 3 }, [REFUSED]);
                    const atOnce = valid();
                    await pass(0);

                    expect([atOnce, valid(), askedAt(node)]).toEqual(
                        [true, false, [0, 1000, 1000]]);
                });
        });

    it('several addresses that all refuse: the code of the AggregateError counts', async () => {
        // Node 20 and later, for a host name with more than one address: no errno, no message
        // The lib this project compiles its tests with does not know the class yet
        const Aggregate = (globalThis as any).AggregateError;
        const all = () => Object.assign(new Aggregate([refused(), refused()], ''),
            { code: 'ECONNREFUSED', fatal: true });
        await hit(failure('open', all));

        expect(valid()).toBe(false);
    });

    it('the node is down before the caller hears of the error', async () => {
        fakeNode([PASS, REFUSED, PASS]);
        await start({ healthCheck: {} });
        let seen: boolean;

        await direct().catch(() => { seen = valid(); });

        expect(seen).toBe(false);
    });
});

describe('passive health: a connection that did not come, and nobody refused it', () => {
    // The connect timeout of mysql2 has no errno, the one of the socket has. No route is
    // what this host or a router says. In none of them the node said it is gone, so the
    // node stays up and a check decides. fall is 3 throughout
    const TIMEOUTS: [string, Step][] = [
        ['the connect timeout of mysql2', TIMED_OUT],
        ['the connect timeout of the socket',
            failure('open', network('ETIMEDOUT', -110, 'connect'))],
        ...UNREACHABLE.map(([code, errno, syscall]): [string, Step] => {
            return ['no route, ' + code, failure('open', network(code, errno, syscall))];
        })
    ];
    const ROWS = TIMEOUTS.flatMap(([name, step]) => {
        return CALLS.map((call): [string, Call, Step] => [name, call, step]);
    });

    it.each(ROWS)('%s of %s leaves the node up and starts a check', async (_n, call, step) => {
        const { node } = await hit(step, call, { fall: 3 }, ['hang']);
        const atOnce = [valid(), askedAt(node)];
        await pass(0);

        expect(atOnce).toEqual([true, [0, 1000]]);
        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000]]);
    });

    it.each(ROWS)('%s of %s: one failed check takes the node down', async (_n, call, step) => {
        await hit(step, call, { fall: 3 }, [REFUSED]);
        await pass(0);

        expect([valid(), info().checkError]).toEqual([false, REFUSED_CHECK]);
    });

    it.each(ROWS)('%s of %s: a check that passes leaves the node up', async (_n, call, step) => {
        const { node } = await hit(step, call, { fall: 3 }, [PASS, 'hang']);
        await pass(4999);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000]]);
    });

    it('a check that gets no connection in time either takes the node down', async () => {
        await hit(TIMED_OUT, 'query', { fall: 3 }, [TIMED_OUT]);
        await pass(0);

        expect([valid(), info().checkError]).toEqual([false, { code: 'ETIMEDOUT' }]);
    });

    it.each(UNREACHABLE)('%s, and a check that finds no route either: the node is down',
        async (code, errno, syscall) => {
            const step = failure('open', network(code, errno, syscall));
            await hit(step, 'query', { fall: 3 }, [step]);
            await pass(0);

            expect([valid(), info().checkError]).toEqual([false, { code, errno }]);
        });

    it('no route, and a check that hangs: down at its timeout of 1000', async () => {
        await hit(NO_ROUTE, 'query', { fall: 3, timeout: 1000 }, ['hang']);
        await pass(999);
        const before = valid();
        await pass(1);

        expect([before, valid(), info().checkError]).toEqual([true, false, {}]);
    });

    // What an app sees while this host has no route for a moment: no route for every node,
    // though each of them is healthy and its pooled connections work
    it('two healthy nodes and no route for a call of each: both stay up', async () => {
        const a = fakeNode([PASS, NO_ROUTE, PASS], 'node-a');
        const b = fakeNode([PASS, NO_ROUTE, PASS], 'node-b');
        await start({ healthCheck: {} }, [{ host: 'node-a' }, { host: 'node-b' }]);
        await pass(1000);
        await Promise.all([failed(direct(0)), failed(direct(1))]);
        await pass(0);

        expect([valid(0), valid(1)]).toEqual([true, true]);
        expect([askedAt(a), askedAt(b)]).toEqual([[0, 1000, 1000], [0, 1000, 1000]]);
        expect(changes().filter(([level]) => level === 'warn')).toEqual([]);
    });

    it('a check that hangs takes the node down at its timeout of 1000', async () => {
        await hit(TIMED_OUT, 'query', { fall: 3, timeout: 1000 }, ['hang']);
        await pass(999);
        const before = valid();
        await pass(1);

        expect([before, valid(), info().checkError]).toEqual([true, false, {}]);
    });

    it('a pass ends it: the failed check after that is the first of three', async () => {
        const { node } = await hit(TIMED_OUT, 'query', { fall: 3 }, [PASS, REFUSED, 'hang']);
        await pass(5000);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 6000]]);
    });

    // What a process sees that stalled for longer than the connect timeout while its logins
    // were out: a connect timeout for every node, though each of them answered
    it('two healthy nodes and a connect timeout for each: both stay up', async () => {
        const a = fakeNode([PASS, TIMED_OUT, PASS], 'node-a');
        const b = fakeNode([PASS, TIMED_OUT, PASS], 'node-b');
        await start({ healthCheck: {} }, [{ host: 'node-a' }, { host: 'node-b' }]);
        await pass(1000);
        await Promise.all([failed(direct(0)), failed(direct(1))]);
        await pass(0);

        expect([valid(0), valid(1)]).toEqual([true, true]);
        expect([askedAt(a), askedAt(b)]).toEqual([[0, 1000, 1000], [0, 1000, 1000]]);
        expect(changes().filter(([level]) => level === 'warn')).toEqual([]);
    });
});

describe('passive health: a connection that was lost', () => {
    describe.each(LOST)('%s', (code, errno, syscall) => {
        const error = network(code, errno, syscall);

        const PLACES = places(error);

        it.each(PLACES)('%s leaves the node up and starts a check', async (_n, call, step) => {
            const { node } = await hit(step, call, { fall: 3 }, ['hang']);
            const atOnce = [valid(), askedAt(node)];
            await pass(0);

            expect(atOnce).toEqual([true, [0, 1000]]);
            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000]]);
        });

        // fall is 3, and this is the first failed check
        it.each(PLACES)('%s: one failed check takes the node down', async (_n, call, step) => {
            await hit(step, call, { fall: 3 }, [REFUSED]);
            await pass(0);

            expect([valid(), info().checkError]).toEqual([false, REFUSED_CHECK]);
        });

        it.each(PLACES)('%s: a check that passes leaves the node up', async (_n, call, step) => {
            const { node } = await hit(step, call, { fall: 3 }, [PASS]);
            await pass(0);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000]]);
        });
    });

    it('is told by the place too: a new connection reset at its login is a lost one', async () => {
        const { node } = await hit(failure('open', reset), 'query', { fall: 3 }, [REFUSED]);
        const atOnce = valid();
        await pass(0);

        // not down by the call itself, as a refused connection is. Down by the check
        expect([atOnce, valid(), askedAt(node)]).toEqual([true, false, [0, 1000, 1000]]);
    });

    it('a getConnection() whose new connection the server closed is a lost one too', async () => {
        const closed = failure('open', network('PROTOCOL_CONNECTION_LOST'));
        const { node } = await hit(closed, 'getConnection', { fall: 3 }, [REFUSED]);
        const atOnce = valid();
        await pass(0);

        expect([atOnce, valid(), askedAt(node)]).toEqual([true, false, [0, 1000, 1000]]);
    });
});

describe('passive health: a check that meets one more lost connection', () => {
    // A path that forgot its idle flows resets every pooled connection at its next use.
    // The check that decides draws on the same pool, so its error can be one more of them.
    // It says nothing about the node: the check runs again, at once.
    // The fake clock gives a timer of 0 ms that was set inside a timer 1 ms, as Node does
    // for every timer of 0 ms: here each run comes 1 ms after the run before it
    const MET: [string, Step][] = LOST.flatMap(([code, errno, syscall]): [string, Step][] => {
        const error = network(code, errno, syscall);
        return [
            [code + ' at its change of user', failure('changeUser', error)],
            [code + ' under its status query', failure('query', error)],
            [code + ' in place of a connection', failure('open', error)]
        ];
    });
    // the call of the app at 1000 loses its connection, then the checks end as `checks` say
    const lostThen = async (checks: Step[], pool: object = {}, block: object = { fall: 3 }) => {
        const node = fakeNode([PASS, RESET, ...checks]);
        await start({ ...pool, healthCheck: block });
        await pass(1000);
        await failed(direct());
        return node;
    };
    const downBy = (reason: string, code: string) => {
        return ['warn', { pool, valid: false, reason, code }];
    };

    it.each(MET)('%s: the node stays up and the check runs again at once', async (_n, step) => {
        const node = await lostThen([step, 'hang']);
        await pass(1);

        // the call, the check at once and its second run
        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 1001]]);
    });

    it.each(MET)('%s, then an answer: up, and the next check comes when due', async (_n, step) => {
        const node = await lostThen([step, step, PASS, 'hang']);
        await pass(5001);
        const before = askedAt(node);
        await pass(1);

        // one interval after the run that got its answer, at 1002
        expect([valid(), before]).toEqual([true, [0, 1000, 1000, 1001, 1002]]);
        expect(askedAt(node).slice(-1)).toEqual([6002]);
    });

    // how the row of runs ends. Each run before the last met a lost connection
    const refusedLogin = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };
    it.each<[string, Step, boolean, object | undefined, number]>([
        ['a pass', PASS, true, undefined, 5000],
        ['a validator that says no', NO, false, undefined, 5000],
        ['a connection that cannot be opened', REFUSED, false, REFUSED_CHECK, 5000],
        ['a connect timeout', TIMED_OUT, false, { code: 'ETIMEDOUT' }, 5000],
        ['a login the server refuses', DENIED, false, refusedLogin, 60000]
    ])('two such runs, then %s', async (_name, last, isUp, checkError, wait) => {
        const node = await lostThen([RESET, RESET, last, 'hang']);
        await pass(2 + wait - 1);
        const before = askedAt(node);
        await pass(1);

        expect([valid(), info().checkError]).toEqual([isUp, checkError]);
        expect(before).toEqual([0, 1000, 1000, 1001, 1002]);
        expect(askedAt(node).slice(-1)).toEqual([1002 + wait]);
    });

    it('two such runs, then a check that hangs: down at its timeout of 1000', async () => {
        await lostThen([RESET, RESET, 'hang'], {}, { fall: 3, timeout: 1000 });
        await pass(1001);
        const before = valid();
        await pass(1);

        expect([before, valid(), info().checkError]).toEqual([true, false, {}]);
    });

    describe('counts toward nothing', () => {
        it('fall 2 and two such runs: the node is still up', async () => {
            const node = await lostThen([RESET, RESET, 'hang'], {}, {});
            await pass(2);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 1001, 1002]]);
        });

        it('fall 2, one such run, then a refused connection: down by the check that decided',
            async () => {
                await lostThen([RESET, REFUSED, 'hang'], {}, {});
                await pass(1);

                // not by the count of failed checks: this was the first that counts
                expect(changes()).toEqual([up1, downBy('passive_lost', 'ECONNRESET')]);
            });

        it('fall 2: after the row ended with a pass, one failed check leaves the node up',
            async () => {
                const node = await lostThen([RESET, RESET, PASS, REFUSED, 'hang'], {}, {});
                await pass(5002);

                expect([valid(), askedAt(node)]).toEqual(
                    [true, [0, 1000, 1000, 1001, 1002, 6002]]);
            });
    });

    describe('is bounded by the connections the pool may hold', () => {
        // every check meets a lost connection: a node that resets each new connection too
        it.each<[string, object, number]>([
            ['a connectionLimit of 3: the check and 3 more runs', { connectionLimit: 3 }, 4],
            ['the default limit of 10: the check and 10 more runs', {}, 11],
            ['a connectionLimit of 1: the check and 1 more run', { connectionLimit: 1 }, 2],
            // never more than 50, half of what a server lets one host fail to connect
            ['a pool without a limit: the check and 50 more runs', { connectionLimit: 0 }, 51],
            ['a connectionLimit of 500: the check and 50 more runs',
                { connectionLimit: 500 }, 51],
            ['a connectionLimit of 51: the check and 50 more runs',
                { connectionLimit: 51 }, 51],
            ['a connectionLimit of 49: the check and 49 more runs',
                { connectionLimit: 49 }, 50]
        ])('%s, then the node is down', async (_name, limits, runs) => {
            const node = await lostThen([RESET], limits);
            await pass(runs - 2);
            const before = valid();
            await pass(5000);

            // up until the last run, 1 ms after the one before it. No run follows it:
            // the next check is the one of the timer, an interval later
            expect([before, valid(), info().checkError]).toEqual([true, false, RESET_CHECK]);
            expect(askedAt(node)).toEqual(
                [0, 1000, ...Array.from({ length: runs }, (_, i) => 1000 + i)]);
            expect(changes().slice(-1)).toEqual([downBy('passive_lost', 'ECONNRESET')]);
        });

        it('a connectionLimit of 3 and 3 such runs, then a pass: the node is up', async () => {
            const node = await lostThen(
                [RESET, RESET, RESET, PASS, 'hang'], { connectionLimit: 3 });
            await pass(3);

            expect([valid(), askedAt(node)]).toEqual(
                [true, [0, 1000, 1000, 1001, 1002, 1003]]);
        });

        it('the checks after the one that decided come at the interval again', async () => {
            const node = await lostThen([RESET], { connectionLimit: 1 });
            await pass(10001);

            // the node is down: a check that fails the same way runs once per interval
            expect(askedAt(node)).toEqual([0, 1000, 1000, 1001, 6001, 11001]);
        });

        it('a new row gets the whole bound again', async () => {
            // down after 2 runs, back by the passes at 6001 and 11001. Then one more lost
            // connection: the check at once meets one too, and its second run passes
            const checks: Step[] = [RESET, RESET, PASS, PASS, RESET, RESET, PASS, 'hang'];
            const node = await lostThen(checks, { connectionLimit: 1 }, {});
            await pass(10001);
            const back = valid();
            await failed(direct());
            await pass(1);

            expect([back, valid()]).toEqual([true, true]);
            expect(askedAt(node).slice(6)).toEqual([11001, 11001, 11002]);
        });
    });

    describe('is over with the run that ends it', () => {
        // The check of the timer at 6001 uses the hold-off up, so the call at 7000 may
        // start a check again
        it('a row that a pass ended: a later lost connection starts a check again', async () => {
            const node = await lostThen([RESET, PASS, PASS, RESET, PASS, 'hang'], {}, {});
            await pass(6000);
            await failed(direct());
            await pass(0);

            expect(askedAt(node)).toEqual([0, 1000, 1000, 1001, 6001, 7000, 7000]);
        });

        it('a row that the bound ended: once the node is back, the same', async () => {
            // down at 1001, back by the pass at 6001, since rise is 1
            const checks: Step[] = [RESET, RESET, PASS, RESET, PASS, 'hang'];
            const node = await lostThen(checks, { connectionLimit: 1 }, { fall: 3, rise: 1 });
            await pass(6000);
            const back = valid();
            await failed(direct());
            await pass(0);

            expect([back, askedAt(node)]).toEqual([true, [0, 1000, 1000, 1001, 6001, 7000, 7000]]);
        });
    });

    describe('next to the other rules', () => {
        it('a refused connection after the lost one: down, and the check still runs again',
            async () => {
                // both calls at 1000, before the check. Its first run meets a lost
                // connection, its second passes: the first pass of two for the node
                const node = fakeNode([PASS, RESET, REFUSED, RESET, PASS, PASS, 'hang']);
                await start({ healthCheck: {} });
                await pass(1000);
                await failed(direct());
                await failed(direct());
                await pass(1);
                const afterRuns = [valid(), askedAt(node)];
                await pass(5000);

                expect(afterRuns).toEqual([false, [0, 1000, 1000, 1000, 1001]]);
                expect([valid(), askedAt(node).slice(-1)]).toEqual([true, [6001]]);
            });

        it('after a connect timeout the check runs again the same way', async () => {
            const node = fakeNode([PASS, TIMED_OUT, RESET, RESET, PASS, 'hang']);
            await start({ healthCheck: { fall: 3 } });
            await pass(1000);
            await failed(direct());
            await pass(2);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 1001, 1002]]);
        });

        it('after a connect timeout, such a run and a check that hangs: down, and why',
            async () => {
                fakeNode([PASS, TIMED_OUT, RESET, 'hang']);
                await start({ healthCheck: { fall: 3 } });
                await pass(1000);
                await failed(direct());
                await pass(5001);

                expect(changes().slice(-1)).toEqual([downBy('passive_timeout', 'ETIMEDOUT')]);
            });

        it('after a call that found no route the check runs again the same way', async () => {
            const node = fakeNode([PASS, NO_ROUTE, RESET, RESET, PASS, 'hang']);
            await start({ healthCheck: { fall: 3 } });
            await pass(1000);
            await failed(direct());
            await pass(2);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 1001, 1002]]);
        });

        it('after no route, such a run and a check that finds none either: down, and why',
            async () => {
                fakeNode([PASS, NO_ROUTE, RESET, NO_ROUTE, 'hang']);
                await start({ healthCheck: { fall: 3 } });
                await pass(1000);
                await failed(direct());
                await pass(1);

                expect(info().checkError).toEqual(NO_ROUTE_CHECK);
                expect(changes().slice(-1)).toEqual(
                    [downBy('passive_unreachable', 'ENETUNREACH')]);
            });

        it('a check of the timer that has to decide runs again as well', async () => {
            // the first lost connection starts a check, which passes. The second one, in
            // the same interval, starts none: the check of the timer at 6000 decides
            const node = await lostThen([PASS, RESET, RESET, RESET, PASS, 'hang']);
            await pass(1000);
            await failed(direct());
            await pass(4002);

            expect([valid(), askedAt(node)]).toEqual(
                [true, [0, 1000, 1000, 2000, 6000, 6001, 6002]]);
        });

        it('the runs are one check to the hold-off: the next lost connection starts none',
            async () => {
                const node = await lostThen([RESET, RESET, PASS, RESET, 'hang']);
                await pass(1000);
                await failed(direct());
                await pass(1);

                expect(askedAt(node)).toEqual([0, 1000, 1000, 1001, 1002, 2000]);
            });

        it('a lost connection of the app between two runs starts no check of its own',
            async () => {
                // As above: the check of the timer at 6000 decides, and the hold-off has
                // run down by then. A listener of the app loses a connection after the
                // first run, while the second one is about to start
                fakeNode([PASS, RESET, PASS, RESET, RESET, RESET, PASS, 'hang']);
                cluster = createPoolCluster({
                    ...settingsOf({ healthCheck: { fall: 3 } }), logs: { level: 'debug' }
                });
                await connect();
                let calls = 0;
                cluster.on('pool_check_failed', () => {
                    if (!calls++) direct().catch((): void => undefined);
                });
                for (const ms of [1000, 1000]) {
                    await pass(ms);
                    await failed(direct());
                }
                await pass(4001);

                // one line of a check that passive health started: the one at 1000
                const lines = logger.debug.mock.calls.map(([, meta]) => meta)
                    .filter(meta => meta && meta.passive);
                expect([valid(), calls, lines.length]).toEqual([true, 1, 1]);
            });

        it('a lost connection of the app while a run is out starts no check', async () => {
            const node = await lostThen([RESET, 'held', RESET, 'hang']);
            await pass(1);
            await failed(direct());
            await pass(1);
            const during = askedAt(node);
            node.held[0](null, PASS);
            await pass(1);

            expect([valid(), during]).toEqual([true, [0, 1000, 1000, 1001, 1001]]);
            expect(askedAt(node)).toEqual(during);
        });

        it('without a call of the app that failed, such a check counts as any other', async () => {
            const node = fakeNode([PASS, RESET, RESET, 'hang']);
            await start({ healthCheck: {} });
            await pass(10000);

            // two failed checks, each when it was due: down by fall
            expect([valid(), askedAt(node)]).toEqual([false, [0, 5000, 10000]]);
            expect(changes().slice(-1)).toEqual(
                [['warn', { pool, valid: false, reason: 'fall' }]]);
        });

        it('once the check decided, the next one that fails the same way waits its turn',
            async () => {
                const node = await lostThen([REFUSED, RESET, 'hang']);
                await pass(9999);

                expect([valid(), askedAt(node)]).toEqual([false, [0, 1000, 1000, 6000]]);
            });

        it('a refused connection of the app is no reason to run a check again', async () => {
            const { node } = await hit(REFUSED, 'query', {}, [RESET, 'hang']);
            await pass(4999);

            expect([valid(), askedAt(node)]).toEqual([false, [0, 1000, 1000]]);
        });

        it('an error that reads as both: the refusal of the server wins', async () => {
            const both = () => Object.assign(reset(), { errno: 1045 });
            const node = await lostThen([failure('changeUser', both), 'hang']);
            await pass(59999);
            const before = askedAt(node);
            await pass(1);

            expect([valid(), before]).toEqual([false, [0, 1000, 1000]]);
            expect(askedAt(node)).toEqual([0, 1000, 1000, 61000]);
        });

        it.each<[string, object]>([
            ['passive false', { healthCheck: { passive: false } }],
            ['no block', { timerCheckRange: { start: 5000, end: 5000 } }]
        ])('%s: a check that meets a lost connection never runs again', async (_n, settings) => {
            const node = fakeNode([PASS, RESET, RESET, RESET, 'hang']);
            await start(settings);
            await pass(1000);
            await failed(direct());
            await pass(9000);

            expect([valid(), askedAt(node)]).toEqual([false, [0, 1000, 5000, 10000]]);
        });

        it('a disconnect() before the next run: no run, the node is kept', async () => {
            const node = await lostThen([RESET, 'hang']);
            await pass(0);
            await cluster.disconnect();
            await pass(60000);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000]]);
        });

        it('a disconnect() while a run is out: its failure is dropped', async () => {
            const node = await lostThen([RESET, 'held', 'hang']);
            await pass(1);
            await cluster.disconnect();
            node.held[0](reset());
            await pass(60000);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 1001]]);
        });

        it('a new connect() starts the count of the runs again', async () => {
            // One run, then a disconnect() and a connect(), whose check passes. The next
            // lost connection: the check and one more run, as the limit of 1 allows
            const node = await lostThen(
                [RESET, 'held', PASS, RESET, RESET, RESET, 'hang'], { connectionLimit: 1 });
            await pass(1);
            await cluster.disconnect();
            await connect();
            await failed(direct());
            await pass(1);

            expect([valid(), node.asked.length]).toEqual([false, 8]);
        });
    });

    // connect() starts the count of the runs at 0, and the check of that connect() reads the
    // count before it ends. With a connectionLimit of 1 a count of 1 left from before would
    // let the check decide where it has a run left
    it('a lost call while the check of a new connect() is out: that check has its run',
        async () => {
            const node = await lostThen(
                [RESET, 'held', RESET, PASS, 'hang'], { connectionLimit: 1 });
            // the check at once met a lost connection: one run is counted, and about to start
            await pass(0);
            await cluster.disconnect();
            cluster.connect().catch((): void => undefined);
            // the check of the new connect() is out. A call loses its connection, then
            // that check meets a lost one as well
            await failed(direct());
            node.held[0](reset());
            await pass(1);

            // it ran again and passed. Were the old count kept, it would have decided
            expect([valid(), node.asked.length]).toEqual([true, 6]);
        });

    describe('is a failed check to the app', () => {
        it('each run sets checkError, and the answer clears it', async () => {
            const node = await lostThen([RESET, 'held', 'hang']);
            await pass(1);
            const during = info().checkError;
            node.held[0](null, PASS);
            await pass(0);

            expect([during, info().checkError]).toEqual([RESET_CHECK, undefined]);
        });

        it('each run emits pool_check_failed', async () => {
            const seen: string[] = [];
            const broken = failure('changeUser', network('EPIPE', -32, 'write'));
            await lostThen([RESET, broken, PASS, 'hang']);
            cluster.on('pool_check_failed', (args: any[]) => seen.push(args[0].code));
            await pass(2);

            expect(seen).toEqual(['ECONNRESET', 'EPIPE']);
        });

        it('each run logs one debug line with its number and the code', async () => {
            fakeNode([PASS, RESET, RESET, RESET, PASS, 'hang']);
            cluster = createPoolCluster({
                ...settingsOf({ healthCheck: {} }), logs: { level: 'debug' }
            });
            await connect();
            await failed(direct());
            await pass(2);

            const lines = logger.debug.mock.calls.map(([, meta]) => meta)
                .filter(meta => meta && meta.rerun);
            expect(lines).toEqual([
                { pool, rerun: 1, code: 'ECONNRESET' }, { pool, rerun: 2, code: 'ECONNRESET' }
            ]);
        });

        it('no line about the state of a node that stayed up', async () => {
            await lostThen([RESET, RESET, PASS, 'hang']);
            await pass(2);

            expect(changes()).toEqual([up1]);
        });
    });
});

describe('passive health: what never counts', () => {
    const mark = (error: any, fields: object) => () => Object.assign(error, fields);
    const plain = (message: string) => () => new Error(message);
    const fatal = (message: string, code?: string) => () => {
        return Object.assign(new Error(message), code ? { code, fatal: true } : { fatal: true });
    };
    // Each as mysql2 3.24.6 hands it out. An error packet at a change of user is fatal there
    const NEVER: [string, Step][] = [
        ['a deadlock or a certification failure, errno 1213', failure('query', deadlock)],
        ['a lock wait timeout, errno 1205',
            failure('query', packet(1205, 'ER_LOCK_WAIT_TIMEOUT'))],
        ['a query the server interrupted, errno 1317',
            failure('query', packet(1317, 'ER_QUERY_INTERRUPTED', '70100'))],
        ['a query the server timed out, errno 3024',
            failure('query', packet(3024, 'ER_QUERY_TIMEOUT'))],
        ['a syntax error, errno 1064', failure('query', packet(1064, 'ER_PARSE_ERROR', '42000'))],
        ['a constraint error, errno 1062',
            failure('query', packet(1062, 'ER_DUP_ENTRY', '23000'))],
        ['a node that is not ready, errno 1047',
            failure('query', packet(1047, 'ER_UNKNOWN_COM_ERROR', '08S01'))],
        ['a login refused on a new connection, errno 1045', failure('open', denied)],
        ['a login refused on an open connection, errno 1045 and fatal',
            failure('changeUser', denied)],
        ['too many connections at the login, errno 1040',
            failure('open', packet(1040, 'ER_CON_COUNT_ERROR', '08004'))],
        ['too many connections at a change of user, errno 1040 and fatal',
            failure('changeUser', packet(1040, 'ER_CON_COUNT_ERROR', '08004'))],
        ['an account at its limit of connections, errno 1226, at the login',
            failure('open', limit)],
        ['an account at its limit, errno 1226, at a change of user and fatal',
            failure('changeUser', limit)],
        ['an account at its limit of queries, errno 1226, as the answer to a query',
            failure('query', limit)],
        ['the query timeout of mysql2, PROTOCOL_SEQUENCE_TIMEOUT', failure('query',
            mark(new Error('Query inactivity timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }))],
        ['a server without TLS, HANDSHAKE_NO_SSL_SUPPORT', failure('open',
            fatal('Server does not support secure connection', 'HANDSHAKE_NO_SSL_SUPPORT'))],
        ['a TLS handshake that failed, HANDSHAKE_SSL_ERROR',
            failure('open', fatal('self-signed certificate', 'HANDSHAKE_SSL_ERROR'))],
        ['an auth plugin that failed, AUTH_SWITCH_PLUGIN_ERROR',
            failure('open', fatal('plugin failed', 'AUTH_SWITCH_PLUGIN_ERROR'))],
        ['a protocol error, PROTOCOL_ERROR',
            failure('query', fatal('Unexpected packet', 'PROTOCOL_ERROR'))],
        ['a command on a closed connection, fatal and with no code', failure('query',
            fatal("Can't add new command when connection is in closed state"))],
        ['a pool that is closed', failure('open', plain('Pool is closed.'))],
        ['a queue at its limit', failure('open', plain('Queue limit reached.'))],
        ['a pool that does not wait', failure('open', plain('No connections available.'))],
        ['the code of the not-connected error of the package', failure('open',
            mark(new Error('pool is not connected yet'), { code: 'POOL_NOT_CONNECTED' }))],
        ['a code of the list that is not fatal',
            failure('open', mark(refused(), { fatal: undefined }))],
        ['a code of the list with a fatal that is no boolean',
            failure('query', mark(reset(), { fatal: 1 }))],
        ['a code of the list next to an errno of a server',
            failure('open', mark(refused(), { errno: 1045 }))],
        ['a lost connection next to an errno of a server',
            failure('query', mark(reset(), { errno: 1213 }))],
        ['a fatal error whose code is no string',
            failure('open', mark(refused(), { code: 111 }))],
        ['a rejection that is no object', failure('open', () => 'ECONNREFUSED')],
        // fatal and with no errno of a server, as every code that counts is
        ...LEFT_OUT.flatMap(([name, code, errno, syscall]): [string, Step][] => [
            [name + ', ' + code + ', in place of a connection',
                failure('open', network(code, errno, syscall))],
            [name + ', ' + code + ', on a connection that was handed out',
                failure('query', network(code, errno, syscall))]
        ])
    ];
    // the app's own calls: getConnection() asks for a connection and sends nothing on it
    const callsOf = (step: Step): Call[] => {
        return isFailure(step) && step.at === 'open' ? CALLS : ['query', 'multiStatementQuery'];
    };
    const ROWS = NEVER.flatMap(([name, step]) => {
        return callsOf(step).map((call): [string, Call, Step] => [name, call, step]);
    });

    // every check after the call fails. With fall 2 the node is out at the second of them
    it.each(ROWS)('%s, from %s: the node stays up and no check starts', async (_n, call, step) => {
        const { node } = await hit(step, call, {}, [REFUSED]);
        await pass(0);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000]]);
    });

    it.each(ROWS)('%s, from %s: the next check comes when it was due', async (_n, call, step) => {
        const { node } = await hit(step, call, {}, [REFUSED]);
        await pass(4000);

        // that check failed, and it is the first failure of two: the node is still up
        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 5000]]);
    });

    it('the timeout of the package for a change of user that hangs', async () => {
        const node = fakeNode([PASS, 'stuck', REFUSED]);
        await start({ queryTimeout: 2000, healthCheck: {} });
        await pass(1000);
        const call = failed(direct());
        await pass(2000);

        expect((await call).code).toBe('PROTOCOL_SEQUENCE_TIMEOUT');
        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000]]);
    });

    it('an error the app passed to failWaiting(), though it reads as a refused one', async () => {
        const node = fakeNode([PASS, 'waits', REFUSED]);
        await start({ healthCheck: {} });
        const call = failed(direct());

        expect(cluster.failWaiting(0, refused())).toBe(1);
        await pass(0);

        expect((await call).code).toBe('ECONNREFUSED');
        expect([valid(), askedAt(node)]).toEqual([true, [0, 0]]);
    });

    it('a query of a node that is not connected yet', async () => {
        fakeNode([PASS]);
        cluster = createPoolCluster(settingsOf({ healthCheck: {} }));

        const error = await failed(direct());
        await pass(0);

        expect([error.code, nodes['node-a'].asked]).toEqual(['POOL_NOT_CONNECTED', []]);
    });

    it('a statement of a transaction that deadlocks and is rolled back', async () => {
        const { node, error } = await hit(failure(SQLS[0], deadlock), 'multiStatementQuery');
        await pass(0);

        expect(node.sqls.slice(-2)).toEqual([SQLS[0], 'ROLLBACK']);
        expect([error.errno, valid(), askedAt(node)]).toEqual([1213, true, [0, 1000]]);
    });
});

describe('passive health: the check itself never counts', () => {
    // One failed check of a node with fall 3. Were it counted as a failure of the app, a
    // refused connection would take the node down and a lost one would start a check
    const CHECKS: [string, Step][] = [
        ...CONNECT.map(([code, errno, syscall]): [string, Step] => {
            return [code + ' at its request for a connection',
                failure('open', network(code, errno, syscall))];
        }),
        ...UNREACHABLE.map(([code, errno, syscall]): [string, Step] => {
            return [code + ' at its request for a connection',
                failure('open', network(code, errno, syscall))];
        }),
        ['ETIMEDOUT at its request for a connection', TIMED_OUT],
        ...LOST.map(([code, errno, syscall]): [string, Step] => {
            return [code + ' under its status query',
                failure('query', network(code, errno, syscall))];
        }),
        ['ECONNRESET at its change of user', failure('changeUser', reset)]
    ];

    it.each(CHECKS)('a check that fails with %s leaves the node up', async (_name, step) => {
        const node = fakeNode([PASS, step, 'hang']);
        await start({ healthCheck: { fall: 3 } });
        await pass(5000);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 5000]]);
    });

    it.each(CHECKS)('a check that fails with %s is followed by the interval', async (_n, step) => {
        const node = fakeNode([PASS, step, step, PASS]);
        await start({ healthCheck: { fall: 3 } });
        await pass(15000);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 5000, 10000, 15000]]);
    });

    it('a query of the app that reads as the status query is a query of the app', async () => {
        const node = fakeNode([PASS, REFUSED, PASS]);
        await start({ healthCheck: { fall: 3 } });
        const options = { redis: false, timeout: 5000 };

        await failed(cluster.pools[0].query('SHOW GLOBAL STATUS;', options));

        expect([valid(), node.asked.length]).toEqual([false, 2]);
    });

});

describe('passive health: one check, however many calls fail', () => {
    const burst = (count: number) => Promise.all(
        Array.from({ length: count }, () => failed(direct()))
    );

    it.each<[string, Step]>([
        ['refused connections', REFUSED], ['lost connections', RESET]
    ])('20 %s at once start one check', async (_name, step) => {
        const node = fakeNode([PASS, ...Array(20).fill(step), 'hang']);
        await start({ healthCheck: { fall: 3 } });
        await burst(20);
        await pass(0);

        expect(node.asked).toHaveLength(22);
    });

    it('20 lost connections over two seconds start one check, which passes', async () => {
        const node = fakeNode([PASS, RESET, PASS, ...Array(19).fill(RESET), PASS]);
        await start({ healthCheck: {} });
        for (let i = 0; i < 20; i++) {
            await burst(1);
            await pass(100);
        }

        // the check of connect(), 20 calls and one check: right after the first call
        expect(node.asked).toHaveLength(22);
        expect([valid(), askedAt(node).slice(0, 4)]).toEqual([true, [0, 0, 0, 100]]);
    });

    it('a refused connection while a check is out: down at once, no second check', async () => {
        const node = fakeNode([PASS, 'held', REFUSED, 'hang']);
        await start({ healthCheck: { fall: 3 } });
        await pass(5000);
        await burst(1);
        const atOnce = valid();
        await pass(0);

        expect([atOnce, askedAt(node)]).toEqual([false, [0, 5000, 5000]]);
    });

    it('a pass of the check that was out is one pass of rise for that node', async () => {
        const node = fakeNode([PASS, 'held', REFUSED, PASS]);
        await start({ healthCheck: {} });
        await pass(5000);
        await burst(1);
        node.held[0](null, PASS);
        await pass(0);
        const afterOne = valid();
        await pass(5000);

        expect([afterOne, valid(), askedAt(node)]).toEqual([false, true, [0, 5000, 5000, 10000]]);
    });

    it('a lost connection while a check is out: that check takes the node down', async () => {
        const node = fakeNode([PASS, 'held', RESET, 'hang']);
        await start({ healthCheck: { fall: 3 } });
        await pass(5000);
        await burst(1);
        const atOnce = valid();
        node.held[0](refused());
        await pass(0);

        expect([atOnce, valid(), askedAt(node)]).toEqual([true, false, [0, 5000, 5000]]);
    });

    // An app that calls connect() on a connected cluster has two checks out for a while:
    // the one of the timer and the one of the new connect()
    it('a second connect() with a check out: no check starts while one of them is out',
        async () => {
            const node = fakeNode([PASS, 'held', PASS, RESET, 'hang']);
            await start({ healthCheck: { fall: 3 } });
            await pass(5000);
            await connect();
            await burst(1);
            await pass(0);

            // the check of the timer, still out, the check of the second connect(), which
            // passed, and the call
            expect(askedAt(node)).toEqual([0, 5000, 5000, 5000]);
        });

    it('a lost connection while a check is out that passes: up, and nothing is kept', async () => {
        const node = fakeNode([PASS, 'held', RESET, REFUSED, 'hang']);
        await start({ healthCheck: { fall: 3 } });
        await pass(5000);
        await burst(1);
        node.held[0](null, PASS);
        await pass(5000);

        // the check at 10000 failed: the first of three, not one a lost connection waits for
        expect([valid(), askedAt(node)]).toEqual([true, [0, 5000, 5000, 10000]]);
    });
});

describe('passive health: a node that is down already', () => {
    it('a refused connection starts no check and logs no line', async () => {
        const { node } = await hit(REFUSED, 'query', {}, [REFUSED, REFUSED, 'hang']);
        await pass(1000);
        await failed(direct());
        await pass(0);

        expect(askedAt(node)).toEqual([0, 1000, 1000, 2000]);
        expect(changes()).toHaveLength(2);
    });

    it('a lost connection starts no check', async () => {
        const { node } = await hit(REFUSED, 'query', {}, [REFUSED, RESET, 'hang']);
        await pass(1000);
        await failed(direct());
        await pass(0);

        expect(askedAt(node)).toEqual([0, 1000, 1000, 2000]);
    });

    it('a node the checks took down: a refused connection starts no check', async () => {
        // down at 10000, by the second failed check. No check started since the one at 10000
        const node = fakeNode([PASS, REFUSED, REFUSED, REFUSED, 'hang']);
        await start({ healthCheck: {} });
        await pass(11000);
        await failed(direct());
        await pass(0);

        expect([valid(), askedAt(node)]).toEqual([false, [0, 5000, 10000, 11000]]);
    });

    it('its next check comes one interval after the one passive health started', async () => {
        const { node } = await hit(REFUSED, 'query', {}, [REFUSED, REFUSED, 'hang']);
        await pass(1000);
        await failed(direct());
        await pass(3999);
        const before = node.asked.length;
        await pass(1);

        expect([before, askedAt(node)]).toEqual([4, [0, 1000, 1000, 2000, 6000]]);
    });

    it('a node that was never up stays as it is, and its first pass brings it up', async () => {
        const node = fakeNode([REFUSED, REFUSED, PASS]);
        await start({ healthCheck: { rise: 3 } });
        await pass(1000);
        await failed(direct());
        await pass(0);
        const atOnce = [valid(), askedAt(node)];
        await pass(4000);

        expect(atOnce).toEqual([false, [0, 1000]]);
        expect([valid(), changes()]).toEqual([true, [up1]]);
    });

    it('a node up from before a new connect() goes down, its first pass is enough', async () => {
        const node = fakeNode([PASS, REFUSED, REFUSED, PASS]);
        await start({ healthCheck: { rise: 3 } });
        await cluster.disconnect();
        await connect();
        // the check of the new connect() failed, the first of two: still up
        const before = valid();
        await failed(direct());
        const atOnce = valid();
        await pass(0);

        expect([before, atOnce, valid(), node.asked.length]).toEqual([true, false, true, 4]);
    });
});

describe('passive health: one check between two checks of the timer', () => {
    // the first lost connection starts a check, which passes. One more follows 1000 ms later
    const twice = async (block: object, second: Step, after: Step[]) => {
        const hitOnce = await hit(RESET, 'query', block, [PASS, second, ...after]);
        await pass(1000);
        await failed(direct());
        await pass(0);
        return hitOnce.node;
    };

    it('a second lost connection in the same interval starts no check', async () => {
        const node = await twice({}, RESET, [PASS]);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000, 2000]]);
    });

    it('but the check of the timer takes the node down when it fails', async () => {
        const node = await twice({ fall: 3 }, RESET, [REFUSED]);
        await pass(3999);
        const before = valid();
        await pass(1);

        expect([before, valid()]).toEqual([true, false]);
        expect(askedAt(node)).toEqual([0, 1000, 1000, 2000, 6000]);
    });

    it('a refused connection in the same interval: the node is down, with no check', async () => {
        const node = await twice({}, REFUSED, [PASS]);

        expect([valid(), askedAt(node)]).toEqual([false, [0, 1000, 1000, 2000]]);
    });

    it('after the check of the timer a lost connection starts a check again', async () => {
        const node = await twice({}, RESET, [PASS, RESET, PASS]);
        await pass(4000);
        await pass(1000);
        await failed(direct());
        await pass(0);

        expect(askedAt(node)).toEqual([0, 1000, 1000, 2000, 6000, 7000, 7000]);
    });
});

describe('passive health: after the check it started', () => {
    it.each<[string, Step, Step, number]>([
        ['a refused connection and a check that passes', REFUSED, PASS, 5000],
        ['a refused connection and a check that fails', REFUSED, REFUSED, 5000],
        ['a lost connection and a check that passes', RESET, PASS, 5000],
        ['a lost connection and a check that fails', RESET, REFUSED, 5000],
        ['a refused connection and a check a validator says no to', REFUSED, NO, 5000],
        ['a refused connection and a check whose login is refused', REFUSED, DENIED, 60000],
        ['a lost connection and a check whose login is refused', RESET, DENIED_OPEN, 60000]
    ])('%s: the next check comes %i ms later', async (_name, step, check, wait) => {
        const { node } = await hit(step, 'query', {}, [check, 'hang']);
        await pass(wait - 1);
        const before = node.asked.length;
        await pass(1);

        expect([before, askedAt(node)]).toEqual([3, [0, 1000, 1000, 1000 + wait]]);
    });

    it('the check of the timer that was due is gone: the next counts from this one', async () => {
        const { node } = await hit(RESET, 'query', {}, [PASS, PASS, PASS]);
        await pass(10000);

        // without passive health: 0, 1000, 5000, 10000
        expect(askedAt(node)).toEqual([0, 1000, 1000, 6000, 11000]);
    });

    it('a check that takes 1200 ms: the interval starts when it ends', async () => {
        const { node } = await hit(RESET, 'query', {}, ['held', PASS]);
        await pass(1200);
        node.held[0](null, PASS);
        await pass(5000);

        expect(askedAt(node)).toEqual([0, 1000, 1000, 7200]);
    });
});

describe('passive health: next to the slow pace of a refused login', () => {
    // A check the server refused takes the node down, and the checks after it wait
    // authRetryInterval, 60000 here, until one of them gets an answer. Passive health
    // does nothing for a node that is down, so it starts no check during that pace
    it('no call of the app starts a check while a refused node waits', async () => {
        // refused at 5000. The check at 65000 hangs for its 5000, so the pace holds
        const node = fakeNode([PASS, DENIED, REFUSED, RESET, 'hang', REFUSED, 'hang']);
        await start({ healthCheck: {} });
        for (const ms of [6000, 1000, 64000]) {
            await pass(ms);
            await failed(direct());
        }
        await pass(59000);

        // the calls at 6000, 7000 and 71000, and one check every 60000 plus the timeout
        expect(askedAt(node)).toEqual([0, 5000, 6000, 7000, 65000, 71000, 130000]);
    });

    it.each<[string, Step, Step]>([
        ['a refused connection, then a check the server refuses', REFUSED, DENIED],
        ['a lost connection, then a check the server refuses', RESET, DENIED_OPEN]
    ])('%s: the slow pace starts, and holds over a timeout', async (_name, step, check) => {
        const { node } = await hit(step, 'query', {}, [check, 'hang', 'hang', PASS]);
        await pass(190000);

        // refused at 1000. The checks at 61000 and 126000 hang for 5000 each
        expect(valid()).toBe(false);
        expect(askedAt(node)).toEqual([0, 1000, 1000, 61000, 126000, 191000]);
    });

    it('the check it started is refused: the wait follows a longer interval', async () => {
        // authRetryInterval is left out, so it is the interval of 120000
        const { node } = await hit(REFUSED, 'query', { interval: 120000 }, [DENIED, 'hang']);
        await pass(119999);
        const before = node.asked.length;
        await pass(1);

        expect([before, askedAt(node)]).toEqual([3, [0, 1000, 1000, 121000]]);
    });

    it('once the node is back, a lost connection starts a check at once again', async () => {
        // refused at 5000, passes at 65000 and 70000, the call at 71000
        const node = fakeNode([PASS, DENIED, PASS, PASS, RESET, PASS]);
        await start({ healthCheck: {} });
        await pass(71000);
        const back = valid();
        await failed(direct());
        await pass(5000);

        expect(back).toBe(true);
        expect(askedAt(node)).toEqual([0, 5000, 65000, 70000, 71000, 71000, 76000]);
    });

    // A walk of calls of the app, waits and reconnects, the same on every run. It reads the
    // private flag of the slow pace: no step may leave a node up while that flag is set,
    // since an up node is the only one passive health starts a check for
    const walk = async (steps: number) => {
        let seed = 7;
        const pick = <T>(list: T[]): T => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            // the high bits: the low ones of such a generator repeat after a few draws
            return list[Math.floor(seed / 65536) % list.length];
        };
        const checks: Step[] = [PASS, PASS, NO, REFUSED, RESET, 'hang', DENIED, DENIED_OPEN,
            TIMED_OUT, failure('open', tooMany), failure('query', limit)];
        // half of the calls of the app pass
        const calls: Step[] = [PASS, PASS, PASS, PASS, PASS, REFUSED, RESET, DENIED,
            failure('query', deadlock), TIMED_OUT];
        const node = fakeNode([PASS]);
        await start({ healthCheck: { rise: 1 } });
        const seen = { slow: 0, up: 0, upAndSlow: 0 };
        for (let i = 0; i < steps; i++) {
            node.plan = [pick(calls), pick(checks)];
            await direct().catch((): void => undefined);
            await pass(pick([0, 1000, 5000, 60000]));
            if (i % 40 === 39) {
                node.plan = [pick<Step>([PASS, DENIED, REFUSED])];
                await cluster.disconnect();
                await connect();
            }
            const slow = cluster.pools[0].status._slowRetry;
            seen.slow += slow ? 1 : 0;
            seen.up += valid() ? 1 : 0;
            seen.upAndSlow += slow && valid() ? 1 : 0;
        }
        return seen;
    };

    it('a node is never up while the slow pace holds, over a walk of 600 steps', async () => {
        const seen = await walk(600);

        expect(seen.upAndSlow).toBe(0);
        // and the walk was in both states often enough to tell
        expect([seen.slow > 50, seen.up > 50]).toEqual([true, true]);
    });
});

describe('passive health: fall and a lost connection', () => {
    // The node after each check, U for up and d for down. The first one is the check that
    // the lost connection started, the others come from the timer
    const upAfterChecks = async (block: object, checks: Step[], before: Step[] = []) => {
        const node = fakeNode([PASS, ...before, RESET, ...checks, 'hang']);
        await start({ healthCheck: block });
        await pass(before.length * 5000 + 1000);
        await failed(direct());
        const seen: boolean[] = [];
        for (let i = 0; i < checks.length; i++) {
            await pass(i ? 5000 : 0);
            seen.push(valid());
        }
        expect(node.asked).toHaveLength(2 + before.length + checks.length);
        return seen.map(isUp => (isUp ? 'U' : 'd')).join(' ');
    };

    it.each<[string, object, Step[], string]>([
        ['fall 1: the check fails', { fall: 1 }, [REFUSED], 'd'],
        ['fall 2: the check fails', { fall: 2 }, [REFUSED], 'd'],
        ['fall 3: the check fails', { fall: 3 }, [REFUSED], 'd'],
        ['fall 3: a validator says no', { fall: 3 }, [NO], 'd'],
        ['fall 2: the check passes, one failed check after it', {}, [PASS, REFUSED], 'U U'],
        ['fall 2: the check passes, two failed checks after it',
            {}, [PASS, REFUSED, REFUSED], 'U U d'],
        ['fall 3: the check passes, two failed checks after it',
            { fall: 3 }, [PASS, REFUSED, REFUSED], 'U U U'],
        ['fall 3: the check passes, three failed checks after it',
            { fall: 3 }, [PASS, REFUSED, REFUSED, REFUSED], 'U U U d']
    ])('%s', async (_name, block, checks, wanted) => {
        expect(await upAfterChecks(block, checks)).toBe(wanted);
    });

    it('fall 3: the check hangs, and the node is down at its timeout of 1000', async () => {
        await hit(RESET, 'query', { fall: 3, timeout: 1000 }, ['hang']);
        await pass(999);
        const before = valid();
        await pass(1);

        expect([before, valid()]).toEqual([true, false]);
    });

    it('fall 3, one failed check before the lost connection: the check fails', async () => {
        expect(await upAfterChecks({ fall: 3 }, [REFUSED], [REFUSED])).toBe('d');
    });

    it('fall 3, one failed check before it: a pass resets that run as any pass', async () => {
        const seen = await upAfterChecks({ fall: 3 }, [PASS, REFUSED, REFUSED], [REFUSED]);

        expect(seen).toBe('U U U');
    });
});

describe('passive health: coming back', () => {
    // A refused connection at 1000, and from then on every check passes: the one passive
    // health started at 1000, then one every 5000 ms. The node at 1000 before that check,
    // at 1000 after it, and at 5999, 6000, 10999 and 11000
    it.each<[string, object, string]>([
        ['rise 1: back with the check passive health started', { rise: 1 }, 'd U U U U U'],
        ['the default rise of 2: back one interval later', {}, 'd d d U U U'],
        ['rise 3: back two intervals later', { rise: 3 }, 'd d d d d U']
    ])('%s', async (_name, block, wanted) => {
        const { node } = await hit(REFUSED, 'query', block, [PASS]);
        const seen = [valid()];
        for (const ms of [0, 4999, 1, 4999, 1]) {
            await pass(ms);
            seen.push(valid());
        }

        expect(seen.map(isUp => (isUp ? 'U' : 'd')).join(' ')).toBe(wanted);
        expect(askedAt(node)).toEqual([0, 1000, 1000, 6000, 11000]);
    });

    it('a failed check between the passes starts the run of passes again', async () => {
        await hit(REFUSED, 'query', {}, [PASS, REFUSED, PASS, PASS]);
        const seen: boolean[] = [];
        for (let i = 0; i < 4; i++) {
            await pass(i ? 5000 : 0);
            seen.push(valid());
        }

        expect(seen).toEqual([false, false, false, true]);
    });

    it('no query of the app that passes brings the node back', async () => {
        const { node } = await hit(REFUSED, 'query', { rise: 3 }, [PASS]);
        await pass(0);

        await expect(direct()).resolves.toEqual(PASS);

        expect([valid(), node.asked.length]).toEqual([false, 4]);
    });

    it('the passes of a node that was up do not count after the mark', async () => {
        // three passes, then the refused connection: the check it starts is pass one of two
        const node = fakeNode([PASS, PASS, PASS, REFUSED, PASS]);
        await start({ healthCheck: {} });
        await pass(10000);
        await failed(direct());
        await pass(0);

        expect([valid(), askedAt(node)]).toEqual([false, [0, 5000, 10000, 10000, 10000]]);
    });
});

describe('passive health: passive false, and a node without the block', () => {
    const OFF: [string, object][] = [
        ['a block with passive false', { healthCheck: { passive: false } }],
        ['no block', { timerCheckRange: { start: 5000, end: 5000 } }]
    ];
    describe.each(OFF)('%s', (_name, settings) => {
        it.each(CALLS)('a refused connection of %s changes nothing', async call => {
            const node = fakeNode([PASS, REFUSED, REFUSED]);
            await start(settings);
            await pass(1000);
            await failed(app[call]());
            await pass(0);

            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000]]);
        });

        it('a lost connection starts no check and shortens no fall', async () => {
            const node = fakeNode([PASS, RESET, REFUSED, REFUSED]);
            await start(settings);
            await pass(1000);
            await failed(app.query());
            await pass(4000);
            const afterOne = valid();
            await pass(5000);

            // out at the second failed check, each at the time it was due
            expect([afterOne, valid()]).toEqual([true, false]);
            expect(askedAt(node)).toEqual([0, 1000, 5000, 10000]);
        });

        it('logs no line about it', async () => {
            fakeNode([PASS, REFUSED, PASS]);
            cluster = createPoolCluster({ ...settingsOf(settings), logs: { level: 'debug' } });
            await connect();
            await failed(direct());
            await pass(0);

            const about = (meta: any) => meta && (meta.passive || /passive/.test(meta.reason));
            expect(Object.values(logger).flatMap(log => log.mock.calls)
                .filter(([, meta]) => about(meta))).toEqual([]);
        });
    });

    it('passive true is the default of a block', async () => {
        await hit(REFUSED, 'query', { passive: true });
        const written = valid();
        await cluster.disconnect();
        await hit(REFUSED);

        expect([written, valid()]).toEqual([false, false]);
    });

    it('in one cluster only the host with the block is moved', async () => {
        const hosts = [{ host: 'node-a' }, { host: 'node-b', healthCheck: {} }];
        const a = fakeNode([PASS, REFUSED, 'hang'], 'node-a');
        const b = fakeNode([PASS, REFUSED, 'hang'], 'node-b');
        await start({}, hosts);
        await failed(direct(0));
        await failed(direct(1));
        await pass(0);

        expect([valid(0), valid(1)]).toEqual([true, false]);
        expect([a.asked.length, b.asked.length]).toEqual([2, 3]);
    });

    it('a host can turn it off under defaults that have the block', async () => {
        const hosts = [{ host: 'node-a', healthCheck: { passive: false } }, { host: 'node-b' }];
        fakeNode([PASS, REFUSED, 'hang'], 'node-a');
        fakeNode([PASS, REFUSED, 'hang'], 'node-b');
        await start({ healthCheck: {} }, hosts);
        await failed(direct(0));
        await failed(direct(1));

        expect([valid(0), valid(1)]).toEqual([true, false]);
    });
});

describe('passive health: disconnect() and a new connect()', () => {
    it('a disconnect() before the check started: no check, the node is kept', async () => {
        const { node } = await hit(RESET, 'query', {}, [REFUSED]);
        await cluster.disconnect();
        await pass(60000);

        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000]]);
    });

    it('a disconnect() while that check is out: its failure is dropped', async () => {
        const { node } = await hit(RESET, 'query', {}, ['held', PASS]);
        await pass(0);
        await cluster.disconnect();
        node.held[0](refused());
        await pass(60000);

        expect([valid(), info().checkError, node.asked.length]).toEqual([true, undefined, 3]);
    });

    it('a call that fails after the disconnect() changes nothing', async () => {
        const node = fakeNode([PASS, 'held', REFUSED]);
        await start({ healthCheck: {} });
        const call = failed(direct());
        await cluster.disconnect();
        node.held[0](reset());
        await call;
        await pass(60000);

        expect([valid(), node.asked.length]).toEqual([true, 2]);
    });

    it('a refused connection after the disconnect() leaves the node as it was', async () => {
        const node = fakeNode([PASS, 'opening', REFUSED]);
        await start({ healthCheck: {} });
        const call = failed(app.getConnection());
        await cluster.disconnect();
        node.opening[0](refused());
        await call;

        expect(valid()).toBe(true);
    });

    it('a new connect() forgets a lost connection from before the disconnect()', async () => {
        const { node } = await hit(RESET, 'query', { fall: 3 }, [REFUSED, 'hang']);
        await cluster.disconnect();
        await connect();

        // the check of the new connect() failed: the first of three, so the node stays up
        expect([valid(), askedAt(node)]).toEqual([true, [0, 1000, 1000]]);
    });

    it('after a new connect() a lost connection starts a check again', async () => {
        // the check of the first lost connection never starts: the disconnect() comes first
        const { node } = await hit(RESET, 'query', {}, [PASS, RESET, PASS]);
        await cluster.disconnect();
        await connect();
        await pass(500);
        await failed(direct());
        await pass(0);

        // the call, the check of the new connect(), then the next call and its check
        expect(askedAt(node)).toEqual([0, 1000, 1000, 1500, 1500]);
    });

    it('a node passive health took down is up with the one pass of a new connect()', async () => {
        await hit(REFUSED, 'query', { rise: 3 }, [REFUSED, PASS]);
        await pass(0);
        const before = valid();
        await cluster.disconnect();
        await connect();

        expect([before, valid()]).toEqual([false, true]);
    });
});

describe('passive health: the cluster after a call that failed', () => {
    const twoNodes = async (first: Step, call: 'query' | 'getConnection') => {
        // node-a has the lower load score, so the cluster asks it first
        const a = fakeNode([up(1), first, REFUSED], 'node-a');
        const b = fakeNode([up(9)], 'node-b');
        await start({ healthCheck: {} }, [{ host: 'node-a' }, { host: 'node-b' }]);
        const result = await app[call]().then((value: any) => value, (error: any) => error);
        return { a, b, result };
    };

    it('the retry of a query goes to the next node, and passes', async () => {
        const { a, b, result } = await twoNodes(REFUSED, 'query');

        expect(result).toEqual(up(9));
        expect([valid(0), valid(1), a.sqls.length, b.sqls]).toEqual(
            [false, true, 1, ['SHOW GLOBAL STATUS;', 'SELECT 1']]);
    });

    it('the queries after it do not ask the node that went down', async () => {
        const { a } = await twoNodes(REFUSED, 'query');
        await pass(0);
        const before = a.asked.length;

        for (let i = 0; i < 5; i++) await app.query();

        // the check of connect(), the query and the check passive health started
        expect([before, a.asked.length]).toEqual([3, 3]);
    });

    it('a getConnection() has no retry: it rejects with the error and the node', async () => {
        const { result } = await twoNodes(REFUSED, 'getConnection');

        expect([result.code, result.fatal, result.nodeId]).toEqual(['ECONNREFUSED', true, 0]);
        expect([valid(0), valid(1)]).toEqual([false, true]);
    });

    it('the next getConnection() takes a connection of the other node', async () => {
        await twoNodes(REFUSED, 'getConnection');

        expect((await app.getConnection()).nodeId).toBe(1);
    });

    it('a lost connection leaves the node in rotation when its check passes', async () => {
        const { a } = await twoNodes(RESET, 'query');
        a.plan = [up(1)];
        await pass(0);
        const before = a.sqls.length;
        await app.query();

        expect([valid(0), a.sqls.length - before]).toEqual([true, 1]);
    });
});

describe('passive health: an aborted getConnection()', () => {
    const aborting = async () => {
        const node = fakeNode([PASS, 'opening', 'hang']);
        await start({ healthCheck: {} });
        const controller = new AbortController();
        const call = failed(cluster.getConnection({ signal: controller.signal }));
        await pass(0);
        return { node, controller, call };
    };

    it('the abort is no failure, though its reason reads as a refused connection', async () => {
        const { node, controller, call } = await aborting();
        const reason = refused();
        controller.abort(reason);
        await pass(0);

        expect([await call, valid(), node.asked.length]).toEqual([reason, true, 2]);
    });

    it('a connection that then cannot be opened still counts', async () => {
        const { node, controller, call } = await aborting();
        controller.abort();
        await call;
        node.opening[0](refused());
        await pass(0);

        expect([valid(), node.asked.length]).toEqual([false, 3]);
    });

    it('a login the server then refuses does not', async () => {
        const { node, controller, call } = await aborting();
        controller.abort();
        await call;
        node.opening[0](denied());
        await pass(0);

        expect([valid(), node.asked.length]).toEqual([true, 2]);
    });
});

describe('passive health: the log', () => {
    const down = (reason: string, code: string) => {
        return ['warn', { pool, valid: false, reason, code }];
    };
    const downFall = ['warn', { pool, valid: false, reason: 'fall' }];
    const downRefusal = [
        'warn', { pool, valid: false, reason: 'refusal', errno: 1045, retryIn: 60000 }
    ];
    const upRise = ['info', { pool, valid: true, reason: 'rise' }];

    it.each(CONNECT)('%s: one warn with the reason passive_connect and the code',
        async (code, errno, syscall) => {
            await hit(failure('open', network(code, errno, syscall)), 'query', {}, [REFUSED]);
            await pass(0);

            // the check that failed after it changed no state: no second line
            expect(changes()).toEqual([up1, down('passive_connect', code)]);
        });

    it.each(LOST)('%s and a failed check: one warn with the reason passive_lost and the code',
        async (code, errno, syscall) => {
            const step = failure('query', network(code, errno, syscall));
            await hit(step, 'query', { fall: 3 }, [REFUSED]);
            await pass(0);

            expect(changes()).toEqual([up1, down('passive_lost', code)]);
        });

    it.each(UNREACHABLE)('%s and a failed check: one warn with the reason passive_unreachable',
        async (code, errno, syscall) => {
            await hit(failure('open', network(code, errno, syscall)), 'query', { fall: 3 },
                [REFUSED]);
            await pass(0);

            expect(changes()).toEqual([up1, down('passive_unreachable', code)]);
        });

    it('a connect timeout and a failed check: one warn with the reason passive_timeout',
        async () => {
            await hit(TIMED_OUT, 'query', { fall: 3 }, [REFUSED]);
            await pass(0);

            expect(changes()).toEqual([up1, down('passive_timeout', 'ETIMEDOUT')]);
        });

    it.each<[string, object, Step[], Step[], any[]]>([
        ['a connect timeout whose check passes logs no line', {}, [TIMED_OUT], [PASS], [up1]],
        ['a call that found no route and whose check passes logs no line',
            {}, [NO_ROUTE], [PASS], [up1]],
        ['a lost connection whose check passes logs no line', {}, [RESET], [PASS], [up1]],
        ['a lost connection whose check a validator says no to: the line of the validator',
            {}, [RESET], [NO], [up1, ['warn', { pool, valid: false, reason: 'validator' }]]],
        ['a lost connection whose check the server refuses: the line of the refusal',
            {}, [RESET], [failure('open', denied)], [up1, downRefusal]],
        ['a lost connection whose check is the fall-th failure: the line of the fall',
            {}, [REFUSED, RESET], [REFUSED], [up1, downFall]],
        ['down by a refused connection and back by rise: one line each',
            {}, [REFUSED], [PASS, PASS], [up1, down('passive_connect', 'ECONNREFUSED'), upRise]]
    ])('%s', async (_name, block, before, checks, wanted) => {
        // `before` ends with the call of the app. A step ahead of it is a check that failed
        const node = fakeNode([PASS, ...before, ...checks, 'hang']);
        await start({ healthCheck: block });
        await pass((before.length - 1) * 5000 + 1000);
        await failed(direct());
        for (let i = 0; i < checks.length; i++) await pass(i ? 5000 : 0);

        expect(node.asked).toHaveLength(1 + before.length + checks.length);
        expect(changes()).toEqual(wanted);
    });

    // the debug line of a check that passive health started: its fields, never its wording
    const started = () => logger.debug.mock.calls.map(([, meta]) => meta)
        .filter(meta => meta && meta.passive);
    const debugStart = async (steps: Step[]) => {
        fakeNode([PASS, ...steps]);
        const settings = { ...settingsOf({ healthCheck: {} }), logs: { level: 'debug' } };
        cluster = createPoolCluster(settings);
        await connect();
    };

    it.each<[string, Step, object]>([
        ['a refused connection', REFUSED, { pool, passive: 'connect', code: 'ECONNREFUSED' }],
        ['a connect timeout', TIMED_OUT, { pool, passive: 'timeout', code: 'ETIMEDOUT' }],
        ['no route to the network', NO_ROUTE,
            { pool, passive: 'unreachable', code: 'ENETUNREACH' }],
        ['a lost connection', RESET, { pool, passive: 'lost', code: 'ECONNRESET' }]
    ])('%s: one debug line for the check that starts', async (_name, step, wanted) => {
        await debugStart([step, PASS]);
        await failed(direct());
        await pass(0);

        expect(started()).toEqual([wanted]);
    });

    it('no debug line for a call that starts no check', async () => {
        await debugStart([RESET, PASS, RESET, PASS]);
        await failed(direct());
        await pass(1000);
        await failed(direct());
        await pass(0);

        expect(started()).toHaveLength(1);
    });
});

describe('passive health: what stays as it was', () => {
    // an SDK of the app that is read on demand and sets no timer
    class Reader extends MetricReader {
        protected onForceFlush(): Promise<void> { return Promise.resolve(); }
        protected onShutdown(): Promise<void> { return Promise.resolve(); }
    }
    let provider: MeterProvider;
    let reader: Reader;

    const HEALTH = 'mysql_dynamic_cluster.health_check.duration';
    const RESULT = 'mysql_dynamic_cluster.health_check.result';
    // what the app reads of the node: the checks by their result, and the gauge of its state
    const read = async () => {
        const points: { [name: string]: any[] } = {};
        const { resourceMetrics } = await reader.collect();
        for (const scope of resourceMetrics.scopeMetrics) {
            for (const metric of scope.metrics) points[metric.descriptor.name] = metric.dataPoints;
        }
        const checks: { [result: string]: number } = {};
        for (const point of points[HEALTH] || []) {
            checks[point.attributes[RESULT]] = point.value.count;
        }
        return { checks, valid: points['mysql_dynamic_cluster.node.valid'][0].value };
    };
    const names = async (): Promise<string[]> => {
        const { resourceMetrics } = await reader.collect();
        return resourceMetrics.scopeMetrics
            .flatMap(scope => scope.metrics.map(metric => metric.descriptor.name)).sort();
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

    const base = { id: 0, name: pool, host: 'node-a', port: 3306, loadScore: 19 };

    it('nodes() shows the node as down, with no checkError until a check failed', async () => {
        await hit(REFUSED, 'query', {}, [RESET]);
        const atOnce = info();
        await pass(0);

        expect(atOnce).toEqual({ ...base, isValid: false });
        expect(info()).toEqual({ ...base, isValid: false, checkError: RESET_CHECK });
    });

    it('nodes() keeps the checkError of the last check over a mark', async () => {
        const node = fakeNode([PASS, RESET, REFUSED, 'hang']);
        await start({ healthCheck: { fall: 3 } });
        await pass(5000);
        await failed(direct());

        // the error of the check at 5000, not the one of the call of the app
        expect(info()).toEqual({ ...base, isValid: false, checkError: RESET_CHECK });
        expect(node.asked).toHaveLength(3);
    });

    it('pool_check_failed comes for the check that failed, never for the call', async () => {
        const seen: any[] = [];
        fakeNode([PASS, REFUSED, RESET, 'hang']);
        await start({ healthCheck: {} });
        cluster.on('pool_check_failed', (args: any[]) => seen.push([args[0].code, args[1]]));
        await failed(direct());
        const atOnce = seen.length;
        await pass(0);

        expect([atOnce, seen]).toEqual([0, [['ECONNRESET', 0]]]);
    });

    it('the gauge of the node follows the mark, and no check is recorded for it', async () => {
        await hit(REFUSED, 'query', {}, ['hang']);

        expect(await read()).toEqual({ checks: { valid: 1 }, valid: 0 });
    });

    it('the check passive health started is recorded as any check', async () => {
        await hit(RESET, 'query', {}, [REFUSED]);
        await pass(0);

        expect(await read()).toEqual({ checks: { valid: 1, error: 1 }, valid: 0 });
    });

    it('no metric is added', async () => {
        // the names an app reads after the same refused query, without and with passive health
        const namesAfter = async (block: object): Promise<string[]> => {
            fakeNode([PASS, REFUSED, PASS]);
            await start({ healthCheck: block });
            await failed(direct());
            await pass(0);
            await cluster.disconnect();
            return names();
        };
        const off = await namesAfter({ passive: false });

        expect(await namesAfter({})).toEqual(off);
    });

    it('ready and firstReady keep the result of the check of connect()', async () => {
        await hit(REFUSED);
        await pass(0);

        expect(await cluster.ready).toEqual([{ nodeId: 0, ok: true }]);
        expect(await cluster.firstReady).toEqual([{ nodeId: 0, ok: true }]);
    });

    // mysql2 builds no such errors. A throw out of passive health would come between the
    // mark that the call settled and its rejection, and the call would never settle
    it('the code of an error is read once: a second read that throws is never made', async () => {
        let reads = 0;
        const forged = {
            fatal: true,
            get code() {
                if (reads++) throw new Error('second read');
                return 'ECONNRESET';
            }
        };
        const node = fakeNode([PASS, 'hang']);
        await start({ healthCheck: {} });

        // as Pool tells it of a call that failed on a connection it was handed
        cluster.pools[0].status.realFailure(forged, false);
        await pass(0);

        // a lost connection as any other: the check at once
        expect([reads, valid(), node.asked.length]).toEqual([1, true, 2]);
    });

    it('an error whose code throws at every read reaches the app, and changes nothing',
        async () => {
            const forged = {
                fatal: true,
                get code(): string { throw new Error('unreadable'); }
            };
            const node = fakeNode([PASS, failure('query', () => forged), REFUSED]);
            await start({ healthCheck: {} });
            await pass(1000);
            // straight to the pool, which rejects with what mysql2 handed it
            const error = await failed(direct());
            await pass(0);

            expect(error === forged).toBe(true);
            expect([valid(), askedAt(node)]).toEqual([true, [0, 1000]]);
        });

    it('the error of the call reaches the app as it did', async () => {
        fakeNode([PASS, REFUSED, PASS]);
        await start({ healthCheck: { passive: false } });
        const off = await failed(app.getConnection());
        await cluster.disconnect();
        const { error } = await hit(REFUSED, 'getConnection');

        expect({ ...error, message: error.message }).toEqual({ ...off, message: off.message });
    });
});

describe('passive health: the time a dead node takes to leave rotation', () => {
    // A node that passed three checks and stops right after the last of them: from here on
    // every request ends as `how` says. The first call of the app comes 1000 ms later
    const dying = async (block: object, how: Step, pool: object = {}) => {
        fakeNode([PASS, PASS, PASS, how]);
        await start({ ...pool, healthCheck: block });
        await pass(10000);
        await pass(1000);
    };
    // The node 1 ms before `wanted` ms passed since the call of the app, or right after the
    // call when `wanted` is 0, then the node at `wanted` ms, and the ms that passed
    const outAfter = async (wanted: number) => {
        const called = Date.now();
        await failed(direct());
        if (wanted) await pass(wanted - 1);
        const before = valid();
        await pass(wanted ? 1 : 0);
        return [before, valid(), Date.now() - called];
    };

    it.each<[string, object, number]>([
        ['connections refused: 0 ms after the first call', {}, 0],
        ['connections refused, fall 3: 0 ms', { fall: 3 }, 0],
        // without passive health: the checks at 15000 and 20000, so 9000 ms after the call
        ['connections refused, passive false: 9000 ms', { passive: false }, 9000],
        // one more check, at 25000
        ['connections refused, fall 3 and passive false: 14000 ms',
            { fall: 3, passive: false }, 14000]
    ])('%s', async (_name, block, wanted) => {
        await dying(block, REFUSED);

        // with 0 the node is out before any check ran, by the call alone
        expect(await outAfter(wanted)).toEqual([wanted > 0, false, wanted]);
    });

    // The connection the call was handed is lost, or the call gets none within the connect
    // timeout, and from then on the node is as `how` says. One check decides: 0 ms when it
    // is refused, its timeout when it hangs. A node that drops every packet is the connect
    // timeout and checks that hang: the call itself waited the 10 s of mysql2 before this
    it.each<[string, object, Step, Step, number]>([
        ['a lost connection, then connections refused: 0 ms', {}, RESET, REFUSED, 0],
        ['a lost connection, then checks that hang: 5000 ms, one timeout',
            {}, RESET, 'hang', 5000],
        ['the same with timeout 1000: 1000 ms', { timeout: 1000 }, RESET, 'hang', 1000],
        ['the same with fall 3: 5000 ms', { fall: 3 }, RESET, 'hang', 5000],
        // without passive health: the checks at 15000 and 20000
        ['a lost connection, then connections refused, passive false: 9000 ms',
            { passive: false }, RESET, REFUSED, 9000],
        // without passive health: the checks at 15000 and 25000, each hangs for 5000
        ['a lost connection and checks that hang, passive false: 19000 ms',
            { passive: false }, RESET, 'hang', 19000],
        ['a connect timeout, then checks that hang: 5000 ms, one timeout',
            {}, TIMED_OUT, 'hang', 5000],
        ['the same with timeout 1000: 1000 ms', { timeout: 1000 }, TIMED_OUT, 'hang', 1000],
        ['the same with fall 3: 5000 ms', { fall: 3 }, TIMED_OUT, 'hang', 5000],
        ['a connect timeout, then connections refused: 0 ms', {}, TIMED_OUT, REFUSED, 0],
        ['a connect timeout and checks that hang, passive false: 19000 ms',
            { passive: false }, TIMED_OUT, 'hang', 19000],
        // No route for the call. The check that starts finds none either, or it draws a
        // pooled connection whose packets get no answer
        ['no route, and none for the check: 0 ms, one check', {}, NO_ROUTE, NO_ROUTE, 0],
        ['no route, then checks that hang: 5000 ms, one timeout', {}, NO_ROUTE, 'hang', 5000],
        ['no route, and none for the checks, passive false: 9000 ms',
            { passive: false }, NO_ROUTE, NO_ROUTE, 9000],
        // A node that resets every connection, old and new: the check and ten more runs,
        // as the default connectionLimit of 10 allows, each 1 ms after the one before
        ['a lost connection, then every connection is reset: 10 ms', {}, RESET, RESET, 10],
        ['the same with a connectionLimit of 3: 3 ms', { connectionLimit: 3 }, RESET, RESET, 3],
        ['the same with passive false: 9000 ms', { passive: false }, RESET, RESET, 9000]
    ])('%s', async (_name, settings, first, how, wanted) => {
        const { connectionLimit, ...block } = settings as any;
        await dying(block, first, connectionLimit === undefined ? {} : { connectionLimit });
        nodes['node-a'].plan = [first, how];

        // up after the call, whatever `wanted` is: only a check takes this node down
        expect(await outAfter(wanted)).toEqual([true, false, wanted]);
    });
});
