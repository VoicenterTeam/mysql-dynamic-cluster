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
import Metrics from '../../src/metrics/Metrics';
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
        (Redis.get as jest.Mock).mockReset();
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
        failing(A, () => {
            B.status.isValid = false;
            queueMicrotask(() => { B.status.isValid = true; });
        });
        expect(await makeCluster([A, B, C]).query('SELECT 1')).toBe('b');
    });

    it('leaves the first attempt as it was', async () => {
        A.query.mockResolvedValue('a');
        expect(await makeCluster([A, B, C]).query('SELECT 1')).toBe('a');
        expect(B.query).not.toHaveBeenCalled();
    });

    it('tells no step for a skipped node', async () => {
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

    it('records the query once, with the error of the last node tried', async () => {
        failing(A, () => { B.status.isValid = false; C.status.isValid = false; });
        await makeCluster([A, B, C]).query('SELECT 1').catch(() => undefined);

        expect(Metrics.recordQuery).toHaveBeenCalledTimes(1);
        expect(JSON.stringify((Metrics.recordQuery as jest.Mock).mock.calls[0]))
            .toContain('"code":"E1"');
    });

    it('reports the last node tried to onTiming when every node left is invalid', async () => {
        failing(A, () => { B.status.isValid = false; C.status.isValid = false; });
        const onTiming = jest.fn();
        await makeCluster([A, B, C]).query('SELECT 1', undefined, { onTiming }).catch(() => undefined);

        expect(onTiming).toHaveBeenCalledTimes(1);
        expect(onTiming.mock.calls[0][0]).toMatchObject({ nodeId: 1 });
    });

    it('tells the hashing the node that succeeded, after a pinned node and a skipped one', async () => {
        const hashing = {
            connected: true, getNodeByService: () => 3, updateNodeForService: jest.fn()
        };
        // pinned C first, then A by load score, B skipped
        failing(C, () => { B.status.isValid = false; });
        A.query.mockResolvedValue('a');
        const cluster = makeCluster([A, B, C]);
        cluster._clusterHashing = hashing;
        expect(await cluster.query('SELECT 1', undefined, { serviceId: 7 })).toBe('a');

        expect(B.query).not.toHaveBeenCalled();
        expect(hashing.updateNodeForService).toHaveBeenCalledWith(7, 1);
    });

    it('logs no retry when no node is left to ask', async () => {
        failing(A, () => { B.status.isValid = false; C.status.isValid = false; });
        await makeCluster([A, B, C]).query('SELECT 1').catch(() => undefined);

        expect((Logger.debug as jest.Mock).mock.calls.map(c => c[0]))
            .not.toContain('Retrying query...');
    });

    it('follows the same rule with execute: true', async () => {
        failing(A, () => { B.status.isValid = false; });
        C.query.mockResolvedValue('c');
        expect(await makeCluster([A, B, C]).query('SELECT ?', [1], { execute: true })).toBe('c');
        expect(B.query).not.toHaveBeenCalled();
    });
});
