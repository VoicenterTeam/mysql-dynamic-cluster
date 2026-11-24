/**
 * Created by Bohdan on Sep, 2021
 */

import { GlobalStatusResult, IValidatorParams } from "../types/PoolInterfaces";
import Logger from "../utils/Logger";
import { ILogger } from "../types/LoggerInterfaces";
import { PoolStatus } from "./PoolStatus";

/**
 * Pool validator to check if pool can handle queries by validator params
 */
export class Validator {
    private readonly _poolStatus: PoolStatus;
    private _validators: IValidatorParams[];
    // the logger of the cluster of the pool (#86)
    private readonly _logger: ILogger;

    /**
     * @param pool pool what check by validators
     * @param validators validators params by which to check possibility handle queries
     * @param logger the logger of the cluster. Left out: the module logger
     */
    constructor(pool: PoolStatus, validators: IValidatorParams[], logger: ILogger = Logger) {
        this._poolStatus = pool;
        this._validators = validators;
        this._logger = logger;
    }

    /**
     * Check pool by validators from result of db global status
     * @param result result of db global status
     */
    public check(result: GlobalStatusResult[]): boolean {
        let validateCount: number = 0;
        this._validators.forEach(validator => {
            let value: string;
            switch (validator.key) {
                // custom validators keys
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
                    value = result.find(res => res.Variable_name === validator.key)?.Value;
            }

            if (value === undefined) {
                this._logger.error("Validator key " + validator.key + " isn't in the global status, validator fails");
                return;
            }
            if (Validator.checkValueIsValid(value, validator, this._logger)) validateCount++;
        })

        return validateCount === this._validators.length;
    }

    /**
     * Check if value from db is valid with value from validator parameters
     * @param value value from result of db global status
     * @param validator validator parameters to check value
     * @param logger the logger of the cluster of the pool
     * @private
     */
    private static checkValueIsValid(
        value: string, validator: IValidatorParams, logger: ILogger
    ): boolean {
        if (isNaN(+value)) {
            // check values if value from db is string
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
                logger.error('Operator ' + validator.operator + ' doesn\'t support for another type except number')
            }
        } else {
            // check values if value from db is number
            const val = +value as number;
            const validatorVal = +validator.value as number;

            if (isNaN(validatorVal)) {
                logger.error('Validator value isn\'t a type number like value from database. Check if you write correct data');
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
