/**
 * Created by Bohdan on Sep, 2021
 */

// Validator operator
type Operator = '>' | '<' | '=' | 'Like';
// Cluster events
export type ClusterEvent = 'connected' | 'disconnected';
// Database global status result
export type GlobalStatusResult = { Variable_name: string, Value: string }
// Values for mysql query
export type QueryValues = string | any[] | { [param: string]: any }

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
