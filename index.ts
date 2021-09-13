import {UserSettings} from "./src/types/SettingsInterfaces";
import {GaleraCluster} from "./src/GaleraCluster";

function createPoolCluster(userSettings: UserSettings): GaleraCluster {
    return new GaleraCluster(userSettings);
}

export default {
    createPoolCluster
};
