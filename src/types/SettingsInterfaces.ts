/**
 * Created by Bohdan on Sep, 2021
 */

import { Redis , Cluster } from 'ioredis';
import {LOGLEVEL, ILoggerSettings  } from './LoggerInterfaces'
import { IDefaultAmqpConfig, IUserAmqpConfig } from "./AmqpInterfaces";
import { IClusterHashingSettings, IDefaultClusterHashingSettings } from "./ClusterHashingInterfaces";
import { IDefaultRedisSettings, IRedisSettings } from "./RedisInterfaces";
import { IDefaultPoolSettings, IDefaultUserPoolSettings, IUserPoolSettings } from "./PoolSettingsInterfaces";
import { IDefaultServiceMetricsSettings, IServiceMetricsSettings } from "./MetricsInterfaces";

interface ISettings {
    redisInstant?: Redis | Cluster,
    errorRetryCount?: number,
    serviceMetrics?: IServiceMetricsSettings,
    useClusterHashing?: boolean,
    clusterHashing?: IClusterHashingSettings,
    redisSettings?: IRedisSettings,
    showMetricKeys?: boolean,
    logs: ILoggerSettings,
    amqp_logs: IUserAmqpConfig
}

export interface IUserSettings extends ISettings {
    clusterName: string,
    hosts: IUserPoolSettings[],
    defaultPoolSettings: IDefaultUserPoolSettings
}

export interface IDefaultSettings extends ISettings {
    defaultPoolSettings: IDefaultPoolSettings,
    redisInstant: Redis | Cluster,
    errorRetryCount: number,
    serviceMetrics: IDefaultServiceMetricsSettings,
    useClusterHashing: boolean,
    clusterHashing: IDefaultClusterHashingSettings,
    showMetricKeys: boolean,
    redisSettings: IDefaultRedisSettings,
    logs: ILoggerSettings,
    amqp_logs: IUserAmqpConfig
}
