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
    default: { set: jest.fn(), get: jest.fn(), disconnect: jest.fn() }
}));

import { GaleraCluster } from '../../src/cluster/GaleraCluster';

const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };
const REFUSED = { code: 'ECONNREFUSED', errno: -111 };

// What the cluster reads of a pool. connect() ends when the test says so, and counts itself
// in connectAttempt as the pool does. checkError is a new object on every read, as in the pool
const node = (id: number, checkError?: object): any => {
    const connects: { pass: () => void, fail: (error: any) => void }[] = [];
    const pool: any = {
        id, name: 'node' + id, host: 'host' + id, port: 3300 + id,
        status: { isValid: false, loadScore: 100000 },
        connectAttempt: 0,
        lastCheck: checkError,
        get checkError() { return this.lastCheck && { ...this.lastCheck }; },
        connects,
        disconnect: jest.fn(() => { pool.connectAttempt++; })
    };
    pool.connect = jest.fn(() => new Promise<void>((resolve, reject) => {
        pool.connectAttempt++;
        connects.push({ pass: resolve, fail: reject });
    }));
    return pool;
};
// the first check of connect() ends: with an error, or with an answer the validator refuses
const failCheck = (pool: any, checkError?: object, call = 0) => {
    pool.lastCheck = checkError;
    const error = new Error('pool in host ' + pool.host + ' is not valid');
    pool.connects[call].fail(error);
    return error;
};

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[]): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        connected: false,
        _pools: pools,
        _useClusterHashing: false,
        _clusterHashing: { connect: jest.fn().mockResolvedValue(undefined), stop: jest.fn() }
    });
const connecting = (pools: any[]) => {
    const cluster = makeCluster(pools);
    cluster.connect().catch(() => undefined);
    return cluster;
};

describe('checkError in nodes()', () => {
    it('is on the node whose last check failed, and on no other node', () => {
        const info = { isValid: false, loadScore: 100000 };
        expect(makeCluster([node(1, DENIED), node(2), node(3, {})]).nodes()).toStrictEqual([
            { id: 1, name: 'node1', host: 'host1', port: 3301, ...info, checkError: DENIED },
            { id: 2, name: 'node2', host: 'host2', port: 3302, ...info },
            { id: 3, name: 'node3', host: 'host3', port: 3303, ...info, checkError: {} }
        ]);
    });

    it('is a new object on every call, which the cluster does not read back', () => {
        const cluster = makeCluster([node(1, DENIED)]);
        const first = cluster.nodes()[0].checkError;
        first.code = 'CHANGED';

        expect(cluster.nodes()[0].checkError).not.toBe(first);
        expect(cluster.nodes()[0].checkError).toStrictEqual(DENIED);
    });

    it('follows the pool: set after a failed check, gone after an answered one', () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        pools[0].lastCheck = REFUSED;
        expect(cluster.nodes()[0].checkError).toStrictEqual(REFUSED);

        pools[0].lastCheck = undefined;
        expect('checkError' in cluster.nodes()[0]).toBe(false);
    });
});

describe.each(['ready', 'firstReady'])('checkError in the results of %s', (member) => {
    it('is on the result of a node whose first check failed', async () => {
        const pools = [node(1), node(2)];
        const cluster = connecting(pools);
        const error = failCheck(pools[0], DENIED);
        pools[1].connects[0].pass();

        expect(await cluster[member]).toStrictEqual([
            { nodeId: 1, ok: false, error, checkError: DENIED }, { nodeId: 2, ok: true }
        ]);
    });

    it('is not on the result of a node the validator refused', async () => {
        const pools = [node(1)];
        const cluster = connecting(pools);
        const error = failCheck(pools[0], undefined);

        expect(await cluster[member]).toStrictEqual([{ nodeId: 1, ok: false, error }]);
    });

    it('is an empty object for a failure the package made itself', async () => {
        const pools = [node(1)];
        const cluster = connecting(pools);
        failCheck(pools[0], {});

        expect((await cluster[member])[0].checkError).toStrictEqual({});
    });

    it('is read when the connect of the pool settles, not when connect() is called', async () => {
        const pools = [node(1, REFUSED)];
        const cluster = connecting(pools);
        failCheck(pools[0], DENIED);

        expect((await cluster[member])[0].checkError).toStrictEqual(DENIED);
    });

    it('does not follow the pool after the result was made', async () => {
        const pools = [node(1)];
        const cluster = connecting(pools);
        failCheck(pools[0], DENIED);
        const [result] = await cluster[member];
        pools[0].lastCheck = undefined;

        expect(result.checkError).toStrictEqual(DENIED);
    });

    // one failed check does not take a valid pool out, so its connect() passes
    it('is on a passed result too, when the check failed on a valid pool', async () => {
        const pools = [node(1)];
        const cluster = connecting(pools);
        pools[0].lastCheck = REFUSED;
        pools[0].connects[0].pass();

        expect(await cluster[member]).toStrictEqual([{ nodeId: 1, ok: true, checkError: REFUSED }]);
    });

    describe('for a pool that was closed or connected again while it connected', () => {
        it('is an empty object, not the error of an earlier check', async () => {
            const pools = [node(1, DENIED)];
            const cluster = connecting(pools);
            pools[0].disconnect();
            pools[0].connects[0].fail(new Error('pool in host host1 was closed while connecting'));

            expect((await cluster[member])[0].checkError).toStrictEqual({});
        });

        it('is an empty object when the pool had no error at all', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            pools[0].disconnect();
            failCheck(pools[0], undefined);

            expect((await cluster[member])[0].checkError).toStrictEqual({});
        });

        it('is an empty object for the first of two connect() calls', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            const first = cluster[member];
            cluster.connect().catch(() => undefined);
            failCheck(pools[0], DENIED, 0);

            expect((await first)[0].checkError).toStrictEqual({});
        });

        // the pool was connected again, but this connect passed: its check got its answer
        it('is not on a passed result of the first of two connect() calls', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            const first = cluster[member];
            cluster.connect().catch(() => undefined);
            pools[0].connects[0].pass();

            expect(await first).toStrictEqual([{ nodeId: 1, ok: true }]);
        });

        it('is the error of the check for the second of two connect() calls', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            cluster.connect().catch(() => undefined);
            failCheck(pools[0], DENIED, 1);

            expect((await cluster[member])[0].checkError).toStrictEqual(DENIED);
        });
    });
});
