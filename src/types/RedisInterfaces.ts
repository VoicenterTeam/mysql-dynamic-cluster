import { BinaryToTextEncoding } from "crypto";

export interface RedisSettings {
    keyPrefix?: string,
    expire?: number,
    expiryMode?: string,
    algorithm?: string,
    encoding?: BinaryToTextEncoding,
    clearOnStart?: boolean
}

export interface DefaultRedisSettings extends RedisSettings {
    keyPrefix: string,
    expire: number,
    expiryMode: string,
    algorithm: string,
    encoding: BinaryToTextEncoding,
    clearOnStart: boolean
}
