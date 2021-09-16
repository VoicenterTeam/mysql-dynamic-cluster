/**
 * Created by Bohdan on Sep, 2021
 */

import { ValidatorParams, LoadFactorParams } from './PoolInterfaces'

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
    errorRetryCount?: number
}

// Global user settings
export interface UserSettings extends Settings {
    hosts: PoolSettings[],
    user: string,
    password: string,
    database: string
}

export interface GlobalSettings extends Settings {
    port: string,
    connectionLimit: number
}

export interface PoolSettings extends Settings {
    id?: number,
    host: string,
    name?: string,
    user?: string,
    password?: string,
    database?: string
}
