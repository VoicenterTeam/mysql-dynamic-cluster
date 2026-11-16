jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { ClusterHashing } from '../../src/cluster/ClusterHashing';

// No database: the schema steps of connect() are stubbed, the status check runs for real
const makeHashing = (query: jest.Mock) => {
    const hashing: any = new ClusterHashing({ query, pools: [] } as any, 'c', { nextCheckTime: 5000, dbName: 'x' });
    hashing._isDatabaseVersionEquals = jest.fn().mockResolvedValue(true);
    hashing._upgradeInPlace = jest.fn().mockResolvedValue(undefined);
    hashing._insertNodes = jest.fn().mockResolvedValue(undefined);
    return hashing;
};
const mapping = [{ Result: [{ ServiceID: 1, NodeID: 2 }] }];

describe('cluster hashing after a stop', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('checks again when it is connected a second time', async () => {
        const query = jest.fn().mockResolvedValue(mapping);
        const hashing = makeHashing(query);

        await hashing.connect();
        expect(hashing.connected).toBe(true);
        hashing.stop();
        expect(hashing.connected).toBe(false);
        expect(jest.getTimerCount()).toBe(0);

        await hashing.connect();
        expect(hashing.connected).toBe(true);
        expect(jest.getTimerCount()).toBe(1);

        const before = query.mock.calls.length;
        jest.advanceTimersByTime(5000);
        expect(query.mock.calls.length).toBe(before + 1);
        hashing.stop();
    });

    it('is not marked connected by a check that ends after the stop', async () => {
        let answer: (rows: any[]) => void;
        const query = jest.fn().mockReturnValue(new Promise(resolve => { answer = resolve; }));
        const hashing = makeHashing(query);

        const connecting = hashing.connect();
        // let connect() reach the status check
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(query).toHaveBeenCalledTimes(1);

        hashing.stop();
        answer(mapping);
        await connecting;

        expect(hashing.connected).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    describe('a check of the first run that ends after a second connect began', () => {
        // first connect is stopped with its check out, the second connect waits at its own check
        const twoRuns = async () => {
            const first: any = {};
            const second: any = {};
            const query = jest.fn()
                .mockReturnValueOnce(new Promise((resolve, reject) => { first.resolve = resolve; first.reject = reject; }))
                .mockReturnValueOnce(new Promise((resolve, reject) => { second.resolve = resolve; second.reject = reject; }));
            const hashing = makeHashing(query);
            const firstConnect = hashing.connect();
            for (let i = 0; i < 10; i++) await Promise.resolve();
            hashing.stop();
            const secondConnect = hashing.connect();
            for (let i = 0; i < 10; i++) await Promise.resolve();
            expect(query).toHaveBeenCalledTimes(2);
            return { hashing, first, second, firstConnect, secondConnect };
        };

        it('a late answer does not mark hashing connected or start a timer', async () => {
            const { hashing, first, second, firstConnect, secondConnect } = await twoRuns();
            first.resolve(mapping);
            await firstConnect;

            expect(hashing.connected).toBe(false);
            expect(jest.getTimerCount()).toBe(0);

            second.resolve(mapping);
            await secondConnect;
            expect(hashing.connected).toBe(true);
            expect(jest.getTimerCount()).toBe(1);
            hashing.stop();
        });

        it('a late failure is not logged and does not undo the second connect', async () => {
            const Logger = require('../../src/utils/Logger').default;
            const { hashing, first, second, firstConnect, secondConnect } = await twoRuns();
            second.resolve(mapping);
            await secondConnect;
            (Logger.error as jest.Mock).mockClear();

            first.reject(new Error('Pool is closed.'));
            await firstConnect;

            expect(Logger.error).not.toHaveBeenCalled();
            expect(hashing.connected).toBe(true);
            expect(jest.getTimerCount()).toBe(1);
            hashing.stop();
        });
    });

    it('logs nothing for a check that fails after the stop', async () => {
        let fail: (error: Error) => void;
        const query = jest.fn().mockReturnValue(new Promise((_, reject) => { fail = reject; }));
        const hashing = makeHashing(query);
        const Logger = require('../../src/utils/Logger').default;
        (Logger.error as jest.Mock).mockClear();

        const connecting = hashing.connect();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(query).toHaveBeenCalledTimes(1);
        hashing.stop();
        fail(new Error('Pool is closed.'));
        await connecting;

        expect(Logger.error).not.toHaveBeenCalled();
        expect(hashing.connected).toBe(false);
    });
});
