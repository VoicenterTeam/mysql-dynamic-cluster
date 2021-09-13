import { PoolSettings, UserSettings } from "./types/SettingsInterfaces";
import globalSettings from "./configs/GlobalSettings";

export class Settings {
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
            poolSettings.validators = globalSettings.validators
        }

        if (!poolSettings.loadFactors && userSettings.loadFactors) {
            poolSettings.loadFactors = userSettings.loadFactors
        } else if (!poolSettings.loadFactors && !userSettings.loadFactors) {
            poolSettings.loadFactors = globalSettings.loadFactors
        }

        if (!poolSettings.timerCheckRange && userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = userSettings.timerCheckRange
        } else if (!poolSettings.timerCheckRange && !userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = globalSettings.timerCheckRange
        }

        if (!poolSettings.timerCheckMultiplier && userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = userSettings.timerCheckMultiplier
        } else if (!poolSettings.timerCheckMultiplier && !userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = globalSettings.timerCheckMultiplier
        }

        if (!poolSettings.queryTimeout && userSettings.queryTimeout) {
            poolSettings.queryTimeout = userSettings.queryTimeout
            console.log("Get timeout from user settings. Value: " + poolSettings.queryTimeout);
        } else if (!poolSettings.queryTimeout && !userSettings.queryTimeout) {
            poolSettings.queryTimeout = globalSettings.queryTimeout
        }

        return poolSettings;
    }
}
