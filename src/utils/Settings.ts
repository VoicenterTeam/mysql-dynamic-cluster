/**
 * Created by Bohdan on Sep, 2021
 */

import { UserSettings } from "../types/SettingsInterfaces";
import { UserPoolSettings } from "../types/PoolSettingsInterfaces";
import Logger from "./Logger";
import defaultSettings from "../configs/DefaultSettings";
import deepmerge from "deepmerge";
import { isPlainObject } from 'is-plain-object';

export class Settings {
    /**
     * Mix user and pool settings with global
     * @param userSettings user settings
     */
    public static mixSettings(userSettings: UserSettings): UserSettings {
        Logger.debug("Mixing user and pool settings with global...");

        const overwriteMerge = (destinationArray, sourceArray) => sourceArray
        userSettings = deepmerge(defaultSettings, userSettings, {
            arrayMerge: overwriteMerge,
            isMergeableObject: isPlainObject
        }) as UserSettings;

        userSettings.hosts = userSettings.hosts.map(host => {
            return deepmerge(userSettings.globalPoolSettings, host, {
                arrayMerge: overwriteMerge
            }) as UserPoolSettings;
        })

        return userSettings;
    }
}
