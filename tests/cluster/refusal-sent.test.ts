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
import Redis from '../../src/Redis/Redis';

// query() and execute() reject with sent: false when they refuse a call before any node is
// asked. The reason of an aborted signal, an error of the app's values and getConnection()
// carry no sent.
const makeCluster = (valid = true, useRedis = false) => {
    const poolQuery = jest.fn().mockResolvedValue([]);
    const cluster: GaleraCluster = Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: [{ id: 1, status: { isValid: valid, loadScore: 0 }, query: poolQuery }],
        _useRedis: useRedis,
        _errorRetryCount: 1,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });
    return { cluster, poolQuery };
};
const fail = (call: Promise<unknown>) => call.then(() => { throw new Error('resolved'); }, e => e);

beforeEach(() => jest.clearAllMocks());

describe('a refusal before any node has sent: false', () => {
    it.each([
        ['signal that is not an AbortSignal', (c: GaleraCluster) =>
            c.query('SELECT 1', [], { signal: {} as any }), TypeError],
        ['negative timeout', (c: GaleraCluster) =>
            c.query('SELECT 1', [], { timeout: -1 }), TypeError],
        ['onTiming that is not a function', (c: GaleraCluster) =>
            c.query('SELECT 1', [], { onTiming: 1 as any }), TypeError],
        ['execute values that are not an array', (c: GaleraCluster) =>
            c.query('SELECT ?', { a: 1 } as any, { execute: true }), TypeError],
        ['execute values with undefined', (c: GaleraCluster) =>
            c.query('SELECT ?', [undefined], { execute: true }), TypeError],
        ['execute values with a function', (c: GaleraCluster) =>
            c.query('SELECT ?', [() => 1], { execute: true }), TypeError],
        ['execute values that are a sparse array', (c: GaleraCluster) =>
            c.query('SELECT ?, ?', [1, , 3] as any, { execute: true }), TypeError]
    ])('%s', async (_name, call, type) => {
        const { cluster, poolQuery } = makeCluster();

        const error = await fail(call(cluster));

        expect(error).toBeInstanceOf(type);
        expect(error.sent).toBe(false);
        expect(poolQuery).not.toHaveBeenCalled();
    });

    it('MDC_QUOTED_PLACEHOLDER', async () => {
        const { cluster } = makeCluster();

        const error = await fail(cluster.query("SELECT ':a'", { a: 1 }));

        expect(error.code).toBe('MDC_QUOTED_PLACEHOLDER');
        expect(error.sent).toBe(false);
    });

    it('MDC_UNSAFE_COMMENT_VALUE', async () => {
        const { cluster } = makeCluster();

        const error = await fail(cluster.query('SELECT 1 /*+ ? */', ['*/ x']));

        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
        expect(error.sent).toBe(false);
    });

    it('MDC_NO_NODE_AVAILABLE of query()', async () => {
        const { cluster } = makeCluster(false);

        const error = await fail(cluster.query('SELECT 1'));

        expect(error.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(error.sent).toBe(false);
    });

    it('MDC_NO_NODE_AVAILABLE of execute()', async () => {
        const { cluster } = makeCluster(false);

        const error = await fail(cluster.query('SELECT ?', [1], { execute: true }));

        expect(error.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(error.sent).toBe(false);
    });

    it('MDC_NO_NODE_AVAILABLE when Redis has no stale data', async () => {
        const { cluster } = makeCluster(false, true);
        (Redis.get as jest.Mock).mockResolvedValueOnce(null);

        const error = await fail(cluster.query('SELECT 1'));

        expect(error.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(error.sent).toBe(false);
    });
});

describe('errors that get no sent', () => {
    it('the reason of an aborted signal has no own sent', async () => {
        const { cluster } = makeCluster();
        const reason = new Error('gave up');

        const error = await fail(cluster.query('SELECT 1', [], { signal: AbortSignal.abort(reason) }));

        expect(error).toBe(reason);
        expect(Object.prototype.hasOwnProperty.call(error, 'sent')).toBe(false);
    });

    it('the error of a toSqlString() that throws has no sent', async () => {
        const { cluster } = makeCluster();
        const own = new Error('app error');

        const error = await fail(cluster.query('SELECT ?', [{ toSqlString: () => { throw own; } }]));

        expect(error).toBe(own);
        expect(Object.prototype.hasOwnProperty.call(error, 'sent')).toBe(false);
    });

    it('a TypeError of getConnection() has no sent', async () => {
        const { cluster } = makeCluster();

        const error = await fail(cluster.getConnection({ exclude: 'x' } as any));

        expect(error).toBeInstanceOf(TypeError);
        expect(Object.prototype.hasOwnProperty.call(error, 'sent')).toBe(false);
    });

    it('MDC_NO_NODE_AVAILABLE of getConnection() has no sent', async () => {
        const { cluster } = makeCluster(false);

        const error = await fail(cluster.getConnection());

        expect(error.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(Object.prototype.hasOwnProperty.call(error, 'sent')).toBe(false);
    });
});
