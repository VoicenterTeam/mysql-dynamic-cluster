import { IUserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { LOGLEVEL } from './src/types/AmqpInterfaces';
import Logger from "./src/utils/Logger";
import { Settings } from "./src/utils/Settings";
import Redis from "./src/Redis/Redis";
import Metrics from "./src/metrics/Metrics";

function createPoolCluster(userSettings: IUserSettings): GaleraCluster {
    userSettings = Settings.mixSettings(userSettings);
    init(userSettings);
    return new GaleraCluster(userSettings);
}

function init(userSettings: IUserSettings): void {
    Logger.init(userSettings.useConsoleLogger, userSettings.clusterName);
    if (userSettings.logLevel !== undefined) {
        Logger.setLogLevel(userSettings.logLevel);
    }
    if (userSettings.useAmqpLogger) {
        Logger.enableAMQPLogger(userSettings.amqpLoggerSettings);
    }

    Metrics.init(userSettings.clusterName, userSettings.showMetricKeys);
    if (userSettings.redis) {
        Redis.init(userSettings.redis, userSettings.clusterName, userSettings.redisSettings);
    }
    Logger.info("Library initialized");
}

export {
    createPoolCluster,
    LOGLEVEL,
    IUserSettings
};
