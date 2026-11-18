/**
 * Created by Bohdan on Sep, 2021
 */

import { IParsedSettings, IUserSettings } from "../types/SettingsInterfaces";
import { IDefaultPoolSettings, IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { fillHealthCheck, parseSettings } from "../configs/schema";

// The two keys of the legacy check. A node that has a healthCheck block ignores them
const LEGACY_CHECK_KEYS = ['timerCheckRange', 'timerCheckMultiplier'] as const;

export class Settings {
    // The legacy check keys the app wrote for a host that ignores them, by the mixed settings
    // of that host. Kept beside the settings: those hold only the keys of the schema
    private static readonly _ignoredCheckKeys = new WeakMap<IUserPoolSettings, string[]>();

    /**
     * Validate user settings, fill in the defaults and mix every host with the default
     * pool settings
     * @param userSettings user settings, without redisInstant and logger
     * @throws Error that lists every wrong or unknown key by its path
     */
    public static mixSettings(userSettings: IUserSettings): IParsedSettings {
        const settings = parseSettings(userSettings);
        const defaults = settings.defaultPoolSettings;
        // `healthCheck: undefined` is the same as no block
        if (defaults.healthCheck === undefined) delete defaults.healthCheck;

        settings.hosts = settings.hosts.map((host, index) => {
            const mixed = Settings._mix(defaults, Settings._withoutUndefined(host));
            if (mixed.healthCheck) {
                // what the app wrote, not what the schema filled in: the valid settings
                // have a defaultPoolSettings or none, and one host per parsed host
                const written = [userSettings.defaultPoolSettings, userSettings.hosts[index]];
                Settings._ignoredCheckKeys.set(mixed, LEGACY_CHECK_KEYS.filter(key => {
                    return written.some(pool => pool !== undefined && pool[key] !== undefined);
                }));
            }
            return mixed;
        })

        return settings;
    }

    /**
     * The legacy check keys the app wrote for this host, on the host itself or in the default
     * pool settings, although the host has a healthCheck block and so ignores them. A key the
     * app left out, or set to undefined, is not one of them, whatever default the schema gave
     * it. Empty for a host without the block
     * @param host a host of the result of mixSettings(), the same object
     */
    public static ignoredCheckKeys(host: IUserPoolSettings): string[] {
        return [...(Settings._ignoredCheckKeys.get(host) || [])];
    }

    /**
     * The default pool settings with the keys of the host on top. Every array and object in
     * the result is a copy, so hosts share nothing with the defaults or with each other
     * @private
     */
    private static _mix(defaults: IDefaultPoolSettings, own: IUserPoolSettings): IUserPoolSettings {
        const mixed: IUserPoolSettings = {
            // flags of a host replace the default ones:
            // added to them, a host could not undo a "-FLAG"
            ...defaults,
            ...own,
            // validators and loadFactors of a host are added to the default ones
            validators: [...defaults.validators, ...(own.validators || [])].map(item => ({ ...item })),
            loadFactors: [...defaults.loadFactors, ...(own.loadFactors || [])].map(item => ({ ...item })),
            timerCheckRange: { ...defaults.timerCheckRange, ...own.timerCheckRange }
        };
        if (Array.isArray(mixed.flags)) mixed.flags = [...mixed.flags];
        // A block on either side gives the host one. Its keys are mixed one by one, and
        // every key left out on both sides gets its default
        if (mixed.healthCheck) {
            mixed.healthCheck = fillHealthCheck({ ...defaults.healthCheck, ...own.healthCheck });
        }
        return mixed;
    }

    /**
     * A copy of the host without the keys set to undefined, so that `port: undefined` means
     * "not set" and takes the default, where the merge would erase the default
     * @private
     */
    private static _withoutUndefined(host: IUserPoolSettings): IUserPoolSettings {
        const copy = { ...host };
        Object.keys(copy).forEach(key => {
            if (copy[key] === undefined) delete copy[key];
        });
        if (copy.timerCheckRange) {
            const range = { ...copy.timerCheckRange };
            if (range.start === undefined) delete range.start;
            if (range.end === undefined) delete range.end;
            copy.timerCheckRange = range;
        }
        if (copy.healthCheck) {
            // the same for a key of the block: it takes the one of the default block
            const block = { ...copy.healthCheck };
            Object.keys(block).forEach(key => {
                if (block[key] === undefined) delete block[key];
            });
            copy.healthCheck = block;
        }
        return copy;
    }
}
