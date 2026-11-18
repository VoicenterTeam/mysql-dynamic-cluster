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

import { getEventListeners } from 'events';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';

// nothing here waits for a clock or a socket: a test that hangs is a bug
jest.setTimeout(10000);

// What the cluster reads of a pool. getConnection gets the signal and the outcome object of
// the call, and a test settles the call through `asked`
const node = (id: number, loadScore: number, isValid = true): any => {
    const pool: any = {
        id, name: 'node' + id, host: 'host' + id, port: 3300 + id, connectionLimit: 10,
        status: { isValid, loadScore },
        asked: [],
        getConnection: jest.fn((signal?: any, outcome?: any) => new Promise((resolve, reject) => {
            pool.asked.push({ signal, outcome, resolve, reject });
        }))
    };
    return pool;
};

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[]): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });

const acquires = (pools: any[]): number =>
    pools.reduce((count, pool) => count + pool.getConnection.mock.calls.length, 0);

// How a promise stands one turn of the event loop from now. No timer: a promise that is still
// pending then is one that waits for something the test has not done yet
const stateOf = (promise: Promise<any>): Promise<any> => Promise.race([
    promise.then(value => ({ resolved: value }), reason => ({ rejected: reason })),
    new Promise(resolve => setImmediate(() => resolve('pending')))
]);

// A request whose rejection always has a handler. Without one, an assertion that fails before
// the test reads the request leaves an unhandled rejection, which ends the worker instead of
// failing the test
const quiet = (request: Promise<any>): Promise<any> => {
    request.catch(() => undefined);
    return request;
};

// the three members the cluster asks of a signal, on an object of no signal class
const signalLike = (aborted = false): any => ({
    aborted, addEventListener: jest.fn(), removeEventListener: jest.fn()
});

describe('GaleraCluster.getConnection with a signal', () => {
    it('hands the signal to the pool of the node it picked, and to no other', async () => {
        const pools = [node(1, 30), node(2, 10)];
        const { signal } = new AbortController();
        const request = quiet(makeCluster(pools).getConnection({ signal }));
        expect(pools[1].asked[0].signal).toBe(signal);

        pools[1].asked[0].resolve({ threadId: 2 });
        expect(await request).toEqual({ connection: { threadId: 2 }, nodeId: 2 });
        expect(acquires(pools)).toBe(1);
    });

    it('reads exclude as before', async () => {
        const pools = [node(1, 30), node(2, 10)];
        const { signal } = new AbortController();
        makeCluster(pools).getConnection({ exclude: [2], signal }).catch(() => undefined);

        expect(pools[0].asked[0].signal).toBe(signal);
        expect(pools[1].getConnection).not.toHaveBeenCalled();
    });

    it.each([
        ['no options', undefined],
        ['empty options', {}],
        ['signal set to undefined', { signal: undefined }],
        ['signal set to null', { signal: null }]
    ])('hands the pool no signal with %s', async (_name, options) => {
        const pools = [node(1, 10)];
        const request = quiet(makeCluster(pools).getConnection(options));
        expect(pools[0].asked[0].signal).toBeUndefined();

        pools[0].asked[0].resolve({ threadId: 1 });
        expect((await request).nodeId).toBe(1);
    });

    it.each([
        ['an object with the three members a signal has', signalLike()],
        ['a function that has them', Object.assign(() => undefined, signalLike())],
        ['an instance of another class that has them', new (class Polyfill {
            aborted = false;
            addEventListener() { return undefined; }
            removeEventListener() { return undefined; }
        })()]
    ])('takes %s as a signal', async (_name, signal) => {
        const pools = [node(1, 10)];
        makeCluster(pools).getConnection({ signal }).catch(() => undefined);

        expect(pools[0].asked[0].signal).toBe(signal);
    });
});

