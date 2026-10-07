jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { PoolStatus } from '../../src/pool/PoolStatus';

const settings = {
    validators: [{ key: 'Threads_running', operator: '<', value: 50 }], loadFactors: [],
    timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
} as any;
const busy = [{ Variable_name: 'Threads_running', Value: '80' }];

describe('PoolStatus.checkStatus reachability', () => {
    let status: PoolStatus;
    let pool: { host: string, query: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers();
        pool = { host: '127.0.0.1', query: jest.fn() };
        status = new PoolStatus(pool as any, settings, true);
    });

    afterEach(() => {
        status.stopTimerCheck();
        jest.useRealTimers();
    });

    it('a node that answers is reachable even when it fails a validator', async () => {
        pool.query.mockResolvedValueOnce(busy);
        await status.checkStatus();
        expect(status.isValid).toBe(false);
        expect(status.isReachable).toBe(true);
    });

    it('a node is unreachable before its first check passes', () => {
        expect(status.isReachable).toBe(false);
    });

    it('a node goes unreachable after two failed checks in a row, not after one', async () => {
        pool.query.mockResolvedValueOnce(busy);
        await status.checkStatus();

        pool.query.mockRejectedValue(new Error('connect ETIMEDOUT'));
        await status.checkStatus();
        expect(status.isReachable).toBe(true);
        await status.checkStatus();
        expect(status.isReachable).toBe(false);
    });
});
