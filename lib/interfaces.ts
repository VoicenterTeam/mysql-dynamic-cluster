export interface GaleraHostSettings {
    id?: number,
    host: string,
    port?: string,
    connectionLimit?: number,
    user?: string,
    password?: string,
    database?: string,
}

export interface UserSettings {
    hosts: GaleraHostSettings[],
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

export interface HostStatus {
    active: boolean
}
