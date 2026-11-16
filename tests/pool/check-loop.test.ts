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

let listener: jest.Mock;
Events.on('pool_check_failed', (...args: any[]) => listener(...args));

const errorLines = (): string[] => (Logger.error as jest.Mock).mock.calls.map(call => String(call[0]));
// a query the test settles by hand
const pending = () => {
    let resolve: (rows: any[]) => void;
    let reject: (error: any) => void;
    const promise = new Promise<any[]>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

describe('the health check loop of a pool', () => {
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

    describe('after a stop and a new start, as disconnect() and connect() do', () => {
        it('checks again on its timer', async () => {
            pool.query.mockResolvedValue([]);
            await status.checkStatus();
            status.active = false;
            status.stopTimerCheck();
            expect(jest.getTimerCount()).toBe(0);

            status.active = true;
            status.startTimerCheck();
            await status.checkStatus();
            expect(jest.getTimerCount()).toBe(1);

            const before = pool.query.mock.calls.length;
            jest.advanceTimersByTime(10000);
            expect(pool.query.mock.calls.length).toBe(before + 1);
        });

        it('stays stopped without the new start', async () => {
            pool.query.mockResolvedValue([]);
            status.stopTimerCheck();
            await status.checkStatus();
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('a check that is still running when the pool is stopped', () => {
        it('does not make the pool valid when it succeeds late', async () => {
            const query = pending();
            pool.query.mockReturnValue(query.promise);
            const check = status.checkStatus();
            status.active = false;
            status.stopTimerCheck();
            query.resolve([]);
            await check;

            expect(status.isValid).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('does not count as a failure of the new connection when it fails after a new start', async () => {
            const old = pending();
            pool.query.mockReturnValueOnce(old.promise);
            const oldCheck = status.checkStatus();
            status.active = false;
            status.stopTimerCheck();

            status.active = true;
            status.startTimerCheck();
            pool.query.mockResolvedValue([]);
            await status.checkStatus();
            expect(status.isValid).toBe(true);

            old.reject(new Error('Pool is closed.'));
            await oldCheck;

            expect(listener).not.toHaveBeenCalled();
            expect(errorLines()).toEqual([]);
            expect(status.isValid).toBe(true);
            expect(jest.getTimerCount()).toBe(1);
        });
    });

    it('keeps one pending check when two checks end one after the other', async () => {
        pool.query.mockResolvedValue([]);
        await status.checkStatus();
        await status.checkStatus();
        expect(jest.getTimerCount()).toBe(1);
    });

    describe('what a failed check logs', () => {
        it.each([
            ['undefined', undefined, 'undefined'],
            ['null', null, 'null'],
            ['a string', 'gone', 'gone']
        ])('survives a rejection with %s and checks again', async (_name, reason, text) => {
            pool.query.mockRejectedValueOnce(reason);
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(errorLines()).toHaveLength(1);
            expect(errorLines()[0]).toContain('Message: ' + text);
            expect(jest.getTimerCount()).toBe(1);
            expect(listener).toHaveBeenCalledWith([reason, 7]);
        });

        it('names the code of an error without a message', async () => {
            // what a refused connection to a host with several addresses looks like
            const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
            pool.query.mockRejectedValueOnce(refused);
            await status.checkStatus();

            expect(errorLines()[0]).toContain('Message: ECONNREFUSED');
        });

        it('keeps the message of an error that has one', async () => {
            pool.query.mockRejectedValueOnce(Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' }));
            await status.checkStatus();

            expect(errorLines()[0]).toContain('Message: Access denied');
        });

        it('logs the stack of an error a listener throws', async () => {
            const bug = new Error('listener bug');
            listener.mockImplementation(() => { throw bug; });
            pool.query.mockRejectedValueOnce(new Error('down'));
            await status.checkStatus();

            const guardLine = errorLines().find(line => line.includes('listener threw'));
            expect(guardLine).toContain(bug.stack);
        });

        it('survives a listener that throws undefined', async () => {
            listener.mockImplementation(() => { throw undefined; });
            pool.query.mockRejectedValueOnce(new Error('down'));
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(errorLines().find(line => line.includes('listener threw'))).toContain('Message: undefined');
        });
    });
});
