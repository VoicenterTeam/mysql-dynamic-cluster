import { IUserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { LOGLEVEL } from './src/types/LoggerInterfaces';
import Logger from "./src/utils/Logger";
import { Settings } from "./src/utils/Settings";
import Redis from "./src/Redis/Redis";
import Metrics from "./src/metrics/Metrics";
import config from './src/configs';
import { Redis as RedisLib, Cluster}  from 'ioredis'

function createPoolCluster(userSettings: IUserSettings): GaleraCluster {
    userSettings = Settings.mixSettings(userSettings);
    config.load(userSettings).validate();
    init();
    return new GaleraCluster();
}

function init(): void {
    Logger.init();
    const redisInstant:any = config.get('redisInstant')
    Metrics.init(config.get('clusterName'), config.get('showMetricKeys'));
    // tslint:disable-next-line:no-bitwise
    if(redisInstant instanceof Cluster ||  redisInstant in Redis){
        Redis.init(redisInstant, config.get('clusterName'), config.get('redis'));
    }
    Logger.info("Initialized app");
}

export {
    createPoolCluster,
    LOGLEVEL,
    IUserSettings
};
