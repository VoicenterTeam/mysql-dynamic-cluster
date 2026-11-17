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

import { runInNewContext } from 'vm';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Metrics from '../../src/metrics/Metrics';

// what the cluster reads of a pool. The connection is whatever the pool hands out
const node = (id: number, loadScore: number, isValid = true): any => ({
    id, name: 'node' + id, host: 'host' + id, port: 3300 + id, connectionLimit: 10 + id,
    status: { isValid, loadScore },
    getConnection: jest.fn().mockResolvedValue({ threadId: id }),
    failWaiting: jest.fn().mockReturnValue(0),
    stats: jest.fn().mockReturnValue({ used: 0, idle: 0, pending: 0 }),
    query: jest.fn().mockRejectedValue(new Error('down'))
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

const acquires = (pools: any[]): number =>
    pools.reduce((count, pool) => count + pool.getConnection.mock.calls.length, 0);

describe('GaleraCluster.getConnection', () => {
    beforeEach(() => jest.clearAllMocks());

    it('hands out a connection of the valid node with the lowest load score', async () => {
        const pools = [node(1, 30), node(2, 10), node(3, 20)];
        const result = await makeCluster(pools).getConnection();

        expect(result).toEqual({ connection: { threadId: 2 }, nodeId: 2 });
        expect(acquires(pools)).toBe(1);
    });

    it('skips a node that is not valid, whatever its load score', async () => {
        const pools = [node(1, 30), node(2, 10, false), node(3, 20)];
        expect((await makeCluster(pools).getConnection()).nodeId).toBe(3);
        expect(pools[1].getConnection).not.toHaveBeenCalled();
    });

    it.each([
        ['the best node', [2], 3],
        ['the two best nodes', [2, 3], 1],
        ['a node that does not exist', [99], 2],
        ['nothing, as an empty list', [], 2]
    ])('skips the nodes in exclude: %s', async (_name, exclude, nodeId) => {
        const pools = [node(1, 30), node(2, 10), node(3, 20)];
        expect((await makeCluster(pools).getConnection({ exclude })).nodeId).toBe(nodeId);
    });

    it.each([
        ['no options', undefined],
        ['empty options', {}],
        ['exclude set to undefined', { exclude: undefined }]
    ])('excludes nothing with %s', async (_name, options) => {
        const pools = [node(1, 30), node(2, 10)];
        expect((await makeCluster(pools).getConnection(options)).nodeId).toBe(2);
    });

    it('takes no part in service hashing', async () => {
        const hashing = { connected: true, getNodeByService: jest.fn().mockReturnValue(1) };
        const pools = [node(1, 30), node(2, 10)];

        expect((await makeCluster(pools, hashing).getConnection()).nodeId).toBe(2);
        expect(hashing.getNodeByService).not.toHaveBeenCalled();
    });

    it.each([
        ['no node is valid', [node(1, 10, false), node(2, 20, false)], undefined],
        ['every valid node is excluded', [node(1, 10), node(2, 20, false)], { exclude: [1] }],
        ['the cluster has no node', [], undefined]
    ])('rejects with MDC_NO_NODE_AVAILABLE when %s', async (_name, pools, options) => {
        const failure = await makeCluster(pools).getConnection(options).catch((e: any) => e);

        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(acquires(pools)).toBe(0);
    });

    it('rejects with the error of the failed acquire, the same object, plus nodeId', async () => {
        const error = Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED', errno: -111, fatal: true
        });
        const pools = [node(1, 30), node(2, 10)];
        pools[1].getConnection.mockRejectedValue(error);

        const failure = await makeCluster(pools).getConnection().catch((e: any) => e);

        expect(failure).toBe(error);
        expect({ ...failure }).toEqual({
            code: 'ECONNREFUSED', errno: -111, fatal: true, nodeId: 2
        });
        expect(failure.message).toBe('connect ECONNREFUSED');
    });

    it('acquires once and tries no other node after a failed acquire', async () => {
        const pools = [node(1, 30), node(2, 10), node(3, 20)];
        pools[1].getConnection.mockRejectedValue(new Error('Pool is closed.'));

        await expect(makeCluster(pools).getConnection()).rejects.toThrow('Pool is closed.');
        expect(acquires(pools)).toBe(1);
    });

    it.each([
        ['null', null],
        ['a number', 2],
        ['a string', '2'],
        ['an object', { 0: 2, length: 1 }],
        ['an array of strings', ['2']],
        ['an array with one string', [1, '2']],
        ['an array with undefined', [undefined]]
    ])('rejects with a TypeError that names exclude when it is %s', async (_name, exclude) => {
        const pools = [node(1, 30), node(2, 10)];
        const failure = await makeCluster(pools).getConnection({ exclude }).catch((e: any) => e);

        expect(failure).toBeInstanceOf(TypeError);
        expect(failure.message).toContain('exclude');
        expect(acquires(pools)).toBe(0);
    });

    it('leaves the connection as the pool handed it out and records no metric', async () => {
        const connection = {
            changeUser: jest.fn(), query: jest.fn(), reset: jest.fn(),
            release: jest.fn(), destroy: jest.fn()
        };
        const pools = [node(1, 10)];
        pools[0].getConnection.mockResolvedValue(connection);

        expect((await makeCluster(pools).getConnection()).connection).toBe(connection);
        Object.values(connection).forEach(method => expect(method).not.toHaveBeenCalled());
        expect(Metrics.recordOperation).not.toHaveBeenCalled();
        expect(Metrics.recordQuery).not.toHaveBeenCalled();
    });
});

