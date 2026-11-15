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
// createPool records its options and stops connect() there: no socket, no timer
jest.mock('mysql2', () => ({
    __esModule: true,
    default: { createPool: jest.fn(() => { throw new Error('createPool reached'); }) }
}));

import mysql from 'mysql2';
import { Pool } from '../../src/pool/Pool';
import { Settings } from '../../src/utils/Settings';
import { parseSettings } from '../../src/configs/schema';
import { IUserSettings } from '../../src/types/SettingsInterfaces';

const QUERY_ATTRIBUTES_OFF = '-CLIENT_QUERY_ATTRIBUTES';
// capability bit of the MySQL protocol
const CLIENT_QUERY_ATTRIBUTES = 1 << 27;

const base = (): IUserSettings => ({
    clusterName: 'test',
    hosts: [{ host: '127.0.0.1' }],
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd' }
});

// The options mysql2 gets for every host of these settings, in host order
const createPoolOptions = async (settings: IUserSettings): Promise<any[]> => {
    const createPool = mysql.createPool as unknown as jest.Mock;
    createPool.mockClear();
    for (const host of Settings.mixSettings(settings).hosts) {
        const pool = new Pool({ id: 1, ...host }, 'test');
        await expect(pool.connect()).rejects.toThrow('createPool reached');
    }
    return createPool.mock.calls.map(call => call[0]);
};

describe('the flags pool setting', () => {
    it('reaches createPool from defaultPoolSettings, for every host', async () => {
        const settings = base();
        settings.hosts = [{ host: 'a' }, { host: 'b' }];
        settings.defaultPoolSettings.flags = [QUERY_ATTRIBUTES_OFF];

        const options = await createPoolOptions(settings);
        expect(options.map(o => o.host)).toEqual(['a', 'b']);
        expect(options[0].flags).toEqual([QUERY_ATTRIBUTES_OFF]);
        expect(options[1].flags).toEqual([QUERY_ATTRIBUTES_OFF]);
    });

    it('reaches createPool from one host, and only for that host', async () => {
        const settings = base();
        settings.hosts = [{ host: 'a', flags: [QUERY_ATTRIBUTES_OFF] }, { host: 'b' }];

        const options = await createPoolOptions(settings);
        expect(options[0].flags).toEqual([QUERY_ATTRIBUTES_OFF]);
        expect('flags' in options[1]).toBe(false);
    });

    it('of a host replaces the default one, it is not added to it', async () => {
        const settings = base();
        settings.defaultPoolSettings.flags = [QUERY_ATTRIBUTES_OFF];
        settings.hosts = [
            { host: 'a', flags: ['-FOUND_ROWS'] },
            { host: 'b', flags: [] },
            { host: 'c', flags: 'IGNORE_SPACE' }
        ];

        const options = await createPoolOptions(settings);
        expect(options[0].flags).toEqual(['-FOUND_ROWS']);
        expect(options[1].flags).toEqual([]);
        expect(options[2].flags).toBe('IGNORE_SPACE');
    });

    it('is passed as it is, as a string too', async () => {
        const settings = base();
        settings.defaultPoolSettings.flags = `${QUERY_ATTRIBUTES_OFF},-FOUND_ROWS`;

        const options = await createPoolOptions(settings);
        expect(options[0].flags).toBe(`${QUERY_ATTRIBUTES_OFF},-FOUND_ROWS`);
    });

    it('left out leaves the createPool options as they were', async () => {
        const options = await createPoolOptions(base());
        expect(options[0]).toStrictEqual({
            host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'd',
            connectionLimit: 10
        });
    });

    it('set to undefined on a host counts as left out, the default one stays', async () => {
        const settings = base();
        settings.defaultPoolSettings.flags = [QUERY_ATTRIBUTES_OFF];
        settings.hosts = [{ host: 'a', flags: undefined }];

        const options = await createPoolOptions(settings);
        expect(options[0].flags).toEqual([QUERY_ATTRIBUTES_OFF]);
    });

    // mysql2's types promise an array only. This pins that the real mysql2 takes the string too
    it.each([
        ['an array', [QUERY_ATTRIBUTES_OFF]],
        ['a string', QUERY_ATTRIBUTES_OFF]
    ])('turns the flag off in the real mysql2 when given as %s', (_name, flags) => {
        const real = jest.requireActual('mysql2');
        // no socket opens before a connection is asked for
        const clientFlags = (options: object): number =>
            real.createPool({ host: '127.0.0.1', ...options }).config.connectionConfig.clientFlags;

        expect(clientFlags({}) & CLIENT_QUERY_ATTRIBUTES).not.toBe(0);
        expect(clientFlags({ flags }) & CLIENT_QUERY_ATTRIBUTES).toBe(0);
    });

    it('has no default, so the parsed defaults get no flags key', () => {
        const parsed = parseSettings({});
        expect('flags' in parsed.defaultPoolSettings).toBe(false);
    });

    it.each([
        ['a number', 1],
        ['null', null],
        ['an array holding a number', ['-FOUND_ROWS', 1]],
        ['an object', { CLIENT_QUERY_ATTRIBUTES: false }]
    ])('is rejected when it is %s, in the defaults and in a host', (_name, value) => {
        const inDefaults: any = base();
        inDefaults.defaultPoolSettings.flags = value;
        expect(() => parseSettings(inDefaults)).toThrow(/defaultPoolSettings\.flags/);

        const inHost: any = base();
        inHost.hosts[0].flags = value;
        expect(() => parseSettings(inHost)).toThrow(/hosts\[0\]\.flags/);
    });
});
