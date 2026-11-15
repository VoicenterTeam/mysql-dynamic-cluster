export interface IRedisSettings {
    enabled: boolean,
    keyPrefix?: string,
    expire?: number,
    expiryMode?: 'EX',
    algorithm?: 'md5' | 'sha256',
    encoding?: 'base64' | 'hex',
    clearOnStart?: boolean
}

export interface IDefaultRedisSettings extends IRedisSettings {
    enabled: boolean
    keyPrefix: string,
    expire: number,
    expiryMode: 'EX',
    algorithm: 'md5' | 'sha256',
    encoding: 'base64' | 'hex',
    clearOnStart: boolean
}

export interface IRedisData {
    expired: number,
    data: any
}
