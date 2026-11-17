import { IUserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { ILogger, LOGLEVEL } from './src/types/LoggerInterfaces';
import {
    IClusterConnection, IGetConnectionOptions, INodeCheckError, INodeInfo, INodePoolStats,
    INodeReadyResult
} from './src/types/NodeInterfaces';
import Logger from "./src/utils/Logger";
import { Settings } from "./src/utils/Settings";
import Redis from "./src/Redis/Redis";
import Metrics from "./src/metrics/Metrics";
import config from './src/configs';
import { Redis as RedisLib, Cluster}  from 'ioredis'

function createPoolCluster(userSettings: IUserSettings): GaleraCluster {
    // anything but an object is not valid settings
    if (userSettings === null || typeof userSettings !== 'object' || Array.isArray(userSettings)) {
        throw settingsError(userSettings);
    }
    // live objects of the app, not settings to validate
    const { redisInstant, logger, ...settings } = userSettings;
    config.load(Settings.mixSettings(settings as IUserSettings));
    init(redisInstant, logger);
    return new GaleraCluster();
}

/**
 * The error the settings validation throws for these settings
 */
function settingsError(userSettings: IUserSettings): Error {
    try {
        Settings.mixSettings(userSettings);
    } catch (e) {
        return e;
    }
    return new Error("Invalid mysql-dynamic-cluster settings");
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
    ILogger,
    IGetConnectionOptions,
    IClusterConnection,
    INodeInfo,
    INodePoolStats,
    INodeReadyResult,
    INodeCheckError
};
