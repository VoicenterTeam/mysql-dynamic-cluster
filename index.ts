import { UserSettings } from "./src/types/SettingsInterfaces";
import { GaleraCluster } from "./src/cluster/GaleraCluster";
import { LOGLEVEL } from './src/types/AmqpInterfaces';
import Logger from "./src/utils/Logger";
import { Settings } from "./src/utils/Settings";
import Redis from "./src/utils/Redis";
import Metrics from "./src/metrics/Metrics";

function createPoolCluster(userSettings: UserSettings): GaleraCluster {
    userSettings = Settings.mixSettings(userSettings);
    init(userSettings);
    return new GaleraCluster(userSettings);
}

function init(userSettings: UserSettings): void {
    Logger.init(userSettings.useConsoleLogger, userSettings.clusterName);
    if (userSettings.logLevel !== undefined) {
        Logger.setLogLevel(userSettings.logLevel);
    }
    if (userSettings.useAmqpLogger) {
        Logger.enableAMQPLogger(userSettings.amqpLoggerSettings);
    }

    Metrics.init(userSettings.clusterName, userSettings.showMetricKeys);
    Redis.init(userSettings.redis, userSettings.clusterName, userSettings.redisSettings);
    Logger.info("Initialized app");
}

export {
    createPoolCluster,
    LOGLEVEL
};
