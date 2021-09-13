import { Validator, LoadFactor } from './PoolInterfaces'

export interface Settings {
    connectionLimit?: number,
    port?: string,
    validators?: Validator[],
    loadFactors?: LoadFactor[],
    timerCheckRange?: [number, number] // time in seconds
    timerCheckMultiplier?: number,
    queryTimeout?: number, // time in ms
    errorRetryCount?: number
}

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
    user?: string,
    password?: string,
    database?: string
}
