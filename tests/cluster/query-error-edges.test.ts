jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));

import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Metrics from '../../src/metrics/Metrics';
import Redis from '../../src/Redis/Redis';

// What a failed query() rejects with, for rejections mysql2 does not make: one error object
// from two nodes, as failWaiting() can hand out, a frozen error and a value that is no object
const node = (id: number, rejection: unknown): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore: id },
    query: jest.fn(() => Promise.reject(rejection))
});

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[], useRedis = false): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: useRedis,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });

const rejectionOf = (cluster: any): Promise<any> =>
    cluster.query('SELECT 1').then(
        () => { throw new Error('the query passed'); },
        (error: unknown) => error
    );

beforeEach(() => jest.clearAllMocks());

describe('one error object from two nodes', () => {
    it('is not listed in its own errors, so it can be turned into JSON', async () => {
        const shared = new Error('node is being drained');
        const error = await rejectionOf(makeCluster([node(1, shared), node(2, shared)]));

        expect(error).toBe(shared);
        expect(error.errors).toEqual([]);
        expect(() => JSON.stringify(error)).not.toThrow();
    });

    it('still lists the other errors of the query', async () => {
        const shared = new Error('node is being drained');
        const other = new Error('other');
        const error = await rejectionOf(
            makeCluster([node(1, shared), node(2, other), node(3, shared)])
        );

        expect(error).toBe(shared);
        expect(error.errors).toEqual([{ nodeId: 2, error: other }]);
    });
});

describe('a rejection that cannot take nodeId or errors', () => {
    it('a frozen error goes to the caller as it is', async () => {
        const frozen = Object.freeze(Object.assign(new Error('frozen'), { code: 'X' }));
        const error = await rejectionOf(makeCluster([node(1, frozen)]));

        expect(error).toBe(frozen);
        expect(error.nodeId).toBeUndefined();
        expect(error.errors).toBeUndefined();
    });

    it('a value that is no object goes to the caller as it is', async () => {
        await expect(rejectionOf(makeCluster([node(1, 'down')]))).resolves.toBe('down');
    });

    it('a rejection without a value is still recorded as a failed query', async () => {
        await expect(rejectionOf(makeCluster([node(1, undefined)]))).resolves.toBeUndefined();

        const [[, options]] = (Metrics.recordQuery as jest.Mock).mock.calls;
        expect(options.error).toBeTruthy();
    });

    it.each([[''], [0], [false]])('a rejection with %p is still recorded as a failed query', async value => {
        await expect(rejectionOf(makeCluster([node(1, value)]))).resolves.toBe(value);

        const [[, options]] = (Metrics.recordQuery as jest.Mock).mock.calls;
        expect(options.error).toBeTruthy();
    });
});

describe('an error that has errors of its own', () => {
    // what Node rejects with when every address of a host name refuses the connection
    const refused = () => Object.assign(
        new (globalThis as any).AggregateError([new Error('::1 refused'), new Error('127.0.0.1 refused')], ''),
        { code: 'ECONNREFUSED' }
    );

    it('keeps them when it is the error of the node tried last', async () => {
        const aggregate = refused();
        const own = aggregate.errors;
        const error = await rejectionOf(makeCluster([node(1, new Error('first')), node(2, aggregate)]));

        expect(error).toBe(aggregate);
        expect(error.nodeId).toBe(2);
        expect(error.errors).toBe(own);
    });

    it('keeps them when it is listed for a node tried before', async () => {
        const aggregate = refused();
        const own = aggregate.errors;
        const error = await rejectionOf(makeCluster([node(1, aggregate), node(2, new Error('last'))]));

        expect(error.errors).toEqual([{ nodeId: 1, error: aggregate }]);
        expect(aggregate.errors).toBe(own);
    });
});

describe('two errors from failWaiting() that two queries meet in opposite order', () => {
    it('refer to each other at most one way, so both can be turned into JSON', async () => {
        const x = new Error('node 1 is being drained');
        const y = new Error('node 2 is being drained');
        // the first query is failed with x on node 1 and then with y on node 2, the second
        // with y on node 2 and then with x on node 1
        const first = await rejectionOf(makeCluster([node(1, x), node(2, y)]));
        const busy = (pool: any) => Object.assign(pool, { status: { isValid: true, loadScore: 9 } });
        const second = await rejectionOf(makeCluster([node(2, y), busy(node(1, x))]));

        expect(first).toBe(y);
        expect(second).toBe(x);
        expect(() => JSON.stringify(x)).not.toThrow();
        expect(() => JSON.stringify(y)).not.toThrow();
    });
});

describe('every node failed and Redis holds expired data', () => {
    it('the data is served and no error is thrown', async () => {
        (Redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ data: [{ a: 1 }], expired: 0 }));
        const cluster = makeCluster([node(1, new Error('down'))], true);

        await expect(cluster.query('SELECT 1')).resolves.toEqual([{ a: 1 }]);
        const [[, options]] = (Metrics.recordQuery as jest.Mock).mock.calls;
        expect(options).toEqual(expect.objectContaining({ source: 'stale_cache', error: undefined }));
    });
});
