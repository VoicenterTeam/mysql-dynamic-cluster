jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { ClusterHashing } from '../../src/cluster/ClusterHashing';

// Two connect() calls of the hashing module that overlap, and the status check when the timer
// is off (#61). No database: the schema steps of connect() are stubbed, the status check runs
// for real
const makeHashing = (query: jest.Mock, versionCheck = jest.fn().mockResolvedValue(true)) => {
    const hashing: any = new ClusterHashing(
        { query, pools: [] } as any, 'c', { nextCheckTime: 5000, dbName: 'x' }
    );
    hashing._isDatabaseVersionEquals = versionCheck;
    hashing._upgradeInPlace = jest.fn().mockResolvedValue(undefined);
    hashing._insertNodes = jest.fn().mockResolvedValue(undefined);
    return hashing;
};
const mapping = [{ Result: [{ ServiceID: 1, NodeID: 2 }] }];
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
// a promise and the function that settles it
const held = () => {
    let release: (value?: unknown) => void;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
};

describe('two connect() calls of cluster hashing', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('share one run while the first runs: the second gets the promise of the first', async () => {
        const query = jest.fn().mockResolvedValue(mapping);
        const hashing = makeHashing(query);

        const first = hashing.connect();
        const second = hashing.connect();
        expect(second).toBe(first);
        await first;

        expect(hashing._isDatabaseVersionEquals).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledTimes(1);
        expect(hashing.connected).toBe(true);
        expect(jest.getTimerCount()).toBe(1);
        hashing.stop();
    });

    it('share the rejection of the first, and the next call starts a run of its own',
        async () => {
            const failure = new Error('schema step failed');
            const versionCheck = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
            const hashing = makeHashing(jest.fn().mockResolvedValue(mapping), versionCheck);

            const first = hashing.connect();
            const second = hashing.connect();
            await expect(first).rejects.toBe(failure);
            await expect(second).rejects.toBe(failure);

            const third = hashing.connect();
            expect(third).not.toBe(first);
            await third;
            expect(versionCheck).toHaveBeenCalledTimes(2);
            expect(hashing.connected).toBe(true);
            hashing.stop();
        });

    it('start a new run once the first ended', async () => {
        const query = jest.fn().mockResolvedValue(mapping);
        const hashing = makeHashing(query);

        const first = hashing.connect();
        await first;
        const second = hashing.connect();
        expect(second).not.toBe(first);
        await second;

        expect(hashing._isDatabaseVersionEquals).toHaveBeenCalledTimes(2);
        hashing.stop();
    });

    describe('with a stop() while the first is held in its schema steps', () => {
        // the first connect waits in its version check, the second one waits for it
        const stoppedInSteps = async () => {
            const step = held();
            const versionCheck = jest.fn()
                .mockReturnValueOnce(step.promise)
                .mockResolvedValue(true);
            const query = jest.fn().mockResolvedValue(mapping);
            const hashing = makeHashing(query, versionCheck);
            const first = hashing.connect();
            await settle();
            hashing.stop();
            const second = hashing.connect();
            await settle();
            return { hashing, query, versionCheck, step, first, second };
        };

        it('the second call starts a run of its own', async () => {
            const { hashing, first, second, step } = await stoppedInSteps();

            expect(second).not.toBe(first);
            step.release(true);
            await Promise.all([first, second]);
            hashing.stop();
        });

        it('the second run starts its steps only after the steps of the first ended',
            async () => {
                const { hashing, query, versionCheck, step, first, second } =
                    await stoppedInSteps();
                expect(versionCheck).toHaveBeenCalledTimes(1);
                expect(query).not.toHaveBeenCalled();

                step.release(true);
                await first;
                await second;
                expect(versionCheck).toHaveBeenCalledTimes(2);
                expect(hashing._insertNodes).toHaveBeenCalledTimes(2);
                hashing.stop();
            });

        it('the first run, released, leaves the check to the second', async () => {
            const { hashing, query, step, first, second } = await stoppedInSteps();
            step.release(true);
            await Promise.all([first, second]);

            expect(query).toHaveBeenCalledTimes(1);
            expect(hashing.connected).toBe(true);
            expect(jest.getTimerCount()).toBe(1);
            hashing.stop();
        });

        it('a run stopped before its steps began does none of them', async () => {
            const { hashing, query, versionCheck, step, first, second } = await stoppedInSteps();
            hashing.stop();
            step.release(true);
            await Promise.all([first, second]);

            expect(versionCheck).toHaveBeenCalledTimes(1);
            expect(hashing._insertNodes).toHaveBeenCalledTimes(1);
            expect(query).not.toHaveBeenCalled();
            expect(hashing.connected).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });
    });
});

// The statements of a run that stop() ended and those of the next run, in the order they went
// out, with no hashing schema on the server: each run drops it and builds it again (#61)
describe('the schema steps of a stopped run and of the next run', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const statements = (sent: string[]) => {
        const step = held();
        const query = jest.fn(async (sql: string) => {
            sent.push(sql.split(' ').slice(0, 2).join(' '));
            return sql.includes('FN_GetServiceNodeMapping') ? mapping : [];
        });
        const pool = {
            status: { isValid: true },
            multiStatementQuery: jest.fn(async () => { sent.push('routines'); })
        };
        const hashing: any = new ClusterHashing(
            { query, pools: [pool] } as any, 'c', { nextCheckTime: 5000, dbName: 'x' }
        );
        hashing._isDatabaseVersionEquals = jest.fn()
            .mockReturnValueOnce(step.promise)
            .mockResolvedValue(false);
        hashing._readFilesInDir = jest.fn(() => ({
            fileNames: ['SP_NodeInsert'], fileContents: ['...']
        }));
        hashing._insertNodes = jest.fn(async () => { sent.push('nodes'); });
        return { hashing, step };
    };
    // the statements of one run that builds the schema, and its status check
    const BUILD = ['DROP SCHEMA', 'CREATE SCHEMA', 'routines', 'routines', 'routines',
        'INSERT INTO', 'nodes'];

    it('never interleave: the next run starts after the stopped one ended its steps', async () => {
        const sent: string[] = [];
        const { hashing, step } = statements(sent);
        const first = hashing.connect();
        await settle();
        hashing.stop();
        const second = hashing.connect();
        await settle();
        step.release(false);
        await Promise.all([first, second]);

        expect(sent).toEqual([...BUILD, ...BUILD, 'SELECT FN_GetServiceNodeMapping()']);
        hashing.stop();
    });
});

describe('the status check of cluster hashing when its timer is off', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('asks nothing, and leaves hashing as it was', async () => {
        const query = jest.fn().mockResolvedValue(mapping);
        const hashing = makeHashing(query);
        await hashing.connect();
        hashing.stop();
        query.mockClear();

        await hashing._checkHashing();

        expect(query).not.toHaveBeenCalled();
        expect(hashing.connected).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('asks nothing before the first connect()', async () => {
        const query = jest.fn().mockResolvedValue(mapping);
        const hashing = makeHashing(query);
        hashing.stop();

        await hashing._checkHashing();

        expect(query).not.toHaveBeenCalled();
        expect(hashing.connected).toBe(false);
    });
});
