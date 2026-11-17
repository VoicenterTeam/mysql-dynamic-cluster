jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { PoolStatus } from '../../src/pool/PoolStatus';
import Events from '../../src/utils/Events';

const settings = {
    validators: [], loadFactors: [],
    timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
} as any;
const strict = { ...settings, validators: [{ key: 'wsrep_ready', operator: '=', value: 'ON' }] };

const USER = 'app_user';
// the errors mysql2 gives for a wrong password and for a node that is down
const accessDenied = () => Object.assign(
    new Error(`Access denied for user '${USER}'@'192.0.2.5' (using password: YES)`),
    {
        code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000',
        sqlMessage: `Access denied for user '${USER}'@'192.0.2.5' (using password: YES)`
    }
);
const refused = () => Object.assign(new Error('connect ECONNREFUSED 192.0.2.5:3306'), {
    code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '192.0.2.5', port: 3306,
    fatal: true
});
const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };

// Events has no way to remove a listener, so one listener hands every call to the test's own
let listener: jest.Mock;
Events.on('pool_check_failed', (...args: any[]) => listener(...args));

// a query the test settles by hand
const pending = () => {
    let resolve: (rows: any[]) => void;
    let reject: (error: any) => void;
    const promise = new Promise<any[]>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

describe('PoolStatus.checkError', () => {
    let status: PoolStatus;
    let pool: { id: number, host: string, query: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        listener = jest.fn();
        pool = { id: 7, host: 'db.example', query: jest.fn() };
        status = new PoolStatus(pool as any, settings, true);
    });

    afterEach(() => {
        status.stopTimerCheck();
        jest.useRealTimers();
    });

    // one failed check with this rejection, then what the status reports
    const after = async (reason: any) => {
        pool.query.mockRejectedValueOnce(reason);
        await status.checkStatus();
        return status.checkError;
    };

    describe('what it holds', () => {
        it('is undefined before the first check', () => {
            expect(status.checkError).toBeUndefined();
        });

        it('is the code, errno and sqlState of a refused login, and nothing else', async () => {
            expect(await after(accessDenied())).toStrictEqual(DENIED);
        });

        it('is the code and errno of a refused connection, which has no sqlState', async () => {
            expect(await after(refused())).toStrictEqual({ code: 'ECONNREFUSED', errno: -111 });
        });

        it('never holds the message, which names the user', async () => {
            const reduced = await after(accessDenied());

            expect(Object.keys(reduced).sort()).toEqual(['code', 'errno', 'sqlState']);
            expect(JSON.stringify(reduced)).not.toContain(USER);
        });

        it.each([
            ['a code that is a number', { code: 1045 }, {}],
            ['a code that is an object', { code: { name: 'ER_X' } }, {}],
            ['an errno that is a string', { errno: 'ETIMEDOUT' }, {}],
            ['an errno that is text of digits', { errno: '1045' }, {}],
            ['an errno that is a fraction', { errno: 1.5 }, {}],
            ['an errno that is NaN', { errno: NaN }, {}],
            ['an errno that is Infinity', { errno: Infinity }, {}],
            ['an errno of zero', { errno: 0 }, { errno: 0 }],
            ['a negative errno', { errno: -110 }, { errno: -110 }],
            ['a sqlState that is a number', { sqlState: 28000 }, {}],
            ['an empty code and sqlState', { code: '', sqlState: '' }, { code: '', sqlState: '' }],
            ['the misspelled errorno of mysql2', { code: 'ETIMEDOUT', errorno: 'ETIMEDOUT' },
                { code: 'ETIMEDOUT' }],
            ['one bad field beside two good ones', { code: 'ER_X', errno: '5', sqlState: 'HY000' },
                { code: 'ER_X', sqlState: 'HY000' }]
        ])('keeps a field only in its own type: %s', async (_name, fields, expected) => {
            expect(await after(Object.assign(new Error('failed'), fields))).toStrictEqual(expected);
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['a string', 'ER_ACCESS_DENIED_ERROR'],
            ['a number', 1045],
            ['an Error without fields', new Error('Pool is closed.')]
        ])('is an empty object for a rejection with %s', async (_name, reason) => {
            expect(await after(reason)).toStrictEqual({});
        });

        it('takes the fields of a rejection that is a plain object', async () => {
            expect(await after({ code: 'ECONNRESET', errno: -104, message: 'read ECONNRESET' }))
                .toStrictEqual({ code: 'ECONNRESET', errno: -104 });
        });

        it('takes the code of an error with several causes and an empty message', async () => {
            // a refused connection to a host name with several addresses
            const several = Object.assign(
                new Error(''), { code: 'ECONNREFUSED', errors: [refused()] }
            );
            expect(await after(several)).toStrictEqual({ code: 'ECONNREFUSED' });
        });
    });

    describe('every read', () => {
        it('is a new plain object', async () => {
            const first = await after(accessDenied());

            expect(status.checkError).not.toBe(first);
            expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
        });

        it('does not read back what the caller changed', async () => {
            const first = await after(accessDenied());
            first.code = 'CHANGED';
            delete first.errno;

            expect(status.checkError).toStrictEqual(DENIED);
        });

        it('is taken when the check failed, not when it is read', async () => {
            const error = accessDenied();
            await after(error);
            error.code = 'CHANGED_LATER';

            expect(status.checkError).toStrictEqual(DENIED);
        });
    });

    describe('an error object that cannot be read', () => {
        const throwing = (field: string) => Object.defineProperty(
            { code: 'ER_X', errno: 5, sqlState: 'HY000' }, field,
            { get() { throw new Error('no ' + field); } }
        );

        it.each([
            ['code', () => throwing('code')],
            ['errno', () => throwing('errno')],
            ['sqlState', () => throwing('sqlState')],
            ['every field, a proxy', () => new Proxy({}, { get() { throw new Error('no'); } })]
        ])('gives an empty object when reading %s throws', async (_name, make) => {
            expect(await after(make())).toStrictEqual({});
        });

        it('does not stop the check loop', async () => {
            const reason = throwing('code');
            pool.query.mockRejectedValueOnce(reason);
            await expect(status.checkStatus()).resolves.toBeUndefined();

            expect(jest.getTimerCount()).toBe(1);
            expect((status as any)._failedChecks).toBe(1);
            expect(listener.mock.calls[0][0][0]).toBe(reason);
        });
    });

    describe('when it is set and cleared', () => {
        it('is cleared by the next check whose query ran', async () => {
            await after(accessDenied());
            pool.query.mockResolvedValueOnce([]);
            await status.checkStatus();

            expect(status.isValid).toBe(true);
            expect(status.checkError).toBeUndefined();
        });

        it('is cleared when the query ran and a validator says no', async () => {
            const checked = new PoolStatus(pool as any, strict, true);
            pool.query.mockRejectedValueOnce(accessDenied());
            await checked.checkStatus();
            pool.query.mockResolvedValueOnce([{ Variable_name: 'wsrep_ready', Value: 'OFF' }]);
            await checked.checkStatus();
            checked.stopTimerCheck();

            expect(checked.isValid).toBe(false);
            expect(checked.checkError).toBeUndefined();
        });

        it('holds the error of the last failed check only', async () => {
            await after(accessDenied());
            expect(await after(refused())).toStrictEqual({ code: 'ECONNREFUSED', errno: -111 });
        });

        it('is set by the first failed check, which does not yet take the pool out', async () => {
            pool.query.mockResolvedValueOnce([]);
            await status.checkStatus();

            expect(await after(refused())).toStrictEqual({ code: 'ECONNREFUSED', errno: -111 });
            expect(status.isValid).toBe(true);
        });

        it('is not touched while the status is not active, as no check runs', async () => {
            const idle = new PoolStatus(pool as any, settings, false);
            pool.query.mockRejectedValue(accessDenied());
            await idle.checkStatus();

            expect(pool.query).not.toHaveBeenCalled();
            expect(idle.checkError).toBeUndefined();
        });
    });

    describe('a failure the package makes itself', () => {
        it('is an empty object when the check runs into its own timeout', async () => {
            pool.query.mockReturnValue(new Promise(() => undefined));
            const check = status.checkStatus();
            jest.advanceTimersByTime(10000);
            await check;

            expect(listener.mock.calls[0][0][0].message).toBe('Status check timeout');
            expect(status.checkError).toStrictEqual({});
        });

        it('is an empty object for an error marked as made here, whatever its code', async () => {
            const own = Object.assign(new Error('not connected'), { code: 'POOL_NOT_CONNECTED' });
            expect(PoolStatus.ownError(own)).toBe(own);

            expect(await after(own)).toStrictEqual({});
            expect(own.code).toBe('POOL_NOT_CONNECTED');
        });

        it('keeps the same code on an error that is not marked', async () => {
            const foreign = Object.assign(new Error('other'), { code: 'POOL_NOT_CONNECTED' });
            expect(await after(foreign)).toStrictEqual({ code: 'POOL_NOT_CONNECTED' });
        });

        it('marks a frozen error too', async () => {
            const frozen = Object.freeze(Object.assign(new Error('leaving'), { code: 'APP_CODE' }));
            PoolStatus.ownError(frozen);

            expect(await after(frozen)).toStrictEqual({});
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['a string', 'gone'],
            ['a number', 7]
        ])('marking %s changes nothing and does not throw', (_name, value) => {
            expect(PoolStatus.ownError(value)).toBe(value);
        });

        it('is an empty object when the code that reads the answer throws', async () => {
            const coded = Object.assign(new Error('bad rows'), { code: 'ER_FAKE', errno: 9 });
            const checked = new PoolStatus(pool as any, strict, true);
            pool.query.mockResolvedValueOnce({ find() { throw coded; } });
            await checked.checkStatus();
            checked.stopTimerCheck();

            expect(listener.mock.calls[0][0][0]).toBe(coded);
            expect(checked.checkError).toStrictEqual({});
        });
    });

    describe('a check of an earlier run, which ends after the pool was stopped', () => {
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

        it('does not set it when it fails late', async () => {
            const old = pending();
            const oldCheck = restartWith(old.promise);
            old.reject(accessDenied());
            await oldCheck;

            expect(status.checkError).toBeUndefined();
        });

        it('does not replace the error of the new run when it fails late', async () => {
            const old = pending();
            const oldCheck = restartWith(old.promise);
            await after(refused());
            old.reject(accessDenied());
            await oldCheck;

            expect(status.checkError).toStrictEqual({ code: 'ECONNREFUSED', errno: -111 });
        });

        it('does not clear the error of the new run when it succeeds late', async () => {
            const old = pending();
            const oldCheck = restartWith(old.promise);
            await after(accessDenied());
            old.resolve([]);
            await oldCheck;

            expect(status.checkError).toStrictEqual(DENIED);
        });

        it('does not set it when the pool stays stopped', async () => {
            const old = pending();
            pool.query.mockReturnValueOnce(old.promise);
            const oldCheck = status.checkStatus();
            status.active = false;
            status.stopTimerCheck();
            old.reject(accessDenied());
            await oldCheck;

            expect(status.checkError).toBeUndefined();
        });
    });

    describe('across a stop and a new start', () => {
        it('keeps its value after the stop, as isValid does', async () => {
            await after(accessDenied());
            status.active = false;
            status.stopTimerCheck();

            expect(status.checkError).toStrictEqual(DENIED);
        });

        it('keeps it after the new start, until the first check of that start ends', async () => {
            await after(accessDenied());
            status.active = false;
            status.stopTimerCheck();
            status.startTimerCheck();
            const first = pending();
            pool.query.mockReturnValueOnce(first.promise);
            const check = status.checkStatus();

            expect(status.checkError).toStrictEqual(DENIED);
            first.resolve([]);
            await check;
            expect(status.checkError).toBeUndefined();
        });
    });
});
