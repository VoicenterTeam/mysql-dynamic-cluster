import { createPoolCluster } from '../../index';

// No mocks and no connection: the cluster built by createPoolCluster, read before connect()
const makeCluster = (hosts: object[]): any => createPoolCluster({
    clusterName: 'test',
    hosts: hosts.map(host => ({ host: '127.0.0.1', ...host })),
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
    useClusterHashing: false,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
} as any);

describe('the node API of a cluster that has not connected yet', () => {
    it('nodes() lists every host with the id the cluster gave it', () => {
        const cluster = makeCluster([{ id: 0, name: 'first' }, { id: 5, port: 3307 }, {}]);

        // not checked yet: not valid, with the load score a pool starts with
        const unchecked = { host: '127.0.0.1', isValid: false, loadScore: 100000 };
        expect(cluster.nodes()).toEqual([
            { id: 6, name: 'first', port: 3306, ...unchecked },
            { id: 5, name: '127.0.0.1:3307', port: 3307, ...unchecked },
            { id: 7, name: '127.0.0.1:3306', port: 3306, ...unchecked }
        ]);
    });

    it('getPoolStats() has zeros and the limit of each node', () => {
        const cluster = makeCluster([{ id: 1 }, { id: 2, connectionLimit: 3 }]);

        expect(cluster.getPoolStats()).toEqual([
            { nodeId: 1, used: 0, idle: 0, pending: 0, limit: 10 },
            { nodeId: 2, used: 0, idle: 0, pending: 0, limit: 3 }
        ]);
    });

    it('failWaiting() returns 0 for a node whose pool is not created yet', () => {
        expect(makeCluster([{ id: 1 }]).failWaiting(1, new Error('going down'))).toBe(0);
    });

    it('getConnection() rejects with MDC_NO_NODE_AVAILABLE, no node is valid yet', async () => {
        const failure = await makeCluster([{ id: 1 }]).getConnection().catch((e: any) => e);

        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBe('MDC_NO_NODE_AVAILABLE');
    });

    it('ready is a promise, the same one on every read', () => {
        const cluster = makeCluster([{ id: 1 }]);

        expect(cluster.ready).toBeInstanceOf(Promise);
        expect(cluster.ready).toBe(cluster.ready);
    });

    it('firstReady is a promise, the same one on every read, and not the one of ready', () => {
        const cluster = makeCluster([{ id: 1 }]);

        expect(cluster.firstReady).toBeInstanceOf(Promise);
        expect(cluster.firstReady).toBe(cluster.firstReady);
        expect(cluster.firstReady).not.toBe(cluster.ready);
    });

    it('firstReady and ready resolve with an empty list for a cluster without hosts', async () => {
        const cluster = makeCluster([]);
        // connect() of a cluster without hosts never settles, so it is not awaited
        cluster.connect();

        expect(await cluster.firstReady).toStrictEqual([]);
        expect(await cluster.ready).toStrictEqual([]);
    });

    it('all of it works for a cluster without hosts', async () => {
        const cluster = makeCluster([]);

        expect(cluster.nodes()).toEqual([]);
        expect(cluster.getPoolStats()).toEqual([]);
        expect(cluster.failWaiting(1, new Error('going down'))).toBe(0);
        await expect(cluster.getConnection()).rejects.toMatchObject({
            code: 'MDC_NO_NODE_AVAILABLE'
        });
    });
});
