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
const logLines = (level: jest.Mock) => level.mock.calls.filter(call => String(call[0]).startsWith('Pool node-a:3306:'));

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
    it('logs in once with the settings of the pool and turns the flag off on an old server', async () => {
        const connecting = poolFor({ port: 3307 }).connect();
        const settled = expect(connecting).rejects.toThrow('createPool reached');

        expect(createConnection).toHaveBeenCalledTimes(1);
        expect(createConnection.mock.calls[0][0]).toStrictEqual({
            host: 'node-a', port: 3307, user: 'u', password: 'secret-password', database: 'd', flags: OFF
        });
        expect(createPool).not.toHaveBeenCalled();

        probe().emit('connect', { serverVersion: '8.0.25-15.1', capabilityFlags: -1 });
        await settled;

        expect(createPoolOptions().flags).toEqual(OFF);
        expect(probe().end).toHaveBeenCalledTimes(1);
    });

    it('keeps the createPool options as they were on a new server', async () => {
        const connecting = poolFor().connect();
        const settled = expect(connecting).rejects.toThrow('createPool reached');
        probe().emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        expect(createPoolOptions()).toStrictEqual({
            host: 'node-a', port: 3306, user: 'u', password: 'secret-password', database: 'd',
            connectionLimit: 10
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
        const connecting = poolFor().connect();
        const settled = expect(connecting).rejects.toThrow('createPool reached');
        const refused: any = new Error("Access denied for user 'u'@'10.0.0.1' (using password: YES)");
        refused.code = 'ER_ACCESS_DENIED_ERROR';
        probe().emit('error', refused);
        await settled;

        expect(createPoolOptions().flags).toEqual(OFF);
        expect(probe().destroy).toHaveBeenCalledTimes(1);
    });

    it('survives an error of the probe connection after the greeting', async () => {
        const connecting = poolFor().connect();
        const settled = expect(connecting).rejects.toThrow('createPool reached');
        const connection = probe();
        connection.emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        // an EventEmitter without an error listener throws here
        expect(() => connection.emit('error', new Error('read ECONNRESET'))).not.toThrow();
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('opens no pool when it was disconnected while asking the server', async () => {
        const pool = poolFor();
        const connecting = pool.connect();
        const settled = expect(connecting).rejects.toThrow('was closed while connecting');
        // no mysql2 pool exists yet: this used to throw
        expect(() => pool.disconnect()).not.toThrow();
        probe().emit('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });
        await settled;

        expect(createPool).not.toHaveBeenCalled();
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

    it('is one info line when the flag is turned off, naming the version and the way out', async () => {
        await connectWith('connect', { serverVersion: '8.0.25-15.1', capabilityFlags: -1 });

        expect(logLines(log.info)).toEqual([[
            'Pool node-a:3306: server 8.0.25-15.1 needs -CLIENT_QUERY_ATTRIBUTES, set flags in the settings to override',
            { pool: 'node-a:3306', serverVersion: '8.0.25-15.1', reason: 'older_than_8.0.26', flags: OFF }
        ]]);
        expect(logLines(log.warn)).toEqual([]);
    });

    it('is one debug line when nothing changes', async () => {
        await connectWith('connect', { serverVersion: '8.0.36', capabilityFlags: -1 });

        expect(logLines(log.debug)).toEqual([[
            'Pool node-a:3306: server 8.0.36 keeps the default flags of mysql2',
            { pool: 'node-a:3306', serverVersion: '8.0.36', reason: 'supported' }
        ]]);
        expect(logLines(log.info)).toEqual([]);
        expect(logLines(log.warn)).toEqual([]);
    });

    it('is one warning when the login fails, with the error code and not its message', async () => {
        const refused: any = new Error("Access denied for user 'u'@'10.0.0.1' (using password: YES)");
        refused.code = 'ER_ACCESS_DENIED_ERROR';
        await connectWith('error', refused);

        expect(logLines(log.warn)).toEqual([[
            'Pool node-a:3306: could not read the server version, connecting with -CLIENT_QUERY_ATTRIBUTES',
            {
                pool: 'node-a:3306', serverVersion: undefined, reason: 'probe_failed', flags: OFF,
                error: 'ER_ACCESS_DENIED_ERROR'
            }
        ]]);
    });

    it('never holds the password', async () => {
        await connectWith('connect', { serverVersion: '8.0.25', capabilityFlags: -1 });
        await connectWith('error', new Error('connect ECONNREFUSED'));

        const everything = JSON.stringify(Object.values(log).map(level => level.mock.calls));
        expect(everything).not.toContain('secret-password');
    });
});
