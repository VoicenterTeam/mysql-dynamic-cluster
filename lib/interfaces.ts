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
    loadFactors?: LoadFactor[]
}

export interface GlobalSettings {
    port: string,
    connectionLimit: number,
    retryCount: number,
    connectionTimeout: number,
    validators: Validator[],
    loadFactors: LoadFactor[]
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
    loadFactors?: LoadFactor[]
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
