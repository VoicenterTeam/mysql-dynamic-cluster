/**
 * Created by Bohdan on Sep, 2021
 */

import {PoolSettings, UserSettings} from "../types/SettingsInterfaces";
import Logger from "./Logger";
import defaultSettings from "../configs/DefaultSettings";

export class Settings {
    /**
     * Mix user and pool settings with global
     * @param userSettings user settings
     */
    public static mixSettings(userSettings: UserSettings): UserSettings {
        Logger.debug("Mixing user and pool settings with global...");
        const defaultUserSettings = Object.assign({}, defaultSettings);
        userSettings = Object.assign(defaultUserSettings, userSettings);

        const globalPoolSettings: UserSettings = Object.assign({}, userSettings);
        delete globalPoolSettings.hosts;
        delete globalPoolSettings.amqp_logger;
        delete globalPoolSettings.use_amqp_logger;
        delete globalPoolSettings.logLevel;
        Object.freeze(globalPoolSettings);

        userSettings.hosts = userSettings.hosts.map(host => {
            const poolSettings: PoolSettings = Object.assign({host: '127.0.0.1'}, globalPoolSettings);
            return Object.assign(poolSettings, host);
        });

        return userSettings;
    }
}
