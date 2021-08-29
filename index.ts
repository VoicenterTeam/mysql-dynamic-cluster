import {UserSettings} from "./lib/interfaces";
import {GaleraCluster} from "./lib/GaleraCluster";

function createPoolCluster(userSettings?: UserSettings): GaleraCluster {
    return new GaleraCluster(userSettings);
}

export {
    createPoolCluster
};
