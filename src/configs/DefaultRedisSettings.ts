/**
 * Created by Bohdan on Apr, 2022
 */

import { IDefaultRedisSettings } from "../types/RedisInterfaces";

const DefaultRedisSettings: IDefaultRedisSettings = {
    algorithm: "md5",
    encoding: "base64",
    keyPrefix: "mdc:",
    expiryMode: "EX",
    expire: 1_000_000,
    clearOnStart: false
}

Object.freeze(DefaultRedisSettings);

export default DefaultRedisSettings;
