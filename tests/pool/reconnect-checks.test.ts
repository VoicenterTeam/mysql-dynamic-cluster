jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: {
        recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn(),
        recordHealthCheck: jest.fn()
    }
}));
// a mysql2 pool that opens nothing
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => ({ on: jest.fn(), end: jest.fn() })),
        createConnection: jest.fn()
    }
}));

import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';

// flags are set, so connect() asks no server. No validators: an answered check is a valid pool
const makePool = (): any => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1' }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            validators: [], loadFactors: [], timerCheckRange: { start: 1000, end: 10000 }
        }
    } as any).hosts[0];
    const pool: any = new Pool({ id: 1, ...host }, 'test');
    // the status check asks through this
    pool.query = jest.fn().mockResolvedValue([]);
    return pool;
};

describe('a pool that is connected, disconnected and connected again', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('is health-checked again on its timer', async () => {
        const pool = makePool();
        await pool.connect();
        pool.disconnect();

        await pool.connect();
        expect(pool.status.isValid).toBe(true);
        const checksAfterConnect = pool.query.mock.calls.length;

        jest.advanceTimersByTime(10000);
        expect(pool.query.mock.calls.length).toBe(checksAfterConnect + 1);
        pool.disconnect();
    });

    it('runs one check loop after two connects without a disconnect', async () => {
        const pool = makePool();
        await pool.connect();
        await pool.connect();
        const checksAfterConnect = pool.query.mock.calls.length;

        jest.advanceTimersByTime(10000);
        // let the check that just ran set its next one
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(pool.query.mock.calls.length).toBe(checksAfterConnect + 1);
        pool.disconnect();
    });
});
