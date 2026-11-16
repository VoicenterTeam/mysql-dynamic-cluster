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

    describe('an old check that ends after the pool was started again', () => {
        // stop and start again while one query is out, as disconnect() and connect() do
        const restartWith = (old: Promise<any[]>) => {
            pool.query.mockReturnValueOnce(old);
            const oldCheck = status.checkStatus();
            status.active = false;
            status.stopTimerCheck();
            status.active = true;
            status.startTimerCheck();
            return oldCheck;
        };
        const state = () => ({
            isValid: status.isValid,
            failedChecks: (status as any)._failedChecks,
            nextCheckTime: (status as any)._nextCheckTime
        });
        // while the old query is out, its own timeout timer is pending too. Once it has ended,
        // the one timer left is the next check of the new connection

        it('a late success does not clear the failure of the new connection', async () => {
            const old = pending();
            const oldCheck = restartWith(old.promise);
            pool.query.mockRejectedValueOnce(new Error('down'));
            await status.checkStatus();
            const before = state();
            expect(before.failedChecks).toBe(1);

            old.resolve([]);
            await oldCheck;

            expect(state()).toEqual(before);
            expect(jest.getTimerCount()).toBe(1);
        });

        it('a late success does not move the time of the next check', async () => {
            const old = pending();
            const oldCheck = restartWith(old.promise);
            pool.query.mockResolvedValueOnce([]);
            await status.checkStatus();
            const before = state();

            old.resolve([]);
            await oldCheck;

            expect(state()).toEqual(before);
            expect(jest.getTimerCount()).toBe(1);
        });

        it('a late failure is not counted and does not take the pool out', async () => {
            const first = pending();
            const firstCheck = restartWith(first.promise);
            pool.query.mockResolvedValueOnce([]);
            await status.checkStatus();
            const before = state();
            expect(before).toMatchObject({ isValid: true, failedChecks: 0 });

            first.reject(new Error('Pool is closed.'));
            await firstCheck;
            expect(state()).toEqual(before);
            expect(jest.getTimerCount()).toBe(1);

            // and a second old failure, which would be the one that marks the pool invalid
            const second = pending();
            pool.query.mockReturnValueOnce(second.promise);
            const secondCheck = status.checkStatus();
            status.stopTimerCheck();
            status.startTimerCheck();
            second.reject(new Error('Pool is closed.'));
            await secondCheck;

            expect(status.isValid).toBe(true);
            expect((status as any)._failedChecks).toBe(0);
            expect(listener).not.toHaveBeenCalled();
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

        it.each([
            ['an object without a prototype', () => Object.create(null)],
            ['a message without a prototype', () => ({ message: Object.create(null) })],
            ['a toString that throws', () => ({ toString() { throw new Error('no text'); } })],
            ['a message getter that throws', () => Object.defineProperty({}, 'message', { get() { throw new Error('no'); } })]
        ])('survives a rejection with %s and checks again', async (_name, make) => {
            const reason = make();
            pool.query.mockRejectedValueOnce(reason);
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(errorLines()).toHaveLength(1);
            expect(errorLines()[0]).toContain('Message: unreadable error');
            expect(jest.getTimerCount()).toBe(1);
            expect((status as any)._failedChecks).toBe(1);
            expect(listener.mock.calls[0][0][0]).toBe(reason);
        });

        it('prints a symbol that stands where the message should be', async () => {
            pool.query.mockRejectedValueOnce({ message: Symbol('m') });
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(errorLines()[0]).toContain('Message: Symbol(m)');
            expect(jest.getTimerCount()).toBe(1);
        });

        it('survives a listener that throws a value without text', async () => {
            listener.mockImplementation(() => { throw Object.create(null); });
            pool.query.mockRejectedValueOnce(new Error('down'));
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(errorLines().find(line => line.includes('listener threw'))).toContain('unreadable error');
            expect(jest.getTimerCount()).toBe(1);
        });

        it('survives a listener that throws undefined', async () => {
            listener.mockImplementation(() => { throw undefined; });
            pool.query.mockRejectedValueOnce(new Error('down'));
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(errorLines().find(line => line.includes('listener threw'))).toContain('Message: undefined');
        });
    });
});
