/**
 * Created by Bohdan on Sep, 2021
 */

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2";
import { INodeCheckError } from "./NodeInterfaces";

// Validator operator
type Operator = '>' | '<' | '=' | 'Like';
// Cluster events
export type ClusterEvent = 'connected' |
                            'disconnected' |
                            'hashing_created' |
                            'acquire' |
                            'connection' |
                            'release' |
                            'pool_connected' |
                            'pool_disconnected' |
                            'pool_check_failed';

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
    redisExpire?: number,
    redisRefreshCache?: boolean,
    // escape the values of an object of values, for this query. Default: the escapeNamedValues setting
    escapeNamedValues?: boolean,
    // Try the next node after a node answered 1047, not ready. Default true. False for a
    // statement that can do part of its work before the 1047, such as a procedure that commits
    // on its way
    retryNotReady?: boolean,
    // Ends the call when it aborts: the call rejects with the reason of the signal as it is,
    // and no other node is tried. A connection the call holds then is destroyed
    signal?: AbortSignal
}

// How far one Pool.query() call got. The caller hands in an empty object and the pool fills
// it, so the caller knows also for an error that cannot take a property: a frozen one, or one
// the app handed failWaiting(), which many queries can share
export interface IQueryOutcome {
    // False from the start of the call, true once the statement was handed to the connection:
    // from then on it may run on the server, whatever the call ends with. It stays false when
    // no connection came or the change of database failed. Not set by a pool that tells nothing
    sent?: boolean,
    // true when the call was rejected because its signal aborted. Not set in any other case
    aborted?: boolean
}

// How the health check of one connect() ended. The caller of Pool.connect() hands in an empty
// object and the pool fills it, so the caller knows about that check and no other
export interface ICheckOutcome {
    // False from the start of connect(), true once its check was recorded: the check ended while
    // the pool was still running, with an answer or with an error. It stays false when the check
    // was dropped because the pool was stopped, and when no check ran. Not set by a pool that
    // tells nothing
    recorded?: boolean,
    // what a recorded check failed with, reduced. Not set when it got its answer
    checkError?: INodeCheckError
}

// How a Pool.getConnection() call with a signal ended. The caller hands in an empty object and
// the pool fills it, so the caller can tell the reason of an abort from an error of the node
export interface IAbortOutcome {
    // true when the call was rejected because its signal aborted. Not set in any other case
    aborted?: boolean
}

export interface IServiceNodeMap {
    ServiceID: number,
    NodeID: number
}
