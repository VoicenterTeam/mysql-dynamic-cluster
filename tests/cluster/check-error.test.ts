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
import Logger from '../../src/utils/Logger';

// no socket and no timer here: a test that waits this long waits for a promise that never settles
jest.setTimeout(10000);

const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };
const REFUSED = { code: 'ECONNREFUSED', errno: -111 };

// What the cluster reads of a pool. connect() ends when the test says so. It takes the outcome
// object of its caller and says at once that no check is recorded yet, as the pool does.
// checkError is what nodes() reads: a new object on every read, as in the pool
const node = (id: number, checkError?: object): any => {
    const connects: { pass: () => void, fail: (error: any) => void, outcome: any }[] = [];
    const pool: any = {
        id, name: 'node' + id, host: 'host' + id, port: 3300 + id,
        status: { isValid: false, loadScore: 100000 },
        lastCheck: checkError,
        get checkError() { return this.lastCheck && { ...this.lastCheck }; },
        connects,
        disconnect: jest.fn()
    };
    pool.connect = jest.fn((outcome: any) => new Promise<void>((resolve, reject) => {
        outcome.recorded = false;
        connects.push({ pass: resolve, fail: reject, outcome });
    }));
    return pool;
};
// the check of one connect() ends and is recorded: with an error, or with an answer
const record = (pool: any, checkError?: object, call = 0) => {
    pool.lastCheck = checkError;
    const error = checkError && { checkError: { ...checkError } };
    Object.assign(pool.connects[call].outcome, { recorded: true }, error);
};
// a connect() fails, as it does after a check that failed or that a validator refused
const fail = (pool: any, call = 0) => {
    const error = new Error('pool in host ' + pool.host + ' is not valid');
    pool.connects[call].fail(error);
    return error;
};
// the check of a connect() is recorded and that connect() fails
const failCheck = (pool: any, checkError?: object, call = 0) => {
    record(pool, checkError, call);
    return fail(pool, call);
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
// the debug lines about a result that got an empty object, as [message, fields]
const DROPPED = 'The connect of a node ended without a recorded health check, ' +
    'its result gets an empty checkError';
const droppedLines = () => (Logger.debug as jest.Mock).mock.calls
    .filter(call => call[0] === DROPPED);

beforeEach(() => jest.clearAllMocks());

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

    it('is the error of the check of that connect, not what the pool holds by then', async () => {
        const pools = [node(1)];
        const cluster = connecting(pools);
        record(pools[0], DENIED);
        pools[0].lastCheck = REFUSED;
        fail(pools[0]);

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
        record(pools[0], REFUSED);
        pools[0].connects[0].pass();

        expect(await cluster[member]).toStrictEqual([{ nodeId: 1, ok: true, checkError: REFUSED }]);
    });

    it('is not there for a pool that tells nothing about its check', async () => {
        const silent = { id: 1, connect: jest.fn(() => Promise.reject(new Error('down'))) };
        const cluster = connecting([silent]);

        expect(Object.keys((await cluster[member])[0])).toEqual(['nodeId', 'ok', 'error']);
        expect(droppedLines()).toEqual([]);
    });

    describe('for a connect whose check was dropped, or that ran none', () => {
        it('is an empty object on a failed result', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            const error = fail(pools[0]);

            expect(await cluster[member])
                .toStrictEqual([{ nodeId: 1, ok: false, error, checkError: {} }]);
        });

        it('is an empty object, not the error the pool holds from an earlier check', async () => {
            const pools = [node(1, DENIED)];
            const cluster = connecting(pools);
            fail(pools[0]);

            expect((await cluster[member])[0].checkError).toStrictEqual({});
        });

        // a pool that was valid before passes, though no check of this connect was recorded
        it('is not on a passed result, whatever the pool holds from an earlier check', async () => {
            const pools = [node(1, REFUSED)];
            const cluster = connecting(pools);
            pools[0].connects[0].pass();

            expect(await cluster[member]).toStrictEqual([{ nodeId: 1, ok: true }]);
        });

        it('is logged at debug for the failed result, with the node', async () => {
            const pools = [node(1), node(2)];
            const cluster = connecting(pools);
            fail(pools[1]);
            pools[0].connects[0].pass();
            await cluster[member];
            await cluster.ready;

            expect(droppedLines()).toEqual([[DROPPED, { nodeId: 2, pool: 'node2' }]]);
        });
    });

    describe('for a connect whose check was recorded', () => {
        it('is not logged as dropped, with an error or without', async () => {
            const pools = [node(1), node(2)];
            const cluster = connecting(pools);
            failCheck(pools[0], DENIED);
            failCheck(pools[1], undefined);
            await cluster[member];

            expect(droppedLines()).toEqual([]);
        });

        it('is the error of its own check for each of two connect() calls', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            const first = cluster[member];
            cluster.connect().catch(() => undefined);
            failCheck(pools[0], DENIED, 0);
            failCheck(pools[0], REFUSED, 1);

            expect((await first)[0].checkError).toStrictEqual(DENIED);
            expect((await cluster[member])[0].checkError).toStrictEqual(REFUSED);
        });

        // the pool was connected again, but this connect passed: its check got its answer
        it('is not on a passed result of the first of two connect() calls', async () => {
            const pools = [node(1)];
            const cluster = connecting(pools);
            const first = cluster[member];
            cluster.connect().catch(() => undefined);
            record(pools[0], undefined, 0);
            pools[0].connects[0].pass();

            expect(await first).toStrictEqual([{ nodeId: 1, ok: true }]);
        });
    });
});

describe('the results of ready and of firstReady', () => {
    // a write through one of the two does not show in the other
    it.each([
        ['a node passed', (pool: any) => pool.connects[0].pass()],
        ['no node passed', (pool: any) => failCheck(pool, REFUSED)]
    ])('are objects of their own when %s', async (_name, endSecond) => {
        const pools = [node(1), node(2)];
        const cluster = connecting(pools);
        failCheck(pools[0], DENIED);
        endSecond(pools[1]);
        const [first, ready] = [await cluster.firstReady, await cluster.ready];
        first[0].ok = true;
        first[0].checkError.code = 'CHANGED_BY_APP';
        first[1].nodeId = 99;

        expect(ready[0]).toMatchObject({ nodeId: 1, ok: false, checkError: DENIED });
        expect(ready[1].nodeId).toBe(2);
    });

    it('still share the Error of a node that failed', async () => {
        const pools = [node(1)];
        const cluster = connecting(pools);
        const error = failCheck(pools[0], DENIED);

        expect((await cluster.firstReady)[0].error).toBe(error);
        expect((await cluster.ready)[0].error).toBe(error);
    });
});
