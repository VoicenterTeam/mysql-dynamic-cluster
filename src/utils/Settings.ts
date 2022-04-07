/**
 * Created by Bohdan on Sep, 2021
 */

import { UserPoolSettings, UserSettings } from "../types/SettingsInterfaces";
import Logger from "./Logger";
import defaultSettings from "../configs/DefaultSettings";
import deepmerge from "deepmerge";

export class Settings {
    /**
     * Mix user and pool settings with global
     * @param userSettings user settings
     */
    public static mixSettings(userSettings: UserSettings): UserSettings {
        Logger.debug("Mixing user and pool settings with global...");

        const overwriteMerge = (destinationArray, sourceArray) => sourceArray
        userSettings = deepmerge(defaultSettings, userSettings, {
            arrayMerge: overwriteMerge
        }) as UserSettings;

        userSettings.hosts = userSettings.hosts.map(host => {
            return deepmerge(userSettings.globalPoolSettings, host, {
                arrayMerge: overwriteMerge
            }) as UserPoolSettings;
        })

        return userSettings;
    }
}
