jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { inc: jest.fn(), mark: jest.fn(), set: jest.fn(), avg: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));

import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Redis from '../../src/Redis/Redis';
import Metrics from '../../src/metrics/Metrics';
import MetricNames from '../../src/metrics/MetricNames';

// a cluster whose pools are all invalid, built without the config singletons
const makeCluster = (): GaleraCluster => Object.assign(Object.create(GaleraCluster.prototype), {
    _pools: [{ id: 1, status: { isValid: false, loadScore: 0 } }],
    _useRedis: true,
    _errorRetryCount: 3,
    _clusterName: 'c',
    _nullServiceName: 'mdc',
    _clusterHashing: { connected: false }
});

describe('GaleraCluster.query when no pool is valid', () => {
    beforeEach(() => jest.clearAllMocks());

    it('serves cached data, even expired', async () => {
        (Redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ data: [{ a: 1 }], expired: 0 }));
        await expect(makeCluster().query('SELECT 1')).resolves.toEqual([{ a: 1 }]);
        expect(Metrics.inc).toHaveBeenCalledWith(MetricNames.redis.staleServed);
    });

    it('throws when there is nothing cached', async () => {
        (Redis.get as jest.Mock).mockResolvedValue(null);
        await expect(makeCluster().query('SELECT 1')).rejects.toThrow('There is no pool that satisfies the parameters');
    });

    it('throws without reading the cache when redis is off for the query', async () => {
        await expect(makeCluster().query('SELECT 1', null, { redis: false })).rejects.toThrow('There is no pool');
        expect(Redis.get).not.toHaveBeenCalled();
    });

    it('throws without reading the cache when a refresh is requested', async () => {
        await expect(makeCluster().query('SELECT 1', null, { redisRefreshCache: true })).rejects.toThrow('There is no pool');
        expect(Redis.get).not.toHaveBeenCalled();
    });
});
