jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));
// createPool records its options and stops connect() there: no socket, no timer.
// createConnection hands out a connection the test drives by hand
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => { throw new Error('createPool reached'); }),
        createConnection: jest.fn(() => {
            const { EventEmitter } = jest.requireActual('events');
            const connection = new EventEmitter();
            connection.end = jest.fn();
            connection.destroy = jest.fn();
            return connection;
        })
    }
}));

import mysql from 'mysql2';
import { Pool } from '../../src/pool/Pool';
import Logger from '../../src/utils/Logger';
import { Settings } from '../../src/utils/Settings';
import { flagsForServer } from '../../src/pool/ServerFlags';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import { IUserPoolSettings } from '../../src/types/PoolSettingsInterfaces';

const OFF = ['-CLIENT_QUERY_ATTRIBUTES'];
// capability bits of the MySQL protocol
const CLIENT_QUERY_ATTRIBUTES = 1 << 27;
const OTHER_CAPABILITIES = 0xf7ffffff | 0;

const createPool = mysql.createPool as unknown as jest.Mock;
const createConnection = mysql.createConnection as unknown as jest.Mock;
const log = Logger as unknown as { debug: jest.Mock, info: jest.Mock, warn: jest.Mock };

const poolFor = (host: Partial<IUserPoolSettings> = {}): Pool => {
    const settings = Settings.mixSettings({
        clusterName: 'test',
        hosts: [{ host: 'node-a', ...host }],
        defaultPoolSettings: { user: 'u', password: 'secret-password', database: 'd' }
    });
    return new Pool({ id: 1, ...settings.hosts[0] }, 'test');
};

// the probe connection of the last connect() call
const probe = () => createConnection.mock.results[createConnection.mock.results.length - 1].value;
const createPoolOptions = () => createPool.mock.calls[createPool.mock.calls.length - 1][0];
// the log calls about the decision, as [level, meta]
const decisionLog = () => (['debug', 'info', 'warn'] as const).flatMap(level =>
    log[level].mock.calls
        .filter(call => String(call[0]).startsWith('Pool node-a:3306: '))
        .map(call => [level, call[1]]));
const refusedLogin = (extra: object = {}) =>
    Object.assign(new Error("Access denied for user 'u'@'10.0.0.1' (using password: YES)"), extra);

// a connect() that waits for a greeting nobody sends should fail soon, not after the suite default
jest.setTimeout(5000);

beforeEach(() => {
    createPool.mockClear();
    createConnection.mockClear();
    Object.values(log).forEach(level => level.mockClear());
});

describe('flagsForServer', () => {
    it.each([
        // Percona XtraDB Cluster of issue 33
        ['8.0.25-15.1', 'older_than_8.0.26'],
        ['8.0.25', 'older_than_8.0.26'],
        ['8.0.23', 'older_than_8.0.26'],
        ['8.0.3', 'older_than_8.0.26'],
        ['5.7.44-log', 'older_than_8.0.26'],
        ['7.99.99', 'older_than_8.0.26'],
        ['8.0', 'version_unreadable'],
        ['', 'version_unreadable'],
        ['Percona 8.0.25', 'version_unreadable']
    ])('turns query attributes off for a server that announces them as %s', (serverVersion, reason) => {
        expect(flagsForServer({ serverVersion, capabilityFlags: CLIENT_QUERY_ATTRIBUTES }))
            .toStrictEqual({ flags: OFF, reason });
    });

    it.each([
        ['8.0.26', 'supported'],
        ['8.0.26-16', 'supported'],
        ['8.0.100', 'supported'],
        ['8.1.0', 'supported'],
        ['8.4.9', 'supported'],
        ['9.0.1', 'supported'],
        ['10.0.0', 'supported'],
        ['5.5.5-10.6.18-MariaDB-log', 'mariadb'],
        ['11.4.2-MariaDB', 'mariadb']
    ])('keeps the default flags for a server that announces them as %s', (serverVersion, reason) => {
        expect(flagsForServer({ serverVersion, capabilityFlags: -1 })).toStrictEqual({ reason });
    });

    it.each(['8.0.22', '5.7.44', 'no version at all'])(
        'keeps the default flags when the server does not announce them, as %s', (serverVersion) => {
            expect(flagsForServer({ serverVersion, capabilityFlags: OTHER_CAPABILITIES }))
                .toStrictEqual({ reason: 'not_announced' });
        }
    );

    it('turns them off when there is no greeting', () => {
        expect(flagsForServer(undefined)).toStrictEqual({ flags: OFF, reason: 'probe_failed' });
    });
});

