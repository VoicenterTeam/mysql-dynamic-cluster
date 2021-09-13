const prefix: string = '[mysql galera]'

export function Logger(...textArray: string[]) {
    console.log(prefix, ...textArray)
}
