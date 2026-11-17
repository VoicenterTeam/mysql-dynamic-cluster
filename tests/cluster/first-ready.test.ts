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

// no socket and no timer here: a test that waits this long waits for a promise that never settles
jest.setTimeout(10000);

// a pool whose connect() ends when the test says so. One entry in `connects` per call
const node = (id: number): any => {
    const connects: { pass: () => void, fail: (error: any) => void }[] = [];
    const connect = jest.fn(() => new Promise<void>((resolve, reject) => {
        connects.push({ pass: resolve, fail: reject });
    }));
    return { id, host: 'host' + id, connect, connects, disconnect: jest.fn() };
};

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[], hashing: object = {}): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        connected: false,
        _pools: pools,
        _useClusterHashing: false,
        _clusterHashing: { connect: jest.fn().mockResolvedValue(undefined), stop: jest.fn() },
        ...hashing
    });

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
// 'pending', or what the promise settled with
const PENDING = { state: 'pending' };
const stateOf = async (promise: Promise<any>): Promise<any> => {
    await settle();
    return Promise.race([promise, PENDING])
        .then(value => value === PENDING ? 'pending' : { value }, error => ({ error }));
};
const down = (id: number) => new Error('pool in host host' + id + ' is not valid');

describe('GaleraCluster.firstReady', () => {
    it('is pending before connect() is called, and the same promise on every read', async () => {
        const cluster = makeCluster([node(1)]);
        const firstReady = cluster.firstReady;

        expect(firstReady).toBeInstanceOf(Promise);
        expect(cluster.firstReady).toBe(firstReady);
        expect(await stateOf(firstReady)).toBe('pending');
    });

    it('is not the promise behind ready', () => {
        const cluster = makeCluster([node(1)]);
        expect(cluster.firstReady).not.toBe(cluster.ready);
    });

    it('stays pending while every pool still connects', async () => {
        const cluster = makeCluster([node(1), node(2)]);
        cluster.connect();

        expect(await stateOf(cluster.firstReady)).toBe('pending');
    });

    it('resolves on the first pass, without the node that still connects', async () => {
        const pools = [node(1), node(2), node(3)];
        const cluster = makeCluster(pools);
        cluster.connect();
        pools[1].connects[0].pass();

        const first = await stateOf(cluster.firstReady);
        expect(first).toStrictEqual({ value: [{ nodeId: 2, ok: true }] });
        expect(await stateOf(cluster.ready)).toBe('pending');
    });

    it('holds the nodes that failed before the first pass, in the order of the nodes', async () => {
        const pools = [node(1), node(2), node(3), node(4)];
        const cluster = makeCluster(pools);
        const errors = [down(1), down(3)];
        cluster.connect().catch(() => undefined);
        pools[2].connects[0].fail(errors[1]);
        pools[0].connects[0].fail(errors[0]);
        await settle();
        pools[3].connects[0].pass();

        expect(await cluster.firstReady).toStrictEqual([
            { nodeId: 1, ok: false, error: errors[0] },
            { nodeId: 3, ok: false, error: errors[1] },
            { nodeId: 4, ok: true }
        ]);
    });

    it('resolves though connect() rejected on a node that failed first', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].fail(down(1));
        await expect(connecting).rejects.toBe('pool in host host1 is not valid');
        expect(await stateOf(cluster.firstReady)).toBe('pending');

        pools[1].connects[0].pass();
        expect((await cluster.firstReady).map((result: any) => [result.nodeId, result.ok]))
            .toEqual([[1, false], [2, true]]);
    });

    it('does not change when the other nodes settle after the first pass', async () => {
        const pools = [node(1), node(2), node(3)];
        const cluster = makeCluster(pools);
        cluster.connect();
        pools[0].connects[0].pass();
        const first = await cluster.firstReady;
        pools[1].connects[0].pass();
        pools[2].connects[0].fail(down(3));

        expect(await cluster.ready).toHaveLength(3);
        expect(await cluster.firstReady).toBe(first);
        expect(first).toStrictEqual([{ nodeId: 1, ok: true }]);
    });

    it('has at least one passed result when a node passed', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail(down(1));
        pools[1].connects[0].pass();

        expect((await cluster.firstReady).some((result: any) => result.ok)).toBe(true);
    });

    it('holds every result when the last node is the first that passes', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail(down(1));
        await settle();
        pools[1].connects[0].pass();

        expect(await cluster.firstReady).toStrictEqual(await cluster.ready);
    });

    describe('when no node passes', () => {
        it('stays pending until the last node failed', async () => {
            const pools = [node(1), node(2)];
            const cluster = makeCluster(pools);
            cluster.connect().catch(() => undefined);
            pools[0].connects[0].fail(down(1));

            expect(await stateOf(cluster.firstReady)).toBe('pending');
            pools[1].connects[0].fail(down(2));
            expect(await stateOf(cluster.firstReady)).not.toBe('pending');
        });

        it('resolves with every result, the value of ready', async () => {
            const pools = [node(1), node(2)];
            const cluster = makeCluster(pools);
            const errors = [down(1), down(2)];
            cluster.connect().catch(() => undefined);
            pools.forEach((pool, index) => pool.connects[0].fail(errors[index]));

            const state = await stateOf(cluster.firstReady);
            expect(state.value).toStrictEqual([
                { nodeId: 1, ok: false, error: errors[0] },
                { nodeId: 2, ok: false, error: errors[1] }
            ]);
            expect(state.value).toStrictEqual(await cluster.ready);
        });

        it('resolves at the moment ready does: neither is ahead by a turn', async () => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            const order: string[] = [];
            cluster.ready.then(() => order.push('ready'));
            cluster.firstReady.then(() => order.push('firstReady'));
            cluster.connect().catch(() => undefined);
            pools[0].connects[0].fail(down(1));
            // turn by turn, until the first of the two is in
            for (let turn = 0; turn < 20 && order.length === 0; turn++) await Promise.resolve();

            expect(order.sort()).toEqual(['firstReady', 'ready']);
        });

        it('resolves, and never rejects, whatever the pools failed with', async () => {
            const pools = [node(1), node(2), node(3)];
            const cluster = makeCluster(pools);
            cluster.connect().catch(() => undefined);
            pools[0].connects[0].fail(new Error('down'));
            pools[1].connects[0].fail('refused');
            pools[2].connects[0].fail(1045);

            const state = await stateOf(cluster.firstReady);
            expect(state.error).toBeUndefined();
            expect(state.value.map((result: any) => result.ok)).toEqual([false, false, false]);
        });
    });

    describe('over several connect() calls', () => {
        it('read before connect() is the promise the first connect() resolves', async () => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            const before = cluster.firstReady;
            cluster.connect();

            expect(cluster.firstReady).toBe(before);
            pools[0].connects[0].pass();
            expect(await before).toStrictEqual([{ nodeId: 1, ok: true }]);
        });

        it('is a new promise for each later connect(), with the results of that call', async () => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            cluster.connect();
            const first = cluster.firstReady;
            cluster.connect().catch(() => undefined);
            const second = cluster.firstReady;

            expect(second).not.toBe(first);
            pools[0].connects[1].fail(down(1));
            expect((await second)[0].ok).toBe(false);
            expect(await stateOf(first)).toBe('pending');
            pools[0].connects[0].pass();
            expect(await first).toStrictEqual([{ nodeId: 1, ok: true }]);
        });

        it('is a new promise after the first connect() too when it was never read', async () => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            cluster.connect();
            pools[0].connects[0].pass();
            cluster.connect();

            expect(await stateOf(cluster.firstReady)).toBe('pending');
            pools[0].connects[1].pass();
            expect(await cluster.firstReady).toStrictEqual([{ nodeId: 1, ok: true }]);
        });

        it.each([
            ['only firstReady was read before connect()', ['firstReady']],
            ['only ready was read before connect()', ['ready']],
            ['neither was read before connect()', []]
        ])('resolves both promises when %s', async (_name, readBefore) => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            const before = readBefore.map(member => cluster[member]);
            cluster.connect();
            pools[0].connects[0].pass();

            await Promise.all(before);
            expect(await cluster.ready).toStrictEqual([{ nodeId: 1, ok: true }]);
            expect(await cluster.firstReady).toStrictEqual([{ nodeId: 1, ok: true }]);
        });
    });

    it('resolves with an empty list for a cluster without nodes', async () => {
        const cluster = makeCluster([]);
        cluster.connect();
        expect(await stateOf(cluster.firstReady)).toStrictEqual({ value: [] });
    });

    it('resolves when the cluster is marked connected', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        cluster.connect();
        pools[1].connects[0].pass();
        await cluster.firstReady;

        expect(cluster.connected).toBe(true);
    });

    it('does not wait for the hashing that connect() waits for', async () => {
        const pools = [node(1), node(2)];
        const hashing = { connect: jest.fn(() => new Promise(() => undefined)), stop: jest.fn() };
        const cluster = makeCluster(pools, { _useClusterHashing: true, _clusterHashing: hashing });
        const connecting = cluster.connect();
        pools[0].connects[0].pass();

        const first = await stateOf(cluster.firstReady);
        expect(first).toStrictEqual({ value: [{ nodeId: 1, ok: true }] });
        expect(hashing.connect).toHaveBeenCalledTimes(1);
        expect(await stateOf(connecting)).toBe('pending');
    });
});

// connect() and ready keep what they did before firstReady existed
describe('GaleraCluster.connect, with firstReady beside it', () => {
    it('calls connect() of every pool once', () => {
        const pools = [node(1), node(2)];
        makeCluster(pools).connect();

        pools.forEach(pool => expect(pool.connect).toHaveBeenCalledTimes(1));
    });

    it('rejects with the message of the first failure, though a node passes later', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        connecting.catch(() => undefined);
        pools[0].connects[0].fail(down(1));
        await settle();
        pools[1].connects[0].pass();
        await cluster.firstReady;

        await expect(connecting).rejects.toBe('pool in host host1 is not valid');
    });

    it('resolves ready with every node, the ones firstReady held included', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        cluster.connect();
        pools[0].connects[0].pass();
        const first = await cluster.firstReady;
        pools[1].connects[0].pass();

        expect(await cluster.ready).toStrictEqual([...first, { nodeId: 2, ok: true }]);
    });
});
