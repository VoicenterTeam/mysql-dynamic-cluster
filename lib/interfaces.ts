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
    port?: string
}

export interface PoolStatus {
    active: boolean
}
