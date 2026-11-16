/**
 * Created by Bohdan on Sep, 2021
 */

import { IParsedSettings, IUserSettings } from "../types/SettingsInterfaces";
import { IDefaultPoolSettings, IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { parseSettings } from "../configs/schema";

export class Settings {
    /**
     * Validate user settings, fill in the defaults and mix every host with the default
     * pool settings
     * @param userSettings user settings, without redisInstant and logger
     * @throws Error that lists every wrong or unknown key by its path
     */
    public static mixSettings(userSettings: IUserSettings): IParsedSettings {
        const settings = parseSettings(userSettings);

        settings.hosts = settings.hosts.map(host => {
            return Settings._mix(settings.defaultPoolSettings, Settings._withoutUndefined(host));
        })

        return settings;
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
        return copy;
    }
}
