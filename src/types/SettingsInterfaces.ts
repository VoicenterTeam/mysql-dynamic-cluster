/**
 * Created by Bohdan on Sep, 2021
 */

import { ValidatorParams, LoadFactorParams } from './PoolInterfaces';
import { Redis, Cluster } from 'ioredis';
import { BinaryToTextEncoding } from 'crypto';
import { IAmqpConfig, IUserAmqpConfig } from "./AmqpInterfaces";

export enum LOGLEVEL {
    QUIET,
    REGULAR,
    FULL
}

interface PoolSettings {
    port?: string,
    user?: string,
    password?: string,
    database?: string,
    queryTimeout?: number,
    connectionLimit?: number,
    errorRetryCount?: number,
    validators?: ValidatorParams[],
    loadFactors?: LoadFactorParams[],
    timerCheckRange?: ITimerCheckRange, // Time in ms
    timerCheckMultiplier?: number
}

export interface ITimerCheckRange {
    start: number,
    end: number
}

export interface GlobalUserPoolSettings extends PoolSettings {
    user: string,
    password: string,
    database: string
}

export interface UserPoolSettings extends PoolSettings {
    id?: number,
    name?: string,
    host: string
}

export interface DefaultPoolSettings extends PoolSettings {
    port: string,
    queryTimeout: number,
    connectionLimit: number,
    errorRetryCount: number,
    validators: ValidatorParams[],
    loadFactors: LoadFactorParams[],
    timerCheckRange: ITimerCheckRange, // Time in ms
    timerCheckMultiplier: number
}

interface ISettings {
    redisSettings?: RedisSettings
    useAmqpLogger?: boolean,
    amqpLoggerSettings?: IUserAmqpConfig,
    logLevel?: LOGLEVEL,
}

export interface UserSettings extends ISettings {
    hosts: UserPoolSettings[],
    globalPoolSettings: GlobalUserPoolSettings,
    redis?: Redis | Cluster
}

export interface DefaultSettings extends ISettings {
    globalPoolSettings: DefaultPoolSettings,
    useAmqpLogger: boolean,
    logLevel: LOGLEVEL,
    redisSettings: DefaultRedisSettings,
    amqpLoggerSettings: IAmqpConfig
}

export interface RedisSettings {
    keyPrefix?: string,
    expire?: number,
    expiryMode?: string,
    algorithm?: string,
    encoding?: BinaryToTextEncoding,
    clearOnStart?: boolean
}

export interface DefaultRedisSettings extends RedisSettings {
    keyPrefix: string,
    expire: number,
    expiryMode: string,
    algorithm: string,
    encoding: BinaryToTextEncoding,
    clearOnStart: boolean
}