describe('a pool without flags in its settings', () => {
    it('logs in once, with the options the pool itself connects with', async () => {
        const settled = expect(poolFor({ port: 3307 }).connect()).rejects.toThrow('createPool reached');

        expect(createConnection).toHaveBeenCalledTimes(1);
        expect(createPool).not.toHaveBeenCalled();
        const { flags, ...probeOptions } = createConnection.mock.calls[0][0];
        expect(flags).toEqual(OFF);
        expect(probeOptions).toStrictEqual({
            host: 'node-a', port: 3307, user: 'u', password: 'secret-password', database: 'd'
        });

        probe().emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        // an option added to one of the two and not the other, such as ssl, fails here
        const { connectionLimit, maxPreparedStatements, ...poolOptions } = createPoolOptions();
        expect([connectionLimit, maxPreparedStatements]).toEqual([10, 100]);
        expect(poolOptions).toStrictEqual(probeOptions);
    });

    it('turns the flag off on an old server and logs out', async () => {
        const settled = expect(poolFor().connect()).rejects.toThrow('createPool reached');
        probe().emit('connect', { serverVersion: '8.0.25-15.1', capabilityFlags: -1 });
        await settled;

        expect(createPoolOptions().flags).toEqual(OFF);
        expect(probe().end).toHaveBeenCalledTimes(1);
    });

    it('keeps the createPool options as they were on a new server', async () => {
        const settled = expect(poolFor().connect()).rejects.toThrow('createPool reached');
        probe().emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        expect(createPoolOptions()).toStrictEqual({
            host: 'node-a', port: 3306, user: 'u', password: 'secret-password', database: 'd',
            connectionLimit: 10, maxPreparedStatements: 100
        });
        expect(probe().end).toHaveBeenCalledTimes(1);
    });

    it('decides for every node by itself', async () => {
        const versions = ['8.0.25', '8.0.36'];
        const flags = [];
        for (const serverVersion of versions) {
            const settled = expect(poolFor().connect()).rejects.toThrow('createPool reached');
            probe().emit('connect', { serverVersion, capabilityFlags: -1 });
            await settled;
            flags.push(createPoolOptions().flags);
        }
        expect(flags).toEqual([OFF, undefined]);
    });

    it('still creates the pool when the login fails, with the flag off', async () => {
        const settled = expect(poolFor().connect()).rejects.toThrow('createPool reached');
        probe().emit('error', refusedLogin({ code: 'ER_ACCESS_DENIED_ERROR' }));
        await settled;

        expect(createPoolOptions().flags).toEqual(OFF);
        expect(probe().destroy).toHaveBeenCalledTimes(1);
    });

    it('survives errors of the probe connection after the greeting, more than one', async () => {
        const settled = expect(poolFor().connect()).rejects.toThrow('createPool reached');
        const connection = probe();
        connection.emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        // an EventEmitter without an error listener throws here
        expect(() => connection.emit('error', new Error('read ECONNRESET'))).not.toThrow();
        expect(() => connection.emit('error', new Error('read ECONNRESET'))).not.toThrow();
        expect(connection.destroy).not.toHaveBeenCalled();
    });
});

