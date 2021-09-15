type Operator = '>' | '<' | '=' | 'Like';
export type GlobalStatusResult = { Variable_name: string, Value: string }
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
