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
import Metrics from '../../src/metrics/Metrics';

// connect() of a cluster without hosts, with a pool that rejects with no Error, and the pool
// metrics of a connect() that failed (#61)

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

describe('the pool metrics of a connect()', () => {
    it('are ended when every node failed', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail(down(1));
        pools[1].connects[0].fail(down(2));
        await cluster.ready;
        await settle();

        expect(Metrics.unregisterPools).toHaveBeenCalledTimes(1);
        expect(Metrics.unregisterPools).toHaveBeenCalledWith(pools);
    });

    it('are not ended before the last node settled', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        const connecting = cluster.connect();
        pools[0].connects[0].fail(down(1));

        expect(await stateOf(connecting)).toEqual({ error: 'pool in host host1 is not valid' });
        expect(Metrics.unregisterPools).not.toHaveBeenCalled();
    });

    // connect() rejected on the node that failed first, and the cluster is up on the other
    it('are kept when a node passed after the first failure', async () => {
        const pools = [node(1), node(2)];
        const cluster = makeCluster(pools);
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail(down(1));
        await settle();
        pools[1].connects[0].pass();
        await cluster.ready;
        await settle();

        expect(cluster.connected).toBe(true);
        expect(Metrics.unregisterPools).not.toHaveBeenCalled();
    });

    it('are kept when a later connect() call still runs', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        cluster.connect().catch(() => undefined);
        cluster.connect().catch(() => undefined);
        pools[0].connects[0].fail(down(1));
        await settle();

        expect(Metrics.unregisterPools).not.toHaveBeenCalled();
        pools[0].connects[1].fail(down(1));
        await settle();
        expect(Metrics.unregisterPools).toHaveBeenCalledTimes(1);
    });

    it('are kept when the cluster connected on an earlier call', async () => {
        const pools = [node(1)];
        const cluster = makeCluster(pools);
        cluster.connect();
        pools[0].connects[0].pass();
        await settle();
        cluster.connect().catch(() => undefined);
        pools[0].connects[1].fail(down(1));
        await settle();

        expect(Metrics.unregisterPools).not.toHaveBeenCalled();
    });
});