describe('GaleraCluster.getConnection with a signal that is already aborted', () => {
    it('rejects with the reason and asks no node', async () => {
        const pools = [node(1, 30), node(2, 10)];
        const cluster = makeCluster(pools);
        const validPools = jest.spyOn(cluster, '_validPools');
        const reason = new Error('too late');

        const state = await stateOf(cluster.getConnection({ signal: AbortSignal.abort(reason) }));
        expect(state.rejected).toBe(reason);
        expect(validPools).not.toHaveBeenCalled();
        expect(acquires(pools)).toBe(0);
    });

    it.each([
        ['no node is valid', [node(1, 10, false)], undefined],
        ['every valid node is excluded', [node(1, 10)], [1]],
        ['the cluster has no node', [], undefined]
    ])('rejects with the reason, not with MDC_NO_NODE_AVAILABLE, when %s', async (
        _name, pools, exclude
    ) => {
        const reason = new Error('too late');
        const signal = AbortSignal.abort(reason);

        const state = await stateOf(makeCluster(pools).getConnection({ exclude, signal }));
        expect(state.rejected).toBe(reason);
    });

    it('adds no listener to the signal', async () => {
        const signal = AbortSignal.abort(new Error('too late'));
        const added = jest.spyOn(signal, 'addEventListener');

        await stateOf(makeCluster([node(1, 10)]).getConnection({ signal }));
        expect(added).not.toHaveBeenCalled();
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    it('rejects with an Error named AbortError when the signal has no reason', async () => {
        const pools = [node(1, 10)];
        const signal = signalLike(true);

        const state = await stateOf(makeCluster(pools).getConnection({ signal }));
        expect(state.rejected).toBeInstanceOf(Error);
        expect(state.rejected.name).toBe('AbortError');
        expect(acquires(pools)).toBe(0);
    });
});

describe('GaleraCluster.getConnection rejected by an abort', () => {
    // the pool marks the outcome object of the call and rejects with the reason
    const abort = (asked: any, reason: unknown): void => {
        asked.outcome.aborted = true;
        asked.reject(reason);
    };

    it.each([
        ['an Error', new Error('gave up')],
        ['a plain object', { why: 'deadline' }],
        ['a string', 'gave up'],
        ['null', null]
    ])('rejects with the reason as it is: %s', async (_name, reason) => {
        const pools = [node(1, 10)];
        const { signal } = new AbortController();
        const request = quiet(makeCluster(pools).getConnection({ signal }));

        abort(pools[0].asked[0], reason);
        expect((await stateOf(request)).rejected).toBe(reason);
    });

    it.each([
        ['an Error', new Error('gave up'), []],
        ['a plain object', { why: 'deadline' }, ['why']]
    ])('adds no nodeId to the reason, nor anything else: %s', async (_name, reason, keys) => {
        const pools = [node(1, 10)];
        const { signal } = new AbortController();
        const request = quiet(makeCluster(pools).getConnection({ signal }));

        abort(pools[0].asked[0], reason);
        await stateOf(request);
        expect('nodeId' in reason).toBe(false);
        expect(Object.keys(reason)).toEqual(keys);
    });

    it('hands every call an outcome object of its own', async () => {
        const pools = [node(1, 10)];
        const cluster = makeCluster(pools);
        const { signal } = new AbortController();
        const aborted = quiet(cluster.getConnection({ signal }));
        const failed = quiet(cluster.getConnection({ signal }));
        const error = new Error('Access denied');

        abort(pools[0].asked[0], new Error('gave up'));
        pools[0].asked[1].reject(error);
        await stateOf(aborted);
        expect((await stateOf(failed)).rejected).toBe(error);
        expect(error).toHaveProperty('nodeId', 1);
    });
});

describe('GaleraCluster.getConnection with a signal, rejected by an error', () => {
    it('adds the nodeId to the error of the node, as without a signal', async () => {
        const pools = [node(1, 30), node(2, 10)];
        const { signal } = new AbortController();
        const request = quiet(makeCluster(pools).getConnection({ signal }));
        const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

        pools[1].asked[0].reject(error);
        expect((await stateOf(request)).rejected).toBe(error);
        expect({ ...error }).toEqual({ code: 'ECONNREFUSED', nodeId: 2 });
    });

    // the pool says which of the two ended the call. The state of the signal does not
    it('adds the nodeId to an error of the node when the signal is aborted by then', async () => {
        const pools = [node(1, 10)];
        const controller = new AbortController();
        const request = quiet(makeCluster(pools).getConnection({ signal: controller.signal }));
        const error = new Error('node 1 is leaving');

        controller.abort(error);
        pools[0].asked[0].reject(error);
        expect((await stateOf(request)).rejected).toBe(error);
        expect(error).toHaveProperty('nodeId', 1);
    });
});

describe('GaleraCluster.getConnection with a signal that is no AbortSignal', () => {
    // the whole text, as the issue names it
    const NO_SIGNAL = 'getConnection: options.signal must be an AbortSignal';

    it.each([
        ['a string', 'abort'],
        ['a number', 1],
        ['true', true],
        ['false', false],
        ['zero', 0],
        ['an empty string', ''],
        ['a function', () => undefined],
        ['a symbol', Symbol('abort')],
        ['an empty object', {}],
        ['an array', []],
        ['an AbortController', new AbortController()],
        ['an object without aborted', { ...signalLike(), aborted: undefined }],
        ['an object whose aborted is no boolean', { ...signalLike(), aborted: 'no' }],
        ['an object without addEventListener', { ...signalLike(), addEventListener: undefined }],
        ['an object without removeEventListener', {
            ...signalLike(), removeEventListener: undefined
        }]
    ])('rejects with a TypeError that names signal when it is %s', async (_name, signal) => {
        const pools = [node(1, 30), node(2, 10)];
        const state = await stateOf(makeCluster(pools).getConnection({ signal }));

        expect(state.rejected).toBeInstanceOf(TypeError);
        expect(state.rejected.message).toBe(NO_SIGNAL);
        expect(acquires(pools)).toBe(0);
    });

    it('rejects with that TypeError when no node is valid too', async () => {
        const state = await stateOf(
            makeCluster([node(1, 10, false)]).getConnection({ signal: 'abort' })
        );

        expect(state.rejected).toBeInstanceOf(TypeError);
        expect(state.rejected.message).toBe(NO_SIGNAL);
    });

    it('rejects with the TypeError of exclude when the signal is already aborted', async () => {
        const options = { exclude: '2', signal: AbortSignal.abort(new Error('too late')) };
        const state = await stateOf(makeCluster([node(1, 10)]).getConnection(options));

        // the TypeError about exclude, not the reason and not the TypeError about the signal
        expect(state.rejected).toBeInstanceOf(TypeError);
        expect(state.rejected.message).not.toBe(NO_SIGNAL);
    });
});
