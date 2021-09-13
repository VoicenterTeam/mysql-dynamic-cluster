import { GlobalStatusResult, ValidatorParams } from "../types/PoolInterfaces";
import { Logger } from "../utils/Logger";
import { PoolStatus } from "./PoolStatus";

export class Validator {
    private readonly _poolStatus: PoolStatus;
    private _validators: ValidatorParams[];

    constructor(pool: PoolStatus, validators: ValidatorParams[]) {
        this._poolStatus = pool;
        this._validators = validators;
    }

    public check(result: GlobalStatusResult[]): boolean {
        let validateCount: number = 0;
        this._validators.forEach(validator => {
            let value: string;
            switch (validator.key) {
                case 'available_connection_count':
                    value = this._poolStatus.availableConnectionCount.toString();
                    break;
                case 'query_time':
                    value = this._poolStatus.queryTime.toString();
                    break;
                case 'active':
                    value = this._poolStatus.active.toString();
                    break;
                default:
                    value = result.find(res => res.Variable_name === validator.key).Value;
            }

            if (Validator.checkValueIsValid(value, validator)) validateCount++;
        })

        return validateCount === this._validators.length;
    }

    private static checkValueIsValid(value: string, validator: ValidatorParams): boolean {
        if (isNaN(+value)) {
            const val = value as string;
            const validatorVal = validator.value as string;

            if (validator.operator === '=') {
                if (val === validatorVal) {
                    return true;
                }
            } else if (validator.operator === 'Like') {
                if (val.indexOf(validatorVal) >= 0) {
                    return true;
                }
            } else {
                Logger('Error: Operator ' + validator.operator + ' doesn\'t support for another type except number')
            }
        } else {
            const val = +value as number;
            const validatorVal = +validator.value as number;

            if (isNaN(validatorVal)) {
                Logger('Error: validator value isn\'t a type number like value from database. Check if you write correct data');
                return false;
            }

            switch (validator.operator) {
                case "<":
                    if (val < validatorVal) return true;
                    break;
                case "=":
                    if (val === validatorVal) return true;
                    break;
                case ">":
                    if (val > validatorVal) return true;
                    break;
            }
        }

        return false;
    }
}
