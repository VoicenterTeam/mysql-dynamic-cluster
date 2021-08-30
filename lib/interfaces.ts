export interface PoolSettings {
    id?: number,
    host: string,
    port?: string,
    connectionLimit?: number,
    user?: string,
    password?: string,
    database?: string,
}

export interface UserSettings {
    hosts: PoolSettings[],
    user: string,
    password: string,
    database: string,
    connectionLimit?: number,
    port?: string,

    canRetry?: boolean,
    defaultSelector?: string,
    restoreNodeTimeout?: number,
    removeNodeErrorCount?: number
}

export interface PoolStatus {
    active: boolean
}
