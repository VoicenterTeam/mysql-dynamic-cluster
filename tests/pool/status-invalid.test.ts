jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { PoolStatus } from '../../src/pool/PoolStatus';

const settings = {
    validators: [], loadFactors: [],
    timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
} as any;

describe('PoolStatus.checkStatus validity', () => {
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

    it('keeps the pool valid after one failed check and schedules the next check', async () => {
        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();
        expect(status.isValid).toBe(true);

        pool.query.mockRejectedValueOnce(new Error('read ECONNRESET'));
        await status.checkStatus();
        expect(status.isValid).toBe(true);
        expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    it('marks the pool invalid after two failed checks in a row', async () => {
        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();

        pool.query.mockRejectedValue(new Error('read ECONNRESET'));
        await status.checkStatus();
        await status.checkStatus();
        expect(status.isValid).toBe(false);
    });

    it('a passing check resets the failure count', async () => {
        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();

        pool.query.mockRejectedValueOnce(new Error('blip'));
        await status.checkStatus();
        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();
        pool.query.mockRejectedValueOnce(new Error('blip'));
        await status.checkStatus();
        expect(status.isValid).toBe(true);
    });

    it('the status query times out at the longest check interval, or queryTimeout if lower', async () => {
        pool.query.mockResolvedValue([]);
        const slow = new PoolStatus(pool as any, { ...settings, queryTimeout: 120000 }, true);
        await slow.checkStatus();
        expect(pool.query).toHaveBeenLastCalledWith('SHOW GLOBAL STATUS;', { redis: false, timeout: 10000 });
        slow.stopTimerCheck();

        const fast = new PoolStatus(pool as any, { ...settings, queryTimeout: 3000 }, true);
        await fast.checkStatus();
        expect(pool.query).toHaveBeenLastCalledWith('SHOW GLOBAL STATUS;', { redis: false, timeout: 3000 });
        fast.stopTimerCheck();
    });

    it('queryTimeout 0 (no timeout) still bounds the check by the longest check interval', async () => {
        pool.query.mockResolvedValue([]);
        const noTimeout = new PoolStatus(pool as any, { ...settings, queryTimeout: 0 }, true);
        await noTimeout.checkStatus();
        expect(pool.query).toHaveBeenLastCalledWith('SHOW GLOBAL STATUS;', { redis: false, timeout: 10000 });
        noTimeout.stopTimerCheck();
    });

    it('a check that never settles (e.g. waiting for a free connection) fails at the check timeout', async () => {
        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();

        pool.query.mockReturnValue(new Promise(() => undefined));
        const first = status.checkStatus();
        jest.advanceTimersByTime(10000);
        await first;
        const second = status.checkStatus();
        jest.advanceTimersByTime(10000);
        await second;
        expect(status.isValid).toBe(false);
    });

    it('restores validity on the next passing check', async () => {
        pool.query.mockRejectedValue(new Error('read ECONNRESET'));
        await status.checkStatus();
        await status.checkStatus();
        expect(status.isValid).toBe(false);

        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();
        expect(status.isValid).toBe(true);
    });
});
