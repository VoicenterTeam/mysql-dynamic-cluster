export interface mysqlGaleraHost {
    host: string,
    port: number,
    connectionLimit: number
}

export interface GaleraClusterOptions {
    canRetry: boolean,
    defaultSelector: string,
    restoreNodeTimeout: number,
    removeNodeErrorCount: number
}
