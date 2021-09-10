type Operator = '>' | '<' | '=' | 'Like';
export type GlobalStatusResult = { Variable_name: string, Value: string }

export interface UserSettings {
    hosts: PoolSettings[],
    user: string,
    password: string,
    database: string,
    connectionLimit?: number,
    port?: string,
    validators?: Validator[],
    loadFactors?: LoadFactor[],
    timerCheckRange?: [number, number] // time in seconds
    timerCheckMultiplier?: number,
    queryTimeout?: number,
    errorRetryCount: number
}

export interface GlobalSettings {
    port: string,
    connectionLimit: number,
    connectionTimeout: number,
    validators: Validator[],
    loadFactors: LoadFactor[],
    timerCheckRange: [number, number] // time in seconds
    timerCheckMultiplier: number,
    errorRetryCount: number,
    queryTimeout: number // time in ms
}

export interface PoolSettings {
    id?: number,
    host: string,
    port?: string,
    connectionLimit?: number,
    user?: string,
    password?: string,
    database?: string,
    validators?: Validator[],
    loadFactors?: LoadFactor[],
    timerCheckRange?: [number, number] // time in seconds
    timerCheckMultiplier?: number,
    queryTimeout?: number
}

export interface PoolStatus {
    active: boolean,
    synced: boolean,
    availableConnectionCount: number,
    queryTime: number // time in seconds
}

export interface Validator {
    key: string,
    operator: Operator,
    value: string | number
}

export interface LoadFactor {
    key: string,
    multiplier: number
}

export interface QueryOptions {
    values?: any | any[] | { [param: string]: any },
    timeout?: number
}
