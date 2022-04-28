import { ILoadFactorParams, IValidatorParams } from "./PoolInterfaces";

export interface ITimerCheckRange {
    start: number,
    end: number
}

interface IPoolSettings {
    port?: string,
    user?: string,
    password?: string,
    database?: string,
    queryTimeout?: number,
    connectionLimit?: number,
    errorRetryCount?: number,
    validators?: IValidatorParams[],
    loadFactors?: ILoadFactorParams[],
    timerCheckRange?: ITimerCheckRange, // Time in ms
    timerCheckMultiplier?: number,
    slowQueryTime?: number,
    useRedis?: boolean,
    redisFactor?: number,
    redisExpire?: number
}

export interface IGlobalUserPoolSettings extends IPoolSettings {
    user: string,
    password: string,
    database: string
}

export interface IUserPoolSettings extends IPoolSettings {
    id?: number,
    name?: string,
    host: string
}

export interface IDefaultPoolSettings extends IPoolSettings {
    port: string,
    queryTimeout: number,
    connectionLimit: number,
    errorRetryCount: number,
    validators: IValidatorParams[],
    loadFactors: ILoadFactorParams[],
    timerCheckRange: ITimerCheckRange, // Time in ms
    timerCheckMultiplier: number,
    slowQueryTime: number,
    useRedis: boolean,
    redisFactor: number
}
