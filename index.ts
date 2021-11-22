import { UserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { LOGLEVEL } from './src/types/SettingsInterfaces';
import Logger from "./src/utils/Logger";

function createPoolCluster(userSettings: UserSettings): GaleraCluster {
    init(userSettings);
    return new GaleraCluster(userSettings);
}

function init(userSettings: UserSettings): void {
    if (userSettings.logLevel !== undefined) {
        Logger.setLogLevel(userSettings.logLevel);
    }
}

export {
    createPoolCluster,
    LOGLEVEL
};
