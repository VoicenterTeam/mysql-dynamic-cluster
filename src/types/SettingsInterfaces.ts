/**
 * Created by Bohdan on Sep, 2021
 */

import { ValidatorParams, LoadFactorParams } from './PoolInterfaces';
import { Redis, Cluster } from 'ioredis';
import { BinaryToTextEncoding } from 'crypto';

export enum LOGLEVEL {
    QUIET,
    REGULAR,
    FULL
}

export interface Settings {
    connectionLimit?: number,
    port?: string,
    validators?: ValidatorParams[],
    loadFactors?: LoadFactorParams[],
    // Time in ms
    timerCheckRange?: [number, number],
    timerCheckMultiplier?: number,
    // Time in ms
    queryTimeout?: number,
    errorRetryCount?: number,
    logLevel?: LOGLEVEL
}

// Global user settings
export interface UserSettings extends Settings {
    hosts: PoolSettings[],
    user: string,
    password: string,
    database: string,
    amqpLoggerSettings?: object,
    redis?: Redis | Cluster,
    redisSettings?: RedisSettings
    useAmqpLogger?: boolean,
}

export interface DefaultSettings extends Settings {
    port: string,
    connectionLimit: number,
    useAmqpLogger: boolean,
    logLevel: LOGLEVEL,
    redisSettings: RedisSettings
}

export interface PoolSettings extends Settings {
    id?: number,
    host: string,
    name?: string,
    user?: string,
    password?: string,
    database?: string,
    queryTimeout?: number
}

export interface RedisSettings {
    keyPrefix?: string,
    expire?: number,
    expiryMode?: string,
    algorithm?: string,
    encoding?: BinaryToTextEncoding,
    clearOnStart?: boolean
}
