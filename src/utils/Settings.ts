/**
 * Created by Bohdan on Sep, 2021
 */

import {UserPoolSettings, UserSettings} from "../types/SettingsInterfaces";
import Logger from "./Logger";
import defaultSettings from "../configs/DefaultSettings";

export class Settings {
    /**
     * Mix user and pool settings with global
     * @param userSettings user settings
     */
    public static mixSettings(userSettings: UserSettings): UserSettings {
        // #TODO: improve object assign. Confusing variable names and using object assign
        // Merge all global settings with default settings without deleting keys using lodash.merge
        // Then get from merged object only keys what in PoolSettings interfaces and mix it with each host
        // _.merge({}, value1, value2);
        Logger.debug("Mixing user and pool settings with global...");
        const defaultUserSettings = Object.assign({}, defaultSettings); // ?
        userSettings = Object.assign(defaultUserSettings, userSettings); // ?

        const globalPoolSettings: UserSettings = Object.assign({}, userSettings); // if type include key then add
        delete globalPoolSettings.hosts;
        delete globalPoolSettings.amqpLoggerSettings;
        delete globalPoolSettings.useAmqpLogger;
        delete globalPoolSettings.logLevel;
        Object.freeze(globalPoolSettings);

        userSettings.hosts = userSettings.hosts.map(host => {
            const poolSettings: UserPoolSettings = Object.assign({host: '127.0.0.1'}, globalPoolSettings);
            return Object.assign(poolSettings, host);
        });

        // #TODO: mix amqp settings

        const redisDefaultSettings = Object.assign({}, defaultSettings.redisSettings);
        userSettings.redisSettings = Object.assign(redisDefaultSettings, userSettings.redisSettings);

        return userSettings;
    }
}
