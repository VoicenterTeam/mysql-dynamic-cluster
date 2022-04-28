import { BinaryToTextEncoding } from "crypto";

export interface IRedisSettings {
    keyPrefix?: string,
    expire?: number,
    expiryMode?: string,
    algorithm?: string,
    encoding?: BinaryToTextEncoding,
    clearOnStart?: boolean
}

export interface IDefaultRedisSettings extends IRedisSettings {
    keyPrefix: string,
    expire: number,
    expiryMode: string,
    algorithm: string,
    encoding: BinaryToTextEncoding,
    clearOnStart: boolean
}
