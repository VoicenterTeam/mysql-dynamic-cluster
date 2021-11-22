/**
 * Created by Bohdan on Sep, 2021
 */

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";

// Validator operator
type Operator = '>' | '<' | '=' | 'Like';
// Cluster events
export type ClusterEvent = 'connected' | 'disconnected' | 'acquire' | 'connection' | 'release';
// Database global status result
export type GlobalStatusResult = { Variable_name: string, Value: string }
// Values for mysql query
export type QueryValues = string | any[] | { [param: string]: any }
// Result from mysql query
export type QueryResult = RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader;

export interface ValidatorParams {
    key: string,
    operator: Operator,
    value: string | number
}

export interface LoadFactorParams {
    key: string,
    multiplier: number
}

export interface QueryOptions {
    timeout?: number,
    database?: string,
    serviceId?: number,
    maxRetry?: number
}

export interface ServiceNodeMap {
    [param: string]: number
}
