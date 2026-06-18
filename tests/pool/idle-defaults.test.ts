import config from '../../src/configs';
import { Settings } from '../../src/utils/Settings';
import { IUserSettings } from '../../src/types/SettingsInterfaces';

describe('idle connection defaults (convict schema)', () => {
    const poolDefaults = config.get('defaultPoolSettings');

    it('connectionLimit defaults to 10', () => {
        expect(poolDefaults.connectionLimit).toBe(10);
    });

    it('minConnections defaults to 1', () => {
        expect(poolDefaults.minConnections).toBe(1);
    });

    it('idleTimeout defaults to 30000', () => {
        expect(poolDefaults.idleTimeout).toBe(30000);
    });

    it('idleCheckInterval defaults to 10000', () => {
        expect(poolDefaults.idleCheckInterval).toBe(10000);
    });
});

describe('idle connection defaults merged onto hosts', () => {
    const base: IUserSettings = {
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1' }],
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd' }
    } as IUserSettings;

    it('every host inherits the three idle settings and the new connectionLimit', () => {
        const host = Settings.mixSettings(base).hosts[0];
        expect(host.connectionLimit).toBe(10);
        expect(host.minConnections).toBe(1);
        expect(host.idleTimeout).toBe(30000);
        expect(host.idleCheckInterval).toBe(10000);
    });

    it('a per-host override of connectionLimit is preserved', () => {
        const overridden: IUserSettings = {
            clusterName: 'test',
            hosts: [{ host: '127.0.0.1', connectionLimit: 50 }],
            defaultPoolSettings: { user: 'u', password: 'p', database: 'd' }
        } as IUserSettings;
        expect(Settings.mixSettings(overridden).hosts[0].connectionLimit).toBe(50);
    });
});
