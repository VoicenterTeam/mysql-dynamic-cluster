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

// what query() reads of a pool. Every pool fails the query
const node = (id: number, loadScore: number, isValid = true): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid, loadScore },
    query: jest.fn()
});

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[], hashing: object = { connected: false }): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: hashing
    });

// query() fails on every pool here, so the order of the attempts is the order of its pools
describe('the pool order of GaleraCluster.query', () => {
    const order = async (pools: any[], hashing: object, serviceId?: number): Promise<number[]> => {
        const tried: number[] = [];
        pools.forEach(pool => pool.query.mockImplementation(() => {
            tried.push(pool.id);
            return Promise.reject(new Error('down'));
        }));
        const cluster = makeCluster(pools, hashing);
        await cluster.query('SELECT 1', undefined, { serviceId }).catch(() => undefined);
        return tried;
    };
    const pinnedTo = (nodeId?: number) => ({
        connected: true, getNodeByService: () => nodeId, updateNodeForService: jest.fn()
    });

    it.each([
        ['by load score without a service', { connected: false }, undefined, [2, 3, 1]],
        ['by load score while hashing is not connected', { connected: false }, 7, [2, 3, 1]],
        ['the node of the service first, then by load score', pinnedTo(1), 7, [1, 2, 3]],
        ['the node of the service once, when it is also the best', pinnedTo(2), 7, [2, 3, 1]],
        ['by load score when the service has no node', pinnedTo(-1), 7, [2, 3, 1]],
        // what the hashing module answers for a service it has no node for
        ['by load score when the node of the service is undefined', pinnedTo(), 7, [2, 3, 1]],
        ['by load score when the node of the service is not a node', pinnedTo(9), 7, [2, 3, 1]]
    ])('%s', async (_name, hashing, serviceId, expected) => {
        const pools = [node(1, 30), node(2, 10), node(3, 20)];
        expect(await order(pools, hashing, serviceId)).toEqual(expected);
    });

    it('leaves out a node that is not valid', async () => {
        const pools = [node(1, 30), node(2, 10, false), node(3, 20)];
        expect(await order(pools, { connected: false })).toEqual([3, 1]);
    });

    it('puts the node of the service first even when it is not valid', async () => {
        const pools = [node(1, 30, false), node(2, 10), node(3, 20)];
        expect(await order(pools, pinnedTo(1), 7)).toEqual([1, 2, 3]);
    });

    it('leaves the pools of the cluster in the order of the settings', async () => {
        const pools = [node(1, 30), node(2, 10), node(3, 20)];
        const cluster = makeCluster(pools);
        await cluster.query('SELECT 1').catch(() => undefined);

        expect(cluster.pools.map((pool: any) => pool.id)).toEqual([1, 2, 3]);
    });

    it('rejects with MDC_NO_NODE_AVAILABLE when no pool is left', async () => {
        const cluster = makeCluster([node(1, 10, false)]);
        await expect(cluster.query('SELECT 1')).rejects.toMatchObject({
            code: 'MDC_NO_NODE_AVAILABLE'
        });
    });
});
