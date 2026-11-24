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
import Logger from '../../src/utils/Logger';
import Redis from '../../src/Redis/Redis';

const node = (id: number, loadScore: number): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore },
    query: jest.fn()
});

const makeCluster = (pools: any[], errorRetryCount = pools.length, useRedis = false): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: useRedis,
        _errorRetryCount: errorRetryCount,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });

// every pool fails before the statement went out; `after` runs in the pool, as the world
// changes while the call waits there
const failing = (pool: any, after?: () => void) =>
    pool.query.mockImplementation((_sql: string, _options: object, outcome: any) => {
        outcome.sent = false;
        if (after) after();
        return Promise.reject(Object.assign(new Error('down' + pool.id), { code: 'E' + pool.id }));
    });

describe('a retry skips the nodes that are no longer valid (#151)', () => {
    let A: any, B: any, C: any;
    beforeEach(() => {
        jest.clearAllMocks();
        // by load score the order is A, B, C
        A = node(1, 10); B = node(2, 20); C = node(3, 30);
    });

    it('does not ask a node that went invalid while the call waited at the one before', async () => {
        failing(A, () => { B.status.isValid = false; });
        C.query.mockResolvedValue([[{ ok: 1 }]]);
        const res = await makeCluster([A, B, C]).query('SELECT 1', undefined, { redis: false });

        expect(res).toEqual([[{ ok: 1 }]]);
        expect(B.query).not.toHaveBeenCalled();
        expect(C.query).toHaveBeenCalledTimes(1);
    });

    it('does not count a skipped node as a try: maxRetry 2 still reaches C', async () => {
        failing(A, () => { B.status.isValid = false; });
        C.query.mockResolvedValue('c');
        const res = await makeCluster([A, B, C]).query('SELECT 1', undefined, { maxRetry: 2 });

        expect(res).toBe('c');
        expect(B.query).not.toHaveBeenCalled();
    });

    it('still caps the nodes tried by maxRetry', async () => {
        failing(A); failing(B); failing(C);
        await expect(makeCluster([A, B, C]).query('SELECT 1', undefined, { maxRetry: 2 }))
            .rejects.toMatchObject({ nodeId: 2 });
        expect(C.query).not.toHaveBeenCalled();
    });

    it('rejects with the error of the last node tried when every node left is invalid', async () => {
        failing(A, () => { B.status.isValid = false; C.status.isValid = false; });
        const error: any = await makeCluster([A, B, C]).query('SELECT 1').catch(e => e);

        expect(error.code).toBe('E1');
        expect(error.nodeId).toBe(1);
        expect(error.errors).toEqual([]);
        expect(B.query).not.toHaveBeenCalled();
        expect(C.query).not.toHaveBeenCalled();
    });

    it('lists the earlier errors as today when the node tried last is not the first', async () => {
        failing(A); failing(B, () => { C.status.isValid = false; });
        const error: any = await makeCluster([A, B, C]).query('SELECT 1').catch(e => e);

        expect(error.nodeId).toBe(2);
        expect(error.errors).toEqual([expect.objectContaining({ nodeId: 1 })]);
    });

    it('asks a node that went invalid and came back valid before its turn', async () => {
        // valid when the call starts, invalid while A is asked, valid again before its turn
        B.query.mockResolvedValue('b');
        failing(A, () => { B.status.isValid = false; B.status.isValid = true; });
        expect(await makeCluster([A, B, C]).query('SELECT 1')).toBe('b');
    });

    it('leaves the first attempt as it was', async () => {
        A.query.mockResolvedValue('a');
        expect(await makeCluster([A, B, C]).query('SELECT 1')).toBe('a');
        expect(B.query).not.toHaveBeenCalled();
    });

    it('tells no step for a skipped node', async () => {
        failing(A, () => { B.status.isValid = false; });
        C.query.mockImplementation((_s: string, _o: object, _out: any, call: any) => {
            call.timing.enter('connecting');
            return Promise.resolve('c');
        });
        A.query.mockImplementation((_s: string, _o: object, outcome: any, call: any) => {
            call.timing.enter('connecting');
            B.status.isValid = false;
            outcome.sent = false;
            return Promise.reject(new Error('down'));
        });
        const onStep = jest.fn();
        await makeCluster([A, B, C]).query('SELECT 1', undefined, { onStep });

        expect(onStep.mock.calls.map(c => c[1])).toEqual([1, 3]);
    });

    it('logs a debug line naming the skipped node', async () => {
        failing(A, () => { B.status.isValid = false; });
        C.query.mockResolvedValue('c');
        await makeCluster([A, B, C]).query('SELECT 1');

        expect((Logger.debug as jest.Mock).mock.calls.map(c => c[0]))
            .toContainEqual(expect.stringContaining('skips pool node2'));
    });

    it('serves stale Redis data when every node left is invalid', async () => {
        failing(A, () => { B.status.isValid = false; C.status.isValid = false; });
        (Redis.get as jest.Mock).mockResolvedValue(
            JSON.stringify({ expired: Date.now() - 1000, data: 'stale' })
        );
        const res = await makeCluster([A, B, C], 3, true).query('SELECT 1', undefined, { redis: true });

        expect(res).toBe('stale');
        expect(B.query).not.toHaveBeenCalled();
    });

    it('follows the same rule with execute: true', async () => {
        failing(A, () => { B.status.isValid = false; });
        C.query.mockResolvedValue('c');
        expect(await makeCluster([A, B, C]).query('SELECT ?', [1], { execute: true })).toBe('c');
        expect(B.query).not.toHaveBeenCalled();
    });
});
