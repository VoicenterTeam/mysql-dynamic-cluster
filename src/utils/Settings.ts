/**
 * Created by Bohdan on Sep, 2021
 */

import { IParsedSettings, IUserSettings } from "../types/SettingsInterfaces";
import { IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { parseSettings } from "../configs/schema";
import deepmerge from "deepmerge";

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
            const own = Settings._withoutUndefined(host);
            const mixed = deepmerge(settings.defaultPoolSettings, own) as IUserPoolSettings;
            // flags of a host replace the default ones:
            // added to them, a host could not undo a "-FLAG"
            if (own.flags !== undefined) mixed.flags = own.flags;
            return mixed;
        })

        return settings;
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
