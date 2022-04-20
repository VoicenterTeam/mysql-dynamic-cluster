import { LoadFactorParams, ValidatorParams } from "./PoolInterfaces";

export interface ITimerCheckRange {
    start: number,
    end: number
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
    timerCheckMultiplier?: number,
    slowQueryTime?: number;
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
    timerCheckMultiplier: number,
    slowQueryTime: number
}
