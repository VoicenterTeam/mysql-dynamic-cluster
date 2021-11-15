/**
 * Created by Bohdan on Sep, 2021
 */

import { PoolSettings, UserSettings } from "../types/SettingsInterfaces";

export class Settings {
    /**
     * Mix pool settings with global and user settings
     * @param poolSettings pool settings
     * @param userSettings user settings
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
        }

        if (!poolSettings.loadFactors && userSettings.loadFactors) {
            poolSettings.loadFactors = userSettings.loadFactors
        }

        if (!poolSettings.timerCheckRange && userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = userSettings.timerCheckRange
        }

        if (!poolSettings.timerCheckMultiplier && userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = userSettings.timerCheckMultiplier
        }

        if (!poolSettings.queryTimeout && userSettings.queryTimeout) {
            poolSettings.queryTimeout = userSettings.queryTimeout
        }

        return poolSettings;
    }
}
