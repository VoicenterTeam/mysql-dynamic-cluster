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

import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Logger from '../../src/utils/Logger';

// connect() of a cluster without hosts, with a pool that rejects with no Error, and a second
// connect() without disconnect() (#61)

// no socket and no timer here: a test that waits this long waits for a promise that never settles
jest.setTimeout(10000);

// a pool whose connect() ends when the test says so. One entry in `connects` per call
const node = (id: number): any => {
    const connects: { pass: () => void, fail: (error: any) => void }[] = [];
    const connect = jest.fn(() => new Promise<void>((resolve, reject) => {
        connects.push({ pass: resolve, fail: reject });
    }));
    return {
        id, name: 'node' + id, host: 'host' + id, connect, connects, disconnect: jest.fn(),
        status: { isValid: false, loadScore: id }
    };
};

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[]): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        connected: false,
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: 1,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _useClusterHashing: false,
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
const down = (id: number) => new Error('pool in host host' + id + ' is not valid');

beforeEach(() => jest.clearAllMocks());

describe('connect() of a cluster without hosts', () => {
    it('resolves at once', async () => {
        const cluster = makeCluster([]);

        expect(await stateOf(cluster.connect())).toEqual({ value: undefined });
    });

    it('leaves the cluster not connected, so a query finds no node', async () => {
        const cluster = makeCluster([]);
        await cluster.connect();

        expect(cluster.connected).toBe(false);
        await expect(cluster.query('SELECT 1')).rejects.toMatchObject({
            code: 'MDC_NO_NODE_AVAILABLE'
        });
    });
});

describe('ready and firstReady when a pool rejects with a value that is not text', () => {
    it.each([
        ['an object without a prototype', () => Object.create(null), 'unreadable error'],
        ['a Proxy whose every read throws', () => new Proxy({}, {
            get() { throw new Error('no read'); }
        }), 'unreadable error'],
        ['a revoked Proxy', () => {
            const { proxy, revoke } = Proxy.revocable({}, {});
            revoke();
            return proxy;
        }, 'unreadable error'],
        // instanceof asks the trap, the text comes from Object.prototype.toString
        ['a Proxy whose getPrototypeOf trap throws', () => new Proxy({}, {
            getPrototypeOf() { throw new Error('no prototype'); }
        }), '[object Object]']
    ])('resolve for %s, with an Error of their own, and connect() rejects',
        async (_name, make, text) => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            const connecting = cluster.connect();
            pools[0].connects[0].fail(make());

            expect(await stateOf(connecting)).toEqual({ error: text });
            const [ready] = await cluster.ready;
            expect(ready.ok).toBe(false);
            expect(ready.error).toBeInstanceOf(Error);
            expect(ready.error.message).toBe(text);
            expect((await cluster.firstReady)[0].error).toBe(ready.error);
        });
});

describe('connect() when a pool rejects with no Error', () => {
    it.each([
        ['undefined', undefined, 'undefined'],
        ['null', null, 'null'],
        ['a string', 'refused', 'refused'],
        ['a number', 1045, '1045'],
        ['an Error with an empty message', new Error(''), 'Error']
    ])('rejects with a string for %s', async (_name, rejection, reason) => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].fail(rejection);

        expect(await stateOf(connecting)).toEqual({ error: reason });
        expect(Logger.error).toHaveBeenCalledWith(reason);
    });

    it('rejects with a string when the message cannot be read', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].fail(Object.defineProperty({}, 'message', {
            get() { throw new Error('no read'); }
        }));

        expect(await stateOf(connecting)).toEqual({ error: 'unreadable error' });
    });

    it('keeps the message of an Error', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].fail(down(1));

        expect(await stateOf(connecting)).toEqual({ error: 'pool in host host1 is not valid' });
    });
});

