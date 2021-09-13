type Operator = '>' | '<' | '=' | 'Like';
export type GlobalStatusResult = { Variable_name: string, Value: string }

export interface Validator {
    key: string,
    operator: Operator,
    value: string | number
}

export interface LoadFactor {
    key: string,
    multiplier: number
}

export interface QueryOptions {
    values?: any[] | { [param: string]: any },
    timeout?: number
}
