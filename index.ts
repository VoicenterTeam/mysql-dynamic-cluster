import { IUserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { ILogger, LOGLEVEL } from './src/types/LoggerInterfaces';
import {
    IClusterConnection, IGetConnectionOptions, INodeCheckError, INodeInfo, INodePoolStats,
    INodeReadyResult
} from './src/types/NodeInterfaces';
import { IQueryTiming, QueryStep } from './src/types/PoolInterfaces';
import { IClusterContext } from './src/types/ClusterContextInterfaces';
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
    return new GaleraCluster(clusterContext(logger));
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

/**
 * What the new cluster keeps for itself (#86): a logger with the level and the logger of the app
 * of the settings just loaded, and their clusterName and metrics.serverAttributes for its metrics. A later createPoolCluster
 * changes neither. The logger is a view of the module logger: its methods are those of the
 * module logger, looked up at each call, and only the level and the logger of the app are its own
 */
function clusterContext(logger?: ILogger): IClusterContext {
    const clusterLogger = Object.create(Logger);
    clusterLogger.init(config.current.logs.level, logger);
    return {
        logger: clusterLogger,
        clusterName: config.current.clusterName,
        serverAttributes: config.current.metrics.serverAttributes
    };
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
export type { IQueryTiming, QueryStep };
