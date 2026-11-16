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
    // anything but an object fails validation here, with the settings error
    if (userSettings === null || typeof userSettings !== 'object' || Array.isArray(userSettings)) {
        Settings.mixSettings(userSettings);
    }
    // live objects of the app, not settings to validate
    const { redisInstant, logger, ...settings } = userSettings;
    config.load(Settings.mixSettings(settings as IUserSettings));
    init(redisInstant, logger);
    return new GaleraCluster();
}

function init(redisInstant, logger?: ILogger): void {
    Logger.init(config.current.logs.level, logger);
    Metrics.init(config.current.clusterName);
    if(redisInstant instanceof Cluster ||  redisInstant?.constructor?.name === 'Redis'){
        Redis.init(redisInstant, config.current.clusterName, config.current.redis);
    }
    Logger.info("Initialized app");
}

export {
    createPoolCluster,
    LOGLEVEL,
    IUserSettings,
    ILogger
};
