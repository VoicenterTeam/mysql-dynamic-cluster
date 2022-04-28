/**
 * Created by Bohdan on Sep, 2021
 */

import { IUserSettings } from "../types/SettingsInterfaces";
import { IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import Logger from "./Logger";
import defaultSettings from "../configs/DefaultSettings";
import deepmerge from "deepmerge";
import { isPlainObject } from 'is-plain-object';

export class Settings {
    /**
     * Mix user and pool settings with global
     * @param userSettings user settings
     */
    public static mixSettings(userSettings: IUserSettings): IUserSettings {
        Logger.debug("Mixing user and pool settings with global...");

        const overwriteMerge = (destinationArray, sourceArray) => sourceArray
        userSettings = deepmerge(defaultSettings, userSettings, {
            arrayMerge: overwriteMerge,
            isMergeableObject: isPlainObject
        }) as IUserSettings;

        userSettings.hosts = userSettings.hosts.map(host => {
            return deepmerge(userSettings.globalPoolSettings, host, {
                arrayMerge: overwriteMerge
            }) as IUserPoolSettings;
        })

        return userSettings;
    }
}
