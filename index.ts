import { IUserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { ILogger, LOGLEVEL } from './src/types/LoggerInterfaces';
import Logger from "./src/utils/Logger";
import { Settings } from "./src/utils/Settings";
import Redis from "./src/Redis/Redis";
import Metrics from "./src/metrics/Metrics";
import config from './src/configs';
import { Redis as RedisLib, Cluster}  from 'ioredis'

function createPoolCluster(userSettings: IUserSettings): GaleraCluster {
    // the logger is a live object of the app: taken off before the merge, which would copy it
    const { logger, ...settings } = userSettings;
    userSettings = Settings.mixSettings(settings as IUserSettings);
    let redisInstant = userSettings.redisInstant;
    delete userSettings.redisInstant;
    config.load(userSettings).validate;
    init(redisInstant, logger);
    return new GaleraCluster();
}

function init(redisInstant, logger?: ILogger): void {
    Logger.init(config.get('logs.level'), logger);
    Metrics.init(config.get('clusterName'));
    // tslint:disable-next-line:no-bitwise
    if(redisInstant instanceof Cluster ||  redisInstant?.constructor?.name === 'Redis'){
        Redis.init(redisInstant, config.get('clusterName'), config.get('redis'));
    }
    Logger.info("Initialized app");
}

export {
    createPoolCluster,
    LOGLEVEL,
    IUserSettings,
    ILogger
};
