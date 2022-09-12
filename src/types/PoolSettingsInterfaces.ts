import { ILoadFactorParams, IValidatorParams } from "./PoolInterfaces";

export interface ITimerCheckRange {
    start: number,
    end: number
}

interface IPoolSettings {
    user?: string,
    password?: string,
    database?: string,
    port?: number,
    connectionLimit?: number,
    queryTimeout?: number,
    validators?: IValidatorParams[],
    loadFactors?: ILoadFactorParams[],
    timerCheckRange?: ITimerCheckRange, // Time in ms
    timerCheckMultiplier?: number,
    slowQueryTime?: number,
    redisFactor?: number
}

export interface IDefaultUserPoolSettings extends IPoolSettings {
    user: string,
    password: string,
    database: string
}

export interface IUserPoolSettings extends IPoolSettings {
    id?: number,
    name?: string,
    host: string,
    redisExpire?: number
}

export interface IDefaultPoolSettings extends IPoolSettings {
    port: number,
    queryTimeout: number,
    connectionLimit: number,
    validators: IValidatorParams[],
    loadFactors: ILoadFactorParams[],
    timerCheckRange: ITimerCheckRange, // Time in ms
    timerCheckMultiplier: number,
    slowQueryTime: number,
    redisFactor: number
}
