/**
 * Created by Bohdan on Sep, 2021
 */

import { Redis , Cluster } from 'ioredis';
import { ILogger, ILoggerSettings } from './LoggerInterfaces'
import { IClusterHashingSettings, IDefaultClusterHashingSettings } from "./ClusterHashingInterfaces";
import { IDefaultRedisSettings, IRedisSettings } from "./RedisInterfaces";
import { IDefaultPoolSettings, IDefaultUserPoolSettings, IUserPoolSettings } from "./PoolSettingsInterfaces";
import { IDefaultMetricsSettings, IDefaultServiceMetricsSettings, IMetricsSettings, IServiceMetricsSettings } from "./MetricsInterfaces";

interface ISettings {
    redisInstant?: Redis | Cluster,
    errorRetryCount?: number,
    serviceMetrics?: IServiceMetricsSettings,
    metrics?: IMetricsSettings,
    useClusterHashing?: boolean,
    clusterHashing?: IClusterHashingSettings,
    redis?: IRedisSettings,
    logs?: ILoggerSettings,
    // logger of the app, the console when not passed
    logger?: ILogger
}

export interface IUserSettings extends ISettings {
    clusterName: string,
    hosts: IUserPoolSettings[],
    defaultPoolSettings: IDefaultUserPoolSettings
}

export interface IDefaultSettings extends ISettings {
    defaultPoolSettings: IDefaultPoolSettings,
    errorRetryCount: number,
    serviceMetrics: IDefaultServiceMetricsSettings,
    metrics: IDefaultMetricsSettings,
    useClusterHashing: boolean,
    clusterHashing: IDefaultClusterHashingSettings,
    redis: IDefaultRedisSettings,
    logs: ILoggerSettings
}

// Settings after validation: every default filled in, every host mixed with the default
// pool settings
export interface IParsedSettings extends IDefaultSettings {
    clusterName: string,
    hosts: IUserPoolSettings[]
}
