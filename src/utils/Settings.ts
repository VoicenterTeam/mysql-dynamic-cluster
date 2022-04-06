/**
 * Created by Bohdan on Sep, 2021
 */

import {GlobalUserPoolSettings, UserSettings} from "../types/SettingsInterfaces";
import Logger from "./Logger";
import defaultSettings from "../configs/DefaultSettings";
import deepmerge from "deepmerge";

export class Settings {
    /**
     * Mix user and pool settings with global
     * @param userSettings user settings
     */
    public static mixSettings(userSettings: UserSettings): UserSettings {
        // Then get from merged object only keys what in PoolSettings interfaces and mix it with each host
        // _.merge({}, value1, value2);
        // #TODO: mix amqp settings

        Logger.debug("Mixing user and pool settings with global...");

        const overwriteMerge = (destinationArray, sourceArray) => sourceArray
        userSettings = deepmerge(defaultSettings, userSettings, { arrayMerge: overwriteMerge }) as UserSettings;
        console.log(test);
        return userSettings;

        // userSettings.hosts = userSettings.hosts.map(host => {
        //     const poolSettings: UserPoolSettings = Object.assign({host: '127.0.0.1'}, globalPoolSettings);
        //     return Object.assign(poolSettings, host);
        // });

        // const redisDefaultSettings = Object.assign({}, defaultSettings.redisSettings);
        // userSettings.redisSettings = Object.assign(redisDefaultSettings, userSettings.redisSettings);

        return userSettings;
    }
}
