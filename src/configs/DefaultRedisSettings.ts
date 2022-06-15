/**
 * Created by Bohdan on Apr, 2022
 */

import { IDefaultRedisSettings } from "../types/RedisInterfaces";

const DefaultRedisSettings: IDefaultRedisSettings = {
    keyPrefix: "mdc:",
    expire: 1_000_000,
    expiryMode: "EX",
    algorithm: "md5",
    encoding: "base64",
    clearOnStart: false
}

Object.freeze(DefaultRedisSettings);

export default DefaultRedisSettings;