// A second connect() without disconnect() keeps its own promise and its own ready and
// firstReady, and it settles (#61)
describe('a second connect() without disconnect()', () => {
    const passed = (id: number) => ({ nodeId: id, ok: true });

    it('settles within one tick when the cluster is connected', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const first = cluster.connect();
        pools[0].connects[0].pass();
        await first;

        const second = cluster.connect();
        await new Promise(resolve => setImmediate(resolve));
        expect(await stateOf(second)).toEqual({ value: undefined });
        expect(second).not.toBe(first);
    });

    it('still connects every pool, and its ready holds the results of its own call', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const first = cluster.connect();
        pools[0].connects[0].pass();
        await first;
        const firstReady = cluster.ready;

        cluster.connect().catch(() => undefined);
        expect(pools[0].connect).toHaveBeenCalledTimes(2);
        expect(cluster.ready).not.toBe(firstReady);
        expect(await stateOf(cluster.ready)).toBe('pending');
        pools[0].connects[1].fail(down(1));
        expect((await cluster.ready)[0].ok).toBe(false);
        expect(await firstReady).toStrictEqual([passed(1)]);
    });

    it('started while the first runs, resolves when the first resolves', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const first = cluster.connect();
        const second = cluster.connect();
        pools[0].connects[0].pass();

        expect(await stateOf(first)).toEqual({ value: undefined });
        expect(await stateOf(second)).toEqual({ value: undefined });
        // its own ready waits for its own pools
        expect(await stateOf(cluster.ready)).toBe('pending');
        pools[0].connects[1].pass();
        expect(await cluster.ready).toStrictEqual([passed(1)]);
    });

    // the first can fail because the second connect of its pool replaced its attempt
    it('started while the first runs, goes on with its own pools when the first rejects',
        async () => {
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            const first = cluster.connect();
            const second = cluster.connect();
            pools[0].connects[0].fail(down(1));

            expect(await stateOf(first)).toEqual({ error: 'pool in host host1 is not valid' });
            expect(await stateOf(second)).toBe('pending');
            pools[0].connects[1].pass();
            expect(await stateOf(second)).toEqual({ value: undefined });
        });

    it('started while the hashing of the first runs, resolves when that is done', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        let hashingDone: () => void;
        Object.assign(cluster, {
            _useClusterHashing: true,
            _clusterHashing: {
                connect: jest.fn(() => new Promise<void>(resolve => { hashingDone = resolve; })),
                stop: jest.fn()
            }
        });
        const first = cluster.connect();
        pools[0].connects[0].pass();
        await settle();
        const second = cluster.connect();

        expect(await stateOf(second)).toBe('pending');
        hashingDone();
        expect(await stateOf(first)).toEqual({ value: undefined });
        expect(await stateOf(second)).toEqual({ value: undefined });
        expect(cluster._clusterHashing.connect).toHaveBeenCalledTimes(1);
    });

    // the first rejected, and its other pool connected the cluster after the second began
    it('resolves when its own pool passes after another call connected the cluster',
        async () => {
            const pools = [node(1), node(2)];
            const cluster = makeCluster(pools);
            const first = cluster.connect();
            pools[0].connects[0].fail(down(1));
            expect(await stateOf(first)).toEqual({ error: 'pool in host host1 is not valid' });

            const second = cluster.connect();
            pools[1].connects[0].pass();
            await settle();
            expect(cluster.connected).toBe(true);
            pools[0].connects[1].pass();

            expect(await stateOf(second)).toEqual({ value: undefined });
        });

    it('after a connect() that failed is a new attempt, not the old rejection', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const first = cluster.connect();
        pools[0].connects[0].fail(down(1));
        expect(await stateOf(first)).toEqual({ error: 'pool in host host1 is not valid' });

        const second = cluster.connect();
        expect(await stateOf(second)).toBe('pending');
        pools[0].connects[1].pass();
        expect(await stateOf(second)).toEqual({ value: undefined });
    });

    it('after disconnect() waits for its own pools', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        const first = cluster.connect();
        pools[0].connects[0].pass();
        await first;
        await cluster.disconnect();

        const second = cluster.connect();
        expect(await stateOf(second)).toBe('pending');
        pools[0].connects[1].pass();
        expect(await stateOf(second)).toEqual({ value: undefined });
    });
});

