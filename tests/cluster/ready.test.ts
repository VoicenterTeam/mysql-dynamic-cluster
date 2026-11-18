jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: {
        recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn(),
        registerPools: jest.fn(), unregisterPools: jest.fn()
    }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn(), disconnect: jest.fn() }
}));

import { runInNewContext } from 'vm';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';

// a pool whose connect() ends when the test says so. One entry in `connects` per call
const node = (id: number): any => {
    const connects: { pass: () => void, fail: (error: any) => void }[] = [];
    const connect = jest.fn(() => new Promise<void>((resolve, reject) => {
        connects.push({ pass: resolve, fail: reject });
    }));
    return { id, host: 'host' + id, connect, connects, disconnect: jest.fn() };
};

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[], useClusterHashing = false): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        connected: false,
        _pools: pools,
        _useClusterHashing: useClusterHashing,
        _clusterHashing: { connect: jest.fn().mockResolvedValue(undefined), stop: jest.fn() }
    });

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
// 'pending', or what the promise settled with
const PENDING = { state: 'pending' };
const stateOf = async (promise: Promise<any>): Promise<any> => {
    await settle();
    return Promise.race([promise, PENDING])
        .then(value => value === PENDING ? 'pending' : { value }, error => ({ error }));
};

describe('GaleraCluster.ready', () => {
    it('is pending before connect() is called, and the same promise on every read', async () => {
        const cluster = makeCluster([node(1)]);
        const ready = cluster.ready;

        expect(ready).toBeInstanceOf(Promise);
        expect(cluster.ready).toBe(ready);
        expect(await stateOf(ready)).toBe('pending');
    });

    it('resolves with one passed result per node once every pool connected', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools.forEach(pool => pool.connects[0].pass());

        await connecting;
        expect(await cluster.ready).toEqual([{ nodeId: 1, ok: true }, { nodeId: 2, ok: true }]);
    });

    it('stays pending while one pool still connects, though connect() resolved', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[1].connects[0].pass();

        await connecting;
        expect(await stateOf(cluster.ready)).toBe('pending');
        pools[0].connects[0].pass();
        expect((await stateOf(cluster.ready)).value).toHaveLength(2);
    });

    it('reports the node that failed with its error, in the order of the nodes', async () => {
        const pools = [node(1), node(2), node(3)];
        const cluster = makeCluster(pools);
        const error = new Error('pool in host host2 is not valid');
        cluster.connect().catch(() => undefined);
        pools[2].connects[0].pass();
        pools[1].connects[0].fail(error);
        pools[0].connects[0].pass();

        const results = await cluster.ready;
        expect(results).toEqual([
            { nodeId: 1, ok: true }, { nodeId: 2, ok: false, error }, { nodeId: 3, ok: true }
        ]);
        expect(results[1].error).toBe(error);
    });

    it('resolves, and never rejects, when every pool failed', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools.forEach(pool => pool.connects[0].fail(new Error('down ' + pool.id)));

        await expect(connecting).rejects.toBe('down 1');
        const state = await stateOf(cluster.ready);
        expect(state.error).toBeUndefined();
        expect(state.value.map((result: any) => [result.nodeId, result.ok, result.error.message]))
            .toEqual([[1, false, 'down 1'], [2, false, 'down 2']]);
    });

    it('wraps a failure that is not an Error in one', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail('refused');

        const [result] = await cluster.ready;
        expect(result.ok).toBe(false);
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe('refused');
    });

    // an error of Node itself is such an error for code that runs under jest
    it('keeps an Error that was made in another realm as it is', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const error = runInNewContext('new Error("refused")');
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail(error);

        expect(error instanceof Error).toBe(false);
        expect((await cluster.ready)[0].error).toBe(error);
    });

    it('read before connect() is the promise the first connect() resolves', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const before = cluster.ready;
        cluster.connect();

        expect(cluster.ready).toBe(before);
        pools[0].connects[0].pass();
        expect(await before).toEqual([{ nodeId: 1, ok: true }]);
    });

    it('is a new promise for each later connect(), with the results of that call', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        cluster.connect();
        const first = cluster.ready;
        cluster.connect().catch(() => undefined);
        const second = cluster.ready;

        expect(second).not.toBe(first);
        pools[0].connects[1].fail(new Error('second call failed'));
        expect((await second)[0].ok).toBe(false);
        expect(await stateOf(first)).toBe('pending');
        pools[0].connects[0].pass();
        expect(await first).toEqual([{ nodeId: 1, ok: true }]);
    });

    it('resolves with an empty list for a cluster without nodes', async () => {
        const cluster = makeCluster([]);
        cluster.connect();
        expect(await cluster.ready).toEqual([]);
    });
});

// connect() keeps what it did before `ready` existed
describe('GaleraCluster.connect', () => {
    it('resolves when the first pool connected, and announces the cluster once', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        let announced = 0;
        cluster.on('connected', () => announced++);
        const connecting = cluster.connect();
        pools[1].connects[0].pass();

        await expect(connecting).resolves.toBeUndefined();
        expect(cluster.connected).toBe(true);
        pools[0].connects[0].pass();
        await settle();
        expect(announced).toBe(1);
        pools.forEach(pool => expect(pool.connect).toHaveBeenCalledTimes(1));
    });

    it('rejects with the message of a failure that comes before the first success', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].fail(new Error('pool in host host1 is not valid'));
        await expect(connecting).rejects.toBe('pool in host host1 is not valid');

        // the pool that connects later still marks the cluster connected
        pools[1].connects[0].pass();
        await settle();
        expect(cluster.connected).toBe(true);
    });

    it('stays resolved when a pool fails after the first success', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].pass();
        await connecting;
        pools[1].connects[0].fail(new Error('down'));

        expect(await stateOf(connecting)).toEqual({ value: undefined });
    });

    it('enables hashing once, before it resolves, when hashing is on', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools, true);
        const connecting = cluster.connect();
        pools.forEach(pool => pool.connects[0].pass());

        await connecting;
        await settle();
        expect(cluster._clusterHashing.connect).toHaveBeenCalledTimes(1);
    });
});
