jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { PoolStatus } from '../../src/pool/PoolStatus';
import Events from '../../src/utils/Events';
import Logger from '../../src/utils/Logger';

const settings = {
    validators: [], loadFactors: [],
    timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
} as any;

// the errors mysql2 gives for a wrong password and for a node that is down
const accessDenied = () => Object.assign(
    new Error("Access denied for user 'app'@'10.0.0.5' (using password: YES)"),
    { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' }
);
const refused = () => Object.assign(
    new Error('connect ECONNREFUSED 10.0.0.5:3306'),
    { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' }
);

// Events has no way to remove a listener, so one listener hands every call to the test's own
let listener: jest.Mock;
Events.on('pool_check_failed', (...args: any[]) => listener(...args));

describe('pool_check_failed event', () => {
    let status: PoolStatus;
    let pool: { id: number, host: string, query: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        listener = jest.fn();
        pool = { id: 7, host: '10.0.0.5', query: jest.fn() };
        status = new PoolStatus(pool as any, settings, true);
    });

    afterEach(() => {
        status.stopTimerCheck();
        jest.useRealTimers();
    });

    it('a wrong password reaches the listener with code and errno', async () => {
        const error = accessDenied();
        pool.query.mockRejectedValueOnce(error);
        await status.checkStatus();

        const [received, poolId] = listener.mock.calls[0][0];
        expect(received).toBe(error);
        expect(received.code).toBe('ER_ACCESS_DENIED_ERROR');
        expect(received.errno).toBe(1045);
        expect(poolId).toBe(7);
    });

    it('a refused connection reaches the listener with code and errno', async () => {
        const error = refused();
        pool.query.mockRejectedValueOnce(error);
        await status.checkStatus();

        const [received, poolId] = listener.mock.calls[0][0];
        expect(received).toBe(error);
        expect(received.code).toBe('ECONNREFUSED');
        expect(received.errno).toBe(-111);
        expect(poolId).toBe(7);
    });

    it('the listener gets one argument: the array [error, poolId]', async () => {
        pool.query.mockRejectedValueOnce(refused());
        await status.checkStatus();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0]).toHaveLength(1);
        expect(listener.mock.calls[0][0]).toHaveLength(2);
    });

    it('fires for every failed check, not only the first', async () => {
        pool.query.mockRejectedValue(accessDenied());
        await status.checkStatus();
        await status.checkStatus();
        await status.checkStatus();

        expect(status.isValid).toBe(false);
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('does not fire for a passing check', async () => {
        pool.query.mockResolvedValue([]);
        await status.checkStatus();

        expect(listener).not.toHaveBeenCalled();
    });

    it('does not fire when the query works and a validator says no', async () => {
        const strict = { ...settings, validators: [{ key: 'wsrep_ready', operator: '=', value: 'ON' }] };
        const checked = new PoolStatus(pool as any, strict, true);
        pool.query.mockResolvedValue([{ Variable_name: 'wsrep_ready', Value: 'OFF' }]);
        await checked.checkStatus();
        checked.stopTimerCheck();

        expect(checked.isValid).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });

    it('does not fire for a check that ends after the pool was disconnected', async () => {
        let rejectQuery: (error: Error) => void;
        pool.query.mockReturnValue(new Promise((_, reject) => { rejectQuery = reject; }));
        const check = status.checkStatus();
        // what Pool.disconnect() does to its status
        status.active = false;
        status.stopTimerCheck();
        rejectQuery(refused());
        await check;

        expect(listener).not.toHaveBeenCalled();
    });

    it('sets the next check before the listeners run', async () => {
        let timersSeen = -1;
        listener.mockImplementation(() => { timersSeen = jest.getTimerCount(); });
        pool.query.mockRejectedValueOnce(refused());
        await status.checkStatus();

        expect(timersSeen).toBe(1);
    });

    it('logs the error a listener throws, with the host', async () => {
        listener.mockImplementation(() => { throw new Error('listener bug'); });
        pool.query.mockRejectedValueOnce(refused());
        await status.checkStatus();

        const lines = (Logger.error as jest.Mock).mock.calls.map(call => String(call[0]));
        const guardLines = lines.filter(line => line.includes('pool_check_failed listener threw'));
        expect(guardLines).toHaveLength(1);
        expect(guardLines[0]).toContain('10.0.0.5');
        expect(guardLines[0]).toContain('listener bug');
    });

    it('does not fire while the pool is not active, as no check runs', async () => {
        const idle = new PoolStatus(pool as any, settings, false);
        pool.query.mockRejectedValue(refused());
        await idle.checkStatus();
        idle.stopTimerCheck();

        expect(pool.query).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
    });

    it('a check that times out fires with an error that has no code', async () => {
        pool.query.mockReturnValue(new Promise(() => undefined));
        const check = status.checkStatus();
        jest.advanceTimersByTime(10000);
        await check;

        const [received, poolId] = listener.mock.calls[0][0];
        expect(received).toBeInstanceOf(Error);
        expect(received.code).toBeUndefined();
        expect(poolId).toBe(7);
    });

    it('a rejection that is not an Error is passed on as it is', async () => {
        pool.query.mockRejectedValueOnce('gone');
        await status.checkStatus();

        expect(listener.mock.calls[0][0]).toEqual(['gone', 7]);
    });

    it('a listener that throws does not stop the check loop', async () => {
        listener.mockImplementation(() => { throw new Error('listener bug'); });
        pool.query.mockRejectedValue(refused());

        await expect(status.checkStatus()).resolves.toBeUndefined();
        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(10000);
        expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it('a listener that throws does not change how failures are counted', async () => {
        listener.mockImplementation(() => { throw new Error('listener bug'); });
        pool.query.mockResolvedValueOnce([]);
        await status.checkStatus();
        pool.query.mockRejectedValue(refused());

        await status.checkStatus();
        expect(status.isValid).toBe(true);
        await status.checkStatus();
        expect(status.isValid).toBe(false);
    });

    it('the failed check is still logged once, as before', async () => {
        pool.query.mockRejectedValueOnce(refused());
        await status.checkStatus();

        const logged = (Logger.error as jest.Mock).mock.calls;
        expect(logged).toHaveLength(1);
        expect(logged[0][0]).toContain('connect ECONNREFUSED 10.0.0.5:3306');
    });
});
