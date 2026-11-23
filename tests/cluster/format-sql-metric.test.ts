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

// What _formatSQL throws, such as the error of a toSqlString() of a value, is a failed query
// to the metric too: one record, and the call rejects with that same error (#48)
const node = (id: number, isValid = true): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid, loadScore: id },
    query: jest.fn().mockResolvedValue([])
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

// a value whose toSqlString() throws what it is handed
const raising = (thrown: unknown) => ({ toSqlString() { throw thrown; } });
const records = () => (Metrics.recordQuery as jest.Mock).mock.calls.map(call => call[1]);

beforeEach(() => jest.clearAllMocks());

describe.each([
    ['an array of values', 'SELECT ?', (value: object) => [value]],
    ['an object of values', 'SELECT :a', (value: object) => ({ a: value })]
])('a value of %s that throws while it is written into the text', (_name, sql, valuesOf) => {
    it('is recorded once as a failed query, and the call rejects with its error', async () => {
        const boom = new Error('toSqlString failed');
        const pools = [node(1)];
        const cluster = makeCluster(pools);

        await expect(cluster.query(sql, valuesOf(raising(boom)))).rejects.toBe(boom);

        expect(records()).toEqual([expect.objectContaining({ source: undefined, error: boom })]);
        expect(pools[0].query).not.toHaveBeenCalled();
    });

    it('is recorded as a failed query when what it throws is falsy', async () => {
        const cluster = makeCluster([node(1)]);

        await expect(cluster.query(sql, valuesOf(raising(undefined)))).rejects.toBeUndefined();

        expect(records()).toHaveLength(1);
        expect(records()[0].error).toBeTruthy();
    });

    it('is recorded once when no node is valid and Redis is read for stale data', async () => {
        const boom = new Error('toSqlString failed');
        const cluster = makeCluster([node(1, false)], true);

        await expect(cluster.query(sql, valuesOf(raising(boom)))).rejects.toBe(boom);

        expect(records()).toEqual([expect.objectContaining({ source: undefined, error: boom })]);
        expect(Redis.get).not.toHaveBeenCalled();
    });
});
