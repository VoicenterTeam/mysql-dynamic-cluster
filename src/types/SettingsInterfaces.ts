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

export interface PoolSettings {
    port?: string,
    user?: string,
    password?: string,
    database?: string,
    queryTimeout?: number,
    connectionLimit?: number,
    errorRetryCount?: number,
}

export interface GlobalPoolSettings extends PoolSettings{
    user: string,
    password: string,
    database: string
}

export interface UserPoolSettings extends PoolSettings {
    id?: number,
    name?: string,
    host: string
}

export interface Settings {
    validators?: ValidatorParams[],
    loadFactors?: LoadFactorParams[],
    timerCheckRange?: [number, number], // Time in ms
    timerCheckMultiplier?: number, // Time in ms
    redisSettings?: RedisSettings
    useAmqpLogger?: boolean,
    amqpLoggerSettings?: IUserAmqpConfig,
    logLevel?: LOGLEVEL,
}

export interface UserSettings extends Settings, GlobalPoolSettings {
    hosts: UserPoolSettings[],
    redis?: Redis | Cluster
}

export interface DefaultSettings extends Settings, PoolSettings {
    port: string,
    connectionLimit: number,
    queryTimeout: number, // Time in ms
    errorRetryCount: number,
    validators: ValidatorParams[],
    loadFactors: LoadFactorParams[],
    timerCheckRange: [number, number], // Time in ms
    timerCheckMultiplier: number, // Time in ms
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

export interface DefaultRedisSettings extends RedisSettings{
    keyPrefix: string,
    expire: number,
    expiryMode: string,
    algorithm: string,
    encoding: BinaryToTextEncoding,
    clearOnStart: boolean
}
