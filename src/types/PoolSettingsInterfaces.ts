import { ILoadFactorParams, IValidatorParams } from "./PoolInterfaces";

export interface ITimerCheckRange {
    start: number,
    end: number
}

// The healthCheck block as an app writes it. Every key may be left out
export interface IHealthCheckSettings {
    // Time in ms between two checks of a node, counted from the end of the check before
    interval?: number,
    // Time in ms one check may take, the wait for a connection included. Left out: `interval`
    timeout?: number,
    // Failed checks in a row before a node goes down. An integer, 1 or more
    fall?: number,
    // Passed checks in a row before a node that is down comes back. An integer, 1 or more
    rise?: number,
    // Time in ms before the next check after one whose login or account the server refused
    authRetryInterval?: number,
    // Validated and kept. No rule of the check reads it yet
    passive?: boolean
}

// The healthCheck block of a node after Settings.mixSettings: every key is there
export interface IHealthCheck {
    interval: number,
    timeout: number,
    fall: number,
    rise: number,
    authRetryInterval: number,
    passive: boolean
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
    // Time in ms. A half left out comes from the defaults
    timerCheckRange?: Partial<ITimerCheckRange>,
    timerCheckMultiplier?: number,
    // A node that has this block is checked by its rules, and ignores the two keys above.
    // On a host after Settings.mixSettings it has every key
    healthCheck?: IHealthCheckSettings,
    slowQueryTime?: number,
    redisFactor?: number,
    minConnections?: number,
    idleTimeout?: number,
    idleCheckInterval?: number,
    // mysql2 connection flags, such as ['-CLIENT_QUERY_ATTRIBUTES']. Passed to mysql2 as they are
    flags?: string | string[]
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
    redisFactor: number,
    minConnections: number,
    idleTimeout: number,
    idleCheckInterval: number
}
