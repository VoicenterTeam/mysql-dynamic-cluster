jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { inc: jest.fn(), mark: jest.fn(), set: jest.fn(), avg: jest.fn(), update: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));

import { GaleraCluster } from '../../src/cluster/GaleraCluster';

type FakePool = { id: number, host: string, status: { isValid: boolean, isReachable: boolean, loadScore: number }, query: jest.Mock };
const fakePool = (id: number, isValid: boolean, isReachable: boolean, loadScore: number): FakePool => ({
    id, host: `node${id}`, status: { isValid, isReachable, loadScore },
    query: jest.fn().mockResolvedValue([{ from: `node${id}` }])
});

// built without the config singletons, like no-valid-pool-cache.test.ts
const makeCluster = (pools: FakePool[]): GaleraCluster => Object.assign(Object.create(GaleraCluster.prototype), {
    _pools: pools,
    _useRedis: false,
    _errorRetryCount: 2,
    _clusterName: 'c',
    _nullServiceName: 'mdc',
    _clusterHashing: { connected: false }
});

describe('GaleraCluster.query picks the least busy node', () => {
    it('uses the least busy valid node when some nodes are valid', async () => {
        const pools = [fakePool(1, true, true, 30), fakePool(2, true, true, 10), fakePool(3, false, true, 1)];
        await expect(makeCluster(pools).query('SELECT 1')).resolves.toEqual([{ from: 'node2' }]);
    });

    it('falls back to the least busy reachable node when no node passes the validators', async () => {
        // a rejoining node (Joined), its donor (Donor/Desynced) and an overloaded third node
        const pools = [fakePool(1, false, true, 50), fakePool(2, false, true, 20), fakePool(3, false, false, 0)];
        await expect(makeCluster(pools).query('SELECT 1')).resolves.toEqual([{ from: 'node2' }]);
        expect(pools[2].query).not.toHaveBeenCalled();
    });

    it('retries the fallback on the next reachable node when the first one errors', async () => {
        const pools = [fakePool(1, false, true, 50), fakePool(2, false, true, 20)];
        pools[1].query.mockRejectedValueOnce(new Error('WSREP has not yet prepared node for application use'));
        await expect(makeCluster(pools).query('SELECT 1')).resolves.toEqual([{ from: 'node1' }]);
    });

    it('still refuses when no node is reachable', async () => {
        const pools = [fakePool(1, false, false, 0), fakePool(2, false, false, 0)];
        await expect(makeCluster(pools).query('SELECT 1')).rejects.toThrow('There is no pool that satisfies the parameters');
    });
});
