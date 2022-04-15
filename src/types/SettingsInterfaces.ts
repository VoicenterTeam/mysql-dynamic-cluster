/**
 * Created by Bohdan on Sep, 2021
 */

import { Redis, Cluster } from 'ioredis';
import { IDefaultAmqpConfig, IUserAmqpConfig, LOGLEVEL } from "./AmqpInterfaces";
import { ClusterHashingSettings, DefaultClusterHashingSettings } from "./ClusterHashingInterfaces";
import { DefaultRedisSettings, RedisSettings } from "./RedisInterfaces";
import { DefaultPoolSettings, GlobalUserPoolSettings, UserPoolSettings } from "./PoolSettingsInterfaces";

interface ISettings {
    clusterHashing?: ClusterHashingSettings,
    redisSettings?: RedisSettings,
    showMetricKeys?: boolean,
    useAmqpLogger?: boolean,
    amqpLoggerSettings?: IUserAmqpConfig,
    useConsoleLogger?: boolean,
    logLevel?: LOGLEVEL,
}

export interface UserSettings extends ISettings {
    clusterName: string,
    hosts: UserPoolSettings[],
    globalPoolSettings: GlobalUserPoolSettings,
    redis?: Redis | Cluster
}

export interface DefaultSettings extends ISettings {
    globalPoolSettings: DefaultPoolSettings,
    clusterHashing: DefaultClusterHashingSettings,
    showMetricKeys: boolean,
    useAmqpLogger: boolean,
    useConsoleLogger: boolean,
    logLevel: LOGLEVEL,
    redisSettings: DefaultRedisSettings,
    amqpLoggerSettings: IDefaultAmqpConfig
}