describe('a pool that is still asking its server', () => {
    it('opens no pool when it is disconnected, and drops the login', async () => {
        const pool = poolFor();
        const settled = expect(pool.connect()).rejects.toThrow('was closed or connected again while connecting');
        const connection = probe();
        // no mysql2 pool exists yet
        expect(() => pool.disconnect()).not.toThrow();
        await settled;

        expect(connection.destroy).toHaveBeenCalledTimes(1);
        expect(createPool).not.toHaveBeenCalled();
        // a cancelled login is not a failed one
        expect(decisionLog()).toEqual([]);
    });

    it('opens no pool for a greeting that comes after the disconnect', async () => {
        const pool = poolFor();
        const settled = expect(pool.connect()).rejects.toThrow('was closed or connected again while connecting');
        const connection = probe();
        pool.disconnect();
        connection.emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        expect(createPool).not.toHaveBeenCalled();
    });

    it('opens one pool for connect, disconnect, connect', async () => {
        const pool = poolFor();
        const first = expect(pool.connect()).rejects.toThrow('was closed or connected again while connecting');
        const firstProbe = probe();
        pool.disconnect();
        const second = expect(pool.connect()).rejects.toThrow('createPool reached');
        const secondProbe = probe();
        expect(secondProbe).not.toBe(firstProbe);

        // the first login answers late: it must not count for the second connect()
        firstProbe.emit('connect', { serverVersion: '8.0.25', capabilityFlags: -1 });
        secondProbe.emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await first;
        await second;

        expect(createPool).toHaveBeenCalledTimes(1);
        expect('flags' in createPoolOptions()).toBe(false);
    });

    it('rejects a query, it does not throw outside the promise', async () => {
        const pool = poolFor();
        const settled = expect(pool.connect()).rejects.toThrow('was closed or connected again while connecting');

        await expect(pool.query('SELECT 1')).rejects.toMatchObject({
            code: 'POOL_NOT_CONNECTED', message: 'pool in host node-a is not connected yet'
        });
        await expect(pool.multiStatementQuery(['SELECT 1'], {})).rejects.toMatchObject({
            code: 'POOL_NOT_CONNECTED'
        });

        pool.disconnect();
        await settled;
    });

    it('rejects a cluster query for a service pinned to that node', async () => {
        const pool = poolFor();
        const settled = expect(pool.connect()).rejects.toThrow('was closed or connected again while connecting');
        // the cluster puts the node of a pinned service first without looking at its status
        const cluster: GaleraCluster = Object.assign(Object.create(GaleraCluster.prototype), {
            _pools: [pool],
            _useRedis: false,
            _errorRetryCount: 2,
            _clusterName: 'test',
            _nullServiceName: 'mdc',
            _clusterHashing: {
                connected: true,
                getNodeByService: () => 1,
                updateNodeForService: async () => undefined
            }
        });

        await expect(cluster.query('SELECT 1', null, { serviceId: 7, redis: false }))
            .rejects.toThrow('is not connected yet');

        pool.disconnect();
        await settled;
    });
});

describe('a pool with flags in its settings', () => {
    it.each([
        ['an array', ['-FOUND_ROWS']],
        ['an empty array', []],
        ['a string', 'IGNORE_SPACE'],
        ['an empty string', '']
    ])('does not ask the server when they are %s', async (_name, flags) => {
        await expect(poolFor({ flags }).connect()).rejects.toThrow('createPool reached');

        expect(createConnection).not.toHaveBeenCalled();
        expect(createPoolOptions().flags).toStrictEqual(flags);
    });
});

describe('the log of the decision', () => {
    const connectWith = async (event: string, payload: object) => {
        const settled = expect(poolFor().connect()).rejects.toThrow('createPool reached');
        probe().emit(event, payload);
        await settled;
    };

    it('is one info line when the flag is turned off', async () => {
        await connectWith('connect', { serverVersion: '8.0.25-15.1', capabilityFlags: -1 });

        expect(decisionLog()).toEqual([['info', {
            pool: 'node-a:3306', serverVersion: '8.0.25-15.1', reason: 'older_than_8.0.26', flags: OFF
        }]]);
        // the operator reads the version and the way out without the meta
        expect(log.info.mock.calls.map(call => call[0]).join()).toMatch(/8\.0\.25-15\.1.*set flags/);
    });

    it('is one debug line when nothing changes', async () => {
        await connectWith('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });

        expect(decisionLog()).toEqual([['debug', {
            pool: 'node-a:3306', serverVersion: '8.0.36', reason: 'supported'
        }]]);
    });

    it('is one warning when the version is not readable', async () => {
        await connectWith('connect', { serverVersion: 'weird', capabilityFlags: -1 });

        expect(decisionLog()).toEqual([['warn', {
            pool: 'node-a:3306', serverVersion: 'weird', reason: 'version_unreadable', flags: OFF
        }]]);
    });

    it.each([
        ['its code', { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 }, 'ER_ACCESS_DENIED_ERROR'],
        // mysql2 sets no code for an error number it does not know
        ['its number when it has no code', { errno: 9002 }, 'errno 9002'],
        ['"unknown" when it has neither', {}, 'unknown']
    ])('is one warning when the login fails, with %s and never the message', async (_name, extra, error) => {
        await connectWith('error', refusedLogin(extra));

        expect(decisionLog()).toEqual([['warn', {
            pool: 'node-a:3306', serverVersion: undefined, reason: 'probe_failed', flags: OFF, error
        }]]);
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Access denied');
    });

    it('never holds the password', async () => {
        await connectWith('connect', { serverVersion: '8.0.25', capabilityFlags: -1 });
        await connectWith('error', new Error('connect ECONNREFUSED'));

        const everything = JSON.stringify(Object.values(log).map(level => level.mock.calls));
        expect(everything).not.toContain('secret-password');
    });
});
