/**
 * Created by Bohdan on Sep, 2021
 */

import { ValidatorParams, LoadFactorParams } from './PoolInterfaces'

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
    amqp_logger?: object,
    use_amqp_logger?: boolean
}

export interface DefaultSettings extends Settings {
    port: string,
    connectionLimit: number,
    use_amqp_logger: boolean
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
