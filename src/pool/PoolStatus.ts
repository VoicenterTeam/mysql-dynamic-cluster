import { GlobalStatusResult, LoadFactor, Validator } from "../types/PoolInterfaces";
import { PoolSettings } from "../types/SettingsInterfaces";
import { Logger } from "../utils/Logger";
import { MathUtils } from "../utils/MathUtils";
import { Timer } from "../utils/Timer";
import { Pool } from "./Pool";

export class PoolStatus {
    public active: boolean;
    public availableConnectionCount: number;
    public queryTime: number; // time in seconds

    private readonly _pool: Pool;
    private _isValid: boolean = false;
    public get isValid(): boolean {
        return this._isValid;
    }

    private _loadScore: number = 0;
    public get loadScore(): number {
        return this._loadScore;
    }

    private _validators: Validator[];
    private _loadFactors: LoadFactor[];

    private _timer: Timer;
    private _nextCheckTime: number = 10000;
    private readonly timerCheckRange: [number, number];
    private readonly timerCheckMultiplier: number;

    constructor(pool: Pool, settings: PoolSettings, active: boolean, availableConnectionCount: number, queryTime: number) {
        this._pool = pool;

        this.active = active;
        this.availableConnectionCount = availableConnectionCount;
        this.queryTime = queryTime;

        this._isValid = false;
        this._loadScore = 100000;

        this._validators = settings.validators;
        this._loadFactors = settings.loadFactors;

        this.timerCheckRange = settings.timerCheckRange;
        this.timerCheckMultiplier = settings.timerCheckMultiplier;
        this._timer = new Timer(this.checkStatus.bind(this))
    }

    public stopTimerCheck() {
        this._timer.dispose();
    }

    public async checkStatus() {
        try {
            if (!this.active) return;

            Logger("checking pool status in host: " + this._pool.host);
            const timeBefore = new Date().getTime();

            const result = await this._pool.query(`SHOW GLOBAL STATUS;`) as GlobalStatusResult[];

            const timeAfter = new Date().getTime();
            this.queryTime = Math.abs(timeAfter - timeBefore) / 1000;

            this.validatorsCheck(result);
            this.loadFactorsCheck(result);

            this.nextCheckStatus()
        } catch (err) {
            Logger("Error: Something wrong while checking status in host: " + this._pool.host + ".\n Message: " + err.message);
            this.nextCheckStatus(true)
        }
    }

    private nextCheckStatus(downgrade: boolean = false) {
        if (downgrade) {
            this._nextCheckTime /= this.timerCheckMultiplier;
        } else {
            this._nextCheckTime *= this.timerCheckMultiplier;
        }
        this._nextCheckTime = MathUtils.clamp(this._nextCheckTime, this.timerCheckRange[0] * 1000, this.timerCheckRange[1] * 1000)

        this._timer.start(this._nextCheckTime);
    }

    private validatorsCheck(result: GlobalStatusResult[]): void {
        let validateCount: number = 0;
        this._validators.forEach(validator => {
            let value: string;
            switch (validator.key) {
                case 'available_connection_count':
                    value = this.availableConnectionCount.toString();
                    break;
                case 'query_time':
                    value = this.queryTime.toString();
                    break;
                case 'active':
                    value = this.active.toString();
                    break;
                default:
                    value = result.find(res => res.Variable_name === validator.key).Value;
            }

            if (PoolStatus.checkValueIsValid(value, validator)) validateCount++;
        })

        this._isValid = validateCount === this._validators.length;
        Logger("Is status ok in host " + this._pool.host + "? -> " + this._isValid.toString())
    }

    private loadFactorsCheck(result: GlobalStatusResult[]) {
        let score = 0;
        this._loadFactors.forEach(loadFactor => {
            const value = result.find(res => res.Variable_name === loadFactor.key).Value;
            if (isNaN(+value) || !value) {
                Logger("Error: value from db isn't number. Check if you set right key. Current key: " + loadFactor.key)
            } else {
                score += +value * loadFactor.multiplier;
            }
        })

        this._loadScore = score;
        Logger("Load score by checking status in host " + this._pool.host + " is " + this._loadScore);
    }

    private static checkValueIsValid(value: string, validator: Validator): boolean {
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