// A connect() that disconnect() came after, whose pool passes late (#61)
describe('a pass of a connect() that disconnect() came after', () => {
    const withHashing = (cluster: any) => Object.assign(cluster, {
        _useClusterHashing: true,
        _clusterHashing: { connect: jest.fn().mockResolvedValue(undefined), stop: jest.fn() }
    });

    it('leaves the cluster disconnected and starts no hashing', async () => {
        const pools = [node(1)];
        const cluster = withHashing(makeCluster(pools));
        const connecting = cluster.connect();
        await cluster.disconnect();
        pools[0].connects[0].pass();

        expect(await stateOf(connecting)).toEqual({ value: undefined });
        expect(cluster.connected).toBe(false);
        expect(cluster._clusterHashing.connect).not.toHaveBeenCalled();
    });

    it('does not count for the connect() after the disconnect()', async () => {
        const pools = [node(1)];
        const cluster = withHashing(makeCluster(pools));
        cluster.connect();
        await cluster.disconnect();
        const second = cluster.connect();
        pools[0].connects[0].pass();

        expect(await stateOf(second)).toBe('pending');
        expect(cluster.connected).toBe(false);
        pools[0].connects[1].pass();
        expect(await stateOf(second)).toEqual({ value: undefined });
        expect(cluster.connected).toBe(true);
        expect(cluster._clusterHashing.connect).toHaveBeenCalledTimes(1);
    });
});

// disconnect() while the hashing of the pass that connected the cluster runs (#61)
describe('a disconnect() during the hashing of the connect of the cluster', () => {
    const emitted: string[] = [];
    beforeAll(() => {
        const Events = require('../../src/utils/Events').default;
        ['connected', 'hashing_created', 'disconnected'].forEach(name =>
            Events.on(name, () => emitted.push(name)));
    });
    beforeEach(() => emitted.splice(0));

    it('leaves no connected or hashing_created event after disconnected', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        let hashingDone: () => void;
        Object.assign(cluster, {
            _useClusterHashing: true,
            _clusterHashing: {
                connect: jest.fn(() => new Promise<void>(resolve => { hashingDone = resolve; })),
                stop: jest.fn()
            }
        });
        const connecting = cluster.connect();
        pools[0].connects[0].pass();
        await settle();
        expect(cluster._clusterHashing.connect).toHaveBeenCalledTimes(1);
        await cluster.disconnect();
        hashingDone();
        await stateOf(connecting);

        expect(emitted).toEqual(['disconnected']);
        expect(Logger.info).not.toHaveBeenCalledWith('Cluster connected');
        expect(cluster.connected).toBe(false);
    });

    it('still gives both events when nothing disconnects', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        Object.assign(cluster, {
            _useClusterHashing: true,
            _clusterHashing: { connect: jest.fn().mockResolvedValue(undefined), stop: jest.fn() }
        });
        const connecting = cluster.connect();
        pools[0].connects[0].pass();

        expect(await stateOf(connecting)).toEqual({ value: undefined });
        expect(emitted).toEqual(['hashing_created', 'connected']);
    });
});

// The 'connected' event is emitted by the connect of the cluster. Events is one emitter per
// module, so the listener throws only while the test asks it to
describe('a connected listener that throws', () => {
    let throwing = false;
    beforeAll(() => {
        const Events = require('../../src/utils/Events').default;
        Events.on('connected', () => {
            if (throwing) throw new Error('listener failed');
        });
    });
    afterEach(() => { throwing = false; });

    it('makes that connect() reject, and a later one reject at once with the same reason',
        async () => {
            throwing = true;
            const pools = [node(1)];
            const cluster = makeCluster(pools);
            const first = cluster.connect();
            pools[0].connects[0].pass();
            expect(await stateOf(first)).toEqual({ error: 'listener failed' });

            const second = cluster.connect().catch((reason: string) => reason);
            await new Promise(resolve => setImmediate(resolve));
            expect(await stateOf(second)).toEqual({ value: 'listener failed' });
        });
});