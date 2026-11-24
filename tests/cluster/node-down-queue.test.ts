// a mysql2 that opens nothing. Every pool it creates asks the fake node of its host
jest.mock('mysql2', () => ({
    __esModule: true,
    default: { createPool: jest.fn(), createConnection: jest.fn() }
}));

import mysql from 'mysql2';
import { createPoolCluster } from '../../index';

// #98 through the cluster an app gets from createPoolCluster: a node that goes down fails
// the calls that wait for one of its connections. query() and execute() try the next node,
// since the statement was not sent. getConnection() tries no other node. Only mysql2 is
// replaced. The nodes have no healthCheck block: the test runs the check that takes node 1
// down itself

type Cb = (err: any, res?: any) => void;
type Rows = { Variable_name: string, Value: string }[];

// SHOW GLOBAL STATUS of a node every default validator accepts. The node with fewer
// connections has the lower load score, and is tried first
const up = (connections: number, ready = 'ON'): Rows => [
    { Variable_name: 'wsrep_ready', Value: ready },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '3' },
    { Variable_name: 'Connections', Value: String(connections) },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0.5' }
];

// While `full` is set the pool of the node is at its limit, and every request for a
// connection waits in the queue of mysql2. Otherwise a connection comes at once. It answers
// the status query with `status` and any other statement with `rows`
const makeNode = (status: Rows, rows: object[]) => {
    const node = {
        full: false, status, rows,
        // how many requests for a connection the node got
        asked: 0,
        mysqlPool: {
            on: jest.fn(), end: jest.fn(),
            _allConnections: [] as any[], _freeConnections: [] as any[],
            _connectionQueue: [] as Cb[],
            getConnection: (cb: Cb) => {
                node.asked++;
                if (node.full) return node.mysqlPool._connectionQueue.push(cb);
                const answer = (options: any, done: Cb) => {
                    done(null, options.sql === 'SHOW GLOBAL STATUS;' ? node.status : node.rows);
                };
                cb(null, {
                    query: answer, execute: answer, reset: (done: Cb) => done(null),
                    release: jest.fn(), destroy: jest.fn(), on: jest.fn(), removeListener: jest.fn()
                });
            }
        }
    };
    return node;
};

const ROWS_1 = [{ node: 1 }];
const ROWS_2 = [{ node: 2 }];
const MESSAGE = 'The node node-1:3306 went down while the request waited for a connection';
let nodes: { [host: string]: ReturnType<typeof makeNode> };
let cluster: any;
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(async () => {
    jest.clearAllMocks();
    nodes = { 'node-1': makeNode(up(1), ROWS_1), 'node-2': makeNode(up(9), ROWS_2) };
    (mysql.createPool as jest.Mock)
        .mockImplementation((options: any) => nodes[options.host].mysqlPool);
    cluster = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: 'node-1', id: 1 }, { host: 'node-2', id: 2 }],
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [] },
        useClusterHashing: false,
        logger
    } as any);
    await cluster.connect();
    await cluster.ready;
    nodes['node-1'].full = true;
});

afterEach(async () => {
    await cluster.disconnect();
});

// wait until `count` requests wait for a connection of node 1
const queued = async (count: number = 1) => {
    const queue = nodes['node-1'].mysqlPool._connectionQueue;
    for (let turn = 0; turn < 50 && queue.length < count; turn++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    expect(queue).toHaveLength(count);
};

// Node 1 goes down: its next check gets a connection, and a validator says no to its answer
const takeDown = async () => {
    const node = nodes['node-1'];
    node.full = false;
    node.status = up(1, 'OFF');
    await cluster.pools[0].status.checkStatus();
    expect(cluster.nodes().map((info: any) => info.isValid)).toEqual([false, true]);
};

// the meta of every info line about requests that were failed
const failLines = () => logger.info.mock.calls
    .filter(([, meta]) => meta && meta.failed !== undefined).map(([, meta]) => meta);

type Call = (options?: object) => Promise<any>;
const CALLS: [string, Call][] = [
    ['query()', options => cluster.query('SELECT 1', undefined, options)],
    ['execute()', options => cluster.execute('SELECT ?', [1], options)]
];

describe('a node that goes down while calls wait for its connections', () => {
    it.each(CALLS)('%s: the statement that waited at node 1 runs at node 2', async (_name, call) => {
        const steps: [string, number][] = [];
        const timings: any[] = [];
        const answer = call({
            onStep: (step: string, nodeId: number) => { steps.push([step, nodeId]); },
            onTiming: (timing: any) => { timings.push(timing); }
        });
        await queued();

        await takeDown();

        await expect(answer).resolves.toEqual(ROWS_2);
        // the attempt at node 1 ended in the queue, the one at node 2 started there
        expect(steps).toEqual([['queue', 1], ['queue', 2], ['prepare', 2], ['statement', 2]]);
        expect(timings.map(({ step, nodeId }) => [step, nodeId])).toEqual([['statement', 2]]);
        expect(failLines()).toEqual([{ nodeId: 1, pool: 'node-1:3306', failed: 1 }]);
    });

    it.each(CALLS)('%s with maxRetry 1: rejects with MDC_NODE_DOWN, an error of its own for ' +
        'each call', async (_name, call) => {
        const answers = [call({ maxRetry: 1 }), call({ maxRetry: 1 })]
            .map(answer => answer.then(() => 'resolved', (error: any) => error));
        await queued(2);

        await takeDown();

        const errors = await Promise.all(answers);
        errors.forEach(error => {
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe(MESSAGE);
            expect([error.code, error.sent, error.nodeId, error.errors])
                .toEqual(['MDC_NODE_DOWN', false, 1, []]);
        });
        expect(errors[0]).not.toBe(errors[1]);
        expect(nodes['node-2'].asked).toBe(1);
    });

    it('getConnection() rejects with MDC_NODE_DOWN and asks no other node', async () => {
        const answer = cluster.getConnection().then(() => 'resolved', (error: any) => error);
        await queued();

        await takeDown();

        const error = await answer;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(MESSAGE);
        expect([error.code, error.sent, error.nodeId]).toEqual(['MDC_NODE_DOWN', false, 1]);
        // only the check of connect()
        expect(nodes['node-2'].asked).toBe(1);
    });
});
