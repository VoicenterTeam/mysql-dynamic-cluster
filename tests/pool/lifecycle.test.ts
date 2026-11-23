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
// a mysql2 pool that opens nothing, with the queue of the requests that wait
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => ({ on: jest.fn(), end: jest.fn(), _connectionQueue: [] })),
        createConnection: jest.fn()
    }
}));

import { Pool } from '../../src/pool/Pool';
import { PoolStatus } from '../../src/pool/PoolStatus';
import { Settings } from '../../src/utils/Settings';
import Events from '../../src/utils/Events';
import Logger from '../../src/utils/Logger';

// The life of a pool between connect() and disconnect(), and what it logs on the way. The
// status check asks through pool.query, which the test answers. The clock is fake
const makePool = (): any => {
    const host = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: '192.0.2.5' }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            validators: [], loadFactors: [], timerCheckRange: { start: 1000, end: 10000 }
        }
    } as any).hosts[0];
    const pool: any = new Pool({ id: 1, ...host }, 'test');
    pool.query = jest.fn().mockResolvedValue([]);
    return pool;
};
// a status query the test answers by hand
const pending = () => {
    let resolve: (rows: any[]) => void;
    const promise = new Promise<any[]>(res => { resolve = res; });
    return { promise, resolve: (rows: any[]) => resolve(rows) };
};
const turns = async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

// Events has no way to remove a listener: each one hands its calls to the test's own
let events: string[] = [];
Events.on('pool_connected', () => events.push('connected'));
Events.on('pool_disconnected', () => events.push('disconnected'));
let onCheckFailed: () => void = () => undefined;
Events.on('pool_check_failed', () => onCheckFailed());

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    events = [];
    onCheckFailed = () => undefined;
});
afterEach(() => jest.useRealTimers());

describe('a disconnect() during the check of a connect()', () => {
    // The node passed before, so it is still valid when the late check comes back
    it('of a reconnect: no pool_connected after the pool_disconnected', async () => {
        const pool = makePool();
        await pool.connect();
        pool.disconnect();
        const status = pending();
        pool.query.mockReturnValueOnce(status.promise);
        const connecting = pool.connect().catch((): void => undefined);
        await turns();

        pool.disconnect();
        status.resolve([]);
        await connecting;

        expect(events).toEqual(['connected', 'disconnected', 'disconnected']);
    });

    it('and a connect() after it: one pool_connected, of the connect() after it', async () => {
        const pool = makePool();
        await pool.connect();
        pool.disconnect();
        const status = pending();
        pool.query.mockReturnValueOnce(status.promise);
        const first = pool.connect().catch((): void => undefined);
        await turns();

        pool.disconnect();
        await pool.connect();
        status.resolve([]);
        await first;

        expect(events).toEqual(['connected', 'disconnected', 'disconnected', 'connected']);
        pool.disconnect();
    });

    it('a connect() with no disconnect() during its check still tells pool_connected', async () => {
        const pool = makePool();
        await pool.connect();

        expect(events).toEqual(['connected']);
        pool.disconnect();
    });
});

describe('failWaiting()', () => {
    const infoLines = (): any[][] => (Logger.info as jest.Mock).mock.calls
        .filter(([message]) => String(message).includes('waited'));

    it('logs one info line with the host and how many requests it failed', async () => {
        const pool = makePool();
        await pool.connect();
        pool._pool._connectionQueue.push(jest.fn(), jest.fn());

        expect(pool.failWaiting(new Error('going down'))).toBe(2);

        expect(infoLines()).toHaveLength(1);
        expect(infoLines()[0][0]).toContain('192.0.2.5');
        expect(infoLines()[0][1]).toEqual({ nodeId: 1, pool: '192.0.2.5:3306', failed: 2 });
        pool.disconnect();
    });

    it('logs the line when nothing waited, with 0', async () => {
        const pool = makePool();
        await pool.connect();

        expect(pool.failWaiting(new Error('going down'))).toBe(0);

        expect(infoLines().map(([, meta]) => meta.failed)).toEqual([0]);
        pool.disconnect();
    });

    it('logs no line before connect() created the mysql2 pool', () => {
        expect(makePool().failWaiting(new Error('going down'))).toBe(0);
        expect(infoLines()).toEqual([]);
    });
});

describe('a pool_check_failed listener that throws a value whose stack cannot be read', () => {
    const settings = {
        validators: [], loadFactors: [],
        timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
    } as any;
    const errorLines = (): string[] => (Logger.error as jest.Mock).mock.calls
        .map(call => String(call[0]));
    const revoked = () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
    };

    it.each([
        ['a stack getter that throws',
            () => Object.defineProperty({}, 'stack', { get() { throw new Error('no stack'); } })],
        ['a revoked proxy', revoked]
    ])('%s: the check ends, is counted and checks again', async (_name, make) => {
        const pool = { id: 7, name: 'node7', host: '192.0.2.5', query: jest.fn() };
        const status = new PoolStatus(pool as any, settings, true);
        const thrown = make();
        onCheckFailed = () => { throw thrown; };
        pool.query.mockRejectedValueOnce(new Error('down'));

        await expect(status.checkStatus()).resolves.toBeUndefined();

        expect(errorLines().find(line => line.includes('listener threw'))).toContain('unreadable error');
        expect((status as any)._failedChecks).toBe(1);
        expect(jest.getTimerCount()).toBe(1);
        status.stopTimerCheck();
    });

    it('a stack that can be read is still logged', async () => {
        const pool = { id: 7, name: 'node7', host: '192.0.2.5', query: jest.fn() };
        const status = new PoolStatus(pool as any, settings, true);
        const bug = new Error('listener bug');
        onCheckFailed = () => { throw bug; };
        pool.query.mockRejectedValueOnce(new Error('down'));

        await status.checkStatus();

        expect(errorLines().find(line => line.includes('listener threw'))).toContain(bug.stack);
        status.stopTimerCheck();
    });
});
