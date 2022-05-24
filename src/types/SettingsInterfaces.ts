/**
 * Created by Bohdan on Sep, 2021
 */

import { Redis, Cluster } from 'ioredis';
import { IDefaultAmqpConfig, IUserAmqpConfig, LOGLEVEL } from "./AmqpInterfaces";
import { IClusterHashingSettings, IDefaultClusterHashingSettings } from "./ClusterHashingInterfaces";
import { IDefaultRedisSettings, IRedisSettings } from "./RedisInterfaces";
import { IDefaultPoolSettings, IGlobalUserPoolSettings, IUserPoolSettings } from "./PoolSettingsInterfaces";
import { IDefaultServiceMetricsSettings, IServiceMetricsSettings } from "./MetricsInterfaces";

interface ISettings {
    serviceMetrics?: IServiceMetricsSettings,
    useClusterHashing?: boolean,
    clusterHashing?: IClusterHashingSettings,
    redisSettings?: IRedisSettings,
    showMetricKeys?: boolean,
    useAmqpLogger?: boolean,
    amqpLoggerSettings?: IUserAmqpConfig,
    useConsoleLogger?: boolean,
    logLevel?: LOGLEVEL,
}

export interface IUserSettings extends ISettings {
    clusterName: string,
    hosts: IUserPoolSettings[],
    globalPoolSettings: IGlobalUserPoolSettings,
    redis?: Redis | Cluster
}

export interface IDefaultSettings extends ISettings {
    globalPoolSettings: IDefaultPoolSettings,
    serviceMetrics: IDefaultServiceMetricsSettings,
    useClusterHashing: boolean,
    clusterHashing: IDefaultClusterHashingSettings,
    showMetricKeys: boolean,
    useAmqpLogger: boolean,
    useConsoleLogger: boolean,
    logLevel: LOGLEVEL,
    redisSettings: IDefaultRedisSettings,
    amqpLoggerSettings: IDefaultAmqpConfig
}