describe('GaleraCluster.failWaiting', () => {
    it('fails the waiting requests of that node only and returns their count', () => {
        const pools = [node(1, 10), node(2, 20)];
        pools[1].failWaiting.mockReturnValue(3);
        const error = new Error('node 2 is going down');

        expect(makeCluster(pools).failWaiting(2, error)).toBe(3);
        expect(pools[1].failWaiting).toHaveBeenCalledWith(error);
        expect(pools[1].failWaiting.mock.calls[0][0]).toBe(error);
        expect(pools[0].failWaiting).not.toHaveBeenCalled();
    });

    // an error of Node itself is such an error for code that runs under jest
    it('takes an Error that was made in another realm', () => {
        const pools = [node(1, 10)];
        const error = runInNewContext('new Error("going down")');

        expect(error instanceof Error).toBe(false);
        makeCluster(pools).failWaiting(1, error);
        expect(pools[0].failWaiting.mock.calls[0][0]).toBe(error);
    });

    it.each([
        ['a node that does not exist', 99],
        ['an id of the wrong type', '2'],
        ['no id', undefined]
    ])('returns 0 for %s', (_name, nodeId) => {
        const pools = [node(1, 10), node(2, 20)];

        expect(makeCluster(pools).failWaiting(nodeId, new Error('x'))).toBe(0);
        pools.forEach(pool => expect(pool.failWaiting).not.toHaveBeenCalled());
    });

    it('returns 0 for a cluster without nodes', () => {
        expect(makeCluster([]).failWaiting(1, new Error('x'))).toBe(0);
    });

    // a callback of mysql2 that gets no error reads its second argument as a connection
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['a string', 'going down'],
        ['a plain object', { message: 'going down' }]
    ])('throws a TypeError that names error when it is %s', (_name, error) => {
        const pools = [node(1, 10)];

        expect(() => makeCluster(pools).failWaiting(1, error)).toThrow(TypeError);
        expect(() => makeCluster(pools).failWaiting(1, error)).toThrow('error');
        expect(pools[0].failWaiting).not.toHaveBeenCalled();
    });
});

describe('GaleraCluster.getPoolStats', () => {
    it('has one entry per node, with the counts of its pool and its limit', () => {
        const pools = [node(1, 10), node(2, 20)];
        pools[0].stats.mockReturnValue({ used: 3, idle: 2, pending: 4 });

        expect(makeCluster(pools).getPoolStats()).toEqual([
            { nodeId: 1, used: 3, idle: 2, pending: 4, limit: 11 },
            { nodeId: 2, used: 0, idle: 0, pending: 0, limit: 12 }
        ]);
    });

    it('is empty for a cluster without nodes', () => {
        expect(makeCluster([]).getPoolStats()).toEqual([]);
    });
});

describe('GaleraCluster.nodes', () => {
    it('describes every node, valid or not', () => {
        expect(makeCluster([node(1, 30), node(2, 10, false)]).nodes()).toEqual([
            { id: 1, name: 'node1', host: 'host1', port: 3301, isValid: true, loadScore: 30 },
            { id: 2, name: 'node2', host: 'host2', port: 3302, isValid: false, loadScore: 10 }
        ]);
    });

    it('returns new objects on every call, which the cluster does not read back', async () => {
        const cluster = makeCluster([node(1, 30), node(2, 10)]);
        const first = cluster.nodes();
        first[1].isValid = false;
        first.pop();

        expect(cluster.nodes()).not.toBe(first);
        expect(cluster.nodes()[0]).not.toBe(first[0]);
        expect(cluster.nodes()).toHaveLength(2);
        expect((await cluster.getConnection()).nodeId).toBe(2);
    });

    it('is empty for a cluster without nodes', () => {
        expect(makeCluster([]).nodes()).toEqual([]);
    });
});
