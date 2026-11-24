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
    // Send the statement with mysql2's execute(): prepared once per connection, the values
    // bound by the server and never written into the text. Values must be an array. No Redis
    execute?: boolean,
    // Try the next node after a node answered 1047, not ready. Default true. False for a
    // statement that can do part of its work before the 1047, such as a procedure that commits
    // on its way
    retryNotReady?: boolean,
    // Ends the call when it aborts: the call rejects with the reason of the signal as it is,
    // and no other node is tried. A connection the call holds then is destroyed
    signal?: AbortSignal,
    // Called once when a call that asked a node settles, before its promise does: where its
    // last attempt ended and how long it waited for connections. Not called for a Redis hit or
    // a call refused before any node. A throw in it, and the rejection of a promise it returns,
    // is logged and changes nothing
    onTiming?: (timing: IQueryTiming) => void,
    // Called synchronously as an attempt of a call enters a step, with the step and the node of
    // the attempt: 'queue' as it asks its pool for a connection, 'probe', 'prepare', and
    // 'statement' once the statement was handed to the connection, so it counts as sent. Only
    // when the step or the node differs from the last call. Not called for a Redis hit, a call
    // refused before any node, or after the call settled. A throw in it, and the rejection of a
    // promise it returns, is logged once per call and changes nothing
    onStep?: (step: QueryStep, nodeId: number) => void
}

// Where an attempt of a query ended: waiting for a connection of the pool, in mysql2's queue
// or while a new connection opened (queue), the ping of an idle connection (probe), the reset,
// USE or DO 0 before the statement (prepare), or after the statement was sent (statement)
export type QueryStep = 'queue' | 'probe' | 'prepare' | 'statement';

// What the onTiming option of a query gets
export interface IQueryTiming {
    // the step the last attempt ended in, also 'statement' for a call that resolved
    step: QueryStep,
    // time the call waited for a connection, summed over every node it tried. In milliseconds,
    // with a fraction: it comes from a monotonic clock
    queuedMs: number,
    // the node of the last attempt
    nodeId: number
}

// How far one Pool.query() call got. The caller hands in an empty object and the pool fills
// it, so the caller knows also for an error that cannot take a property: a frozen one, or one
// the app handed failWaiting(), which many queries can share. `aborted` as for getConnection()
export interface IQueryOutcome extends IAbortOutcome {
    // False from the start of the call, true once the statement was handed to the connection:
    // from then on it may run on the server, whatever the call ends with. It stays false when
    // no connection came or the change of database failed. Not set by a pool that tells nothing
    sent?: boolean
}

// Where one Pool.query() call is, for the onTiming and onStep options of the query. The caller
// hands in an empty object, and the borrow and then the pool fill it
export interface IAttemptTiming {
    // the step the call is in, and so the one it ended in once it settled
    step?: QueryStep,
    // time in ms the call waited for mysql2 to hand it a connection, over every request
    queuedMs?: number,
    // set by the cluster for a query with onStep only: the pool and the borrow call it as the
    // call enters a step. It never throws
    enter?: (step: QueryStep) => void
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
