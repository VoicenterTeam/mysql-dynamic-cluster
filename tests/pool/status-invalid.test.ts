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
        status = new PoolStatus(pool as any, settings, true, 10);
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
