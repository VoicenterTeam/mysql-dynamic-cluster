/**
 * Created by Bohdan on Sep, 2021
 */

const prefix: string = '[mysql galera]'

export function Logger(...array: any[]) {
    console.log(prefix, ...array)
}
