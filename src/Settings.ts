/**
 * Created by Bohdan on Sep, 2021
 */

import { PoolSettings, UserSettings } from "./types/SettingsInterfaces";
import defaultSettings from "./configs/DefaultSettings";

export class Settings {
    /**
     * mix pool settings with global and global user settings
     * @param poolSettings pool settings
     * @param userSettings global user settings
     */
    public static mixPoolSettings(poolSettings: PoolSettings, userSettings: UserSettings) : PoolSettings {
        poolSettings = {
            user: userSettings.user,
            password: userSettings.password,
            database: userSettings.database,
            ...poolSettings
        }

        if (!poolSettings.connectionLimit && userSettings.connectionLimit) {
            poolSettings.connectionLimit = userSettings.connectionLimit
        }

        if (!poolSettings.port && userSettings.port) {
            poolSettings.port = userSettings.port
        }

        if (!poolSettings.validators && userSettings.validators) {
            poolSettings.validators = userSettings.validators
        } else if (!poolSettings.validators && !userSettings.validators) {
            poolSettings.validators = defaultSettings.validators
        }

        if (!poolSettings.loadFactors && userSettings.loadFactors) {
            poolSettings.loadFactors = userSettings.loadFactors
        } else if (!poolSettings.loadFactors && !userSettings.loadFactors) {
            poolSettings.loadFactors = defaultSettings.loadFactors
        }

        if (!poolSettings.timerCheckRange && userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = userSettings.timerCheckRange
        } else if (!poolSettings.timerCheckRange && !userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = defaultSettings.timerCheckRange
        }

        if (!poolSettings.timerCheckMultiplier && userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = userSettings.timerCheckMultiplier
        } else if (!poolSettings.timerCheckMultiplier && !userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = defaultSettings.timerCheckMultiplier
        }

        if (!poolSettings.queryTimeout && userSettings.queryTimeout) {
            poolSettings.queryTimeout = userSettings.queryTimeout
            console.log("Get timeout from user settings. Value: " + poolSettings.queryTimeout);
        } else if (!poolSettings.queryTimeout && !userSettings.queryTimeout) {
            poolSettings.queryTimeout = defaultSettings.queryTimeout
        }

        return poolSettings;
    }
}
