type Operator = '>' | '<' | '=' | 'Like';
export type GlobalStatusResult = { Variable_name: string, Value: string }

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
    values?: any[] | { [param: string]: any },
    timeout?: number,
    database?: string
}
