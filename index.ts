import { UserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/GaleraCluster";
import globalSettings from './src/configs/GlobalSettings'

function createPoolCluster(userSettings: UserSettings): GaleraCluster {
    init(userSettings);
    return new GaleraCluster(userSettings);
}

function init(userSettings: UserSettings): void {
    if (userSettings.debug !== undefined) {
        globalSettings.debug = userSettings.debug;
    }
}

export default {
    createPoolCluster
};
