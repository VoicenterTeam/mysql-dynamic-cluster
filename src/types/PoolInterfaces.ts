/**
 * Created by Bohdan on Sep, 2021
 */

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";

// Validator operator
type Operator = '>' | '<' | '=' | 'Like';
// Cluster events
export type ClusterEvent = 'connected' |
                            'disconnected' |
                            'acquire' |
                            'connection' |
                            'release' |
                            'pool_connected' |
                            'pool_disconnected' |
                            'hashing_created';

// Database global status result
export type GlobalStatusResult = { Variable_name: string, Value: string }
// Values for mysql query
export type QueryValues = string | any[] | { [param: string]: any }
// Result from mysql query
export type QueryResult = RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader;

export interface IValidatorParams {
    key: string,
    operator: Operator,
    value: string | number
}

export interface ILoadFactorParams {
    key: string,
    multiplier: number
}

export interface IQueryOptions {
    timeout?: number,
    database?: string,
    serviceName?: string,
    serviceId?: number,
    maxRetry?: number,
    redis?: boolean,
    redisFactor?: number,
    redisExpire?: number
}

export interface IServiceNodeMap {
    [param: string]: number
}
