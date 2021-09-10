import { Pool as MySQLPool } from "mysql2/typings/mysql"
import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { createPool } from "mysql2";
import { Logger } from "./Logger";
import { LoadFactor, PoolSettings, PoolStatus, Validator, GlobalStatusResult } from "./interfaces";
import globalSettings from "./config";
import { Utils } from "./Utils";
import { Timer } from "./Timer";

export class Pool {
    private readonly _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }

    private _isValid: boolean = false;
    public get isValid(): boolean {
        return this._isValid;
    }
    private _loadScore: number = 0;
    public get loadScore(): number {
        return this._loadScore;
    }

    public readonly id: string;
    public readonly host: string;
    public readonly connectionLimit: number;

    private readonly port: string;
    private readonly user: string;
    private readonly password: string;
    private readonly database: string;
    private readonly timerCheckRange: [number, number];
    private readonly timerCheckMultiplier: number;
    private readonly queryTimeout: number;

    private _timer: Timer;
    private _nextCheckTime: number = 10000;

    private _validators: Validator[];
    private _loadFactors: LoadFactor[];

    private _pool: MySQLPool;

    constructor(settings: PoolSettings) {
        this.host = settings.host;
        this.port = settings.port ? settings.port : globalSettings.port;
        this.id = settings.id ? settings.id.toString() : this.host + ":" + this.port
        Logger("configure pool in host " + this.host)

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;
        this.timerCheckRange = settings.timerCheckRange;
        this.timerCheckMultiplier = settings.timerCheckMultiplier;
        this.queryTimeout = settings.queryTimeout

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : globalSettings.connectionLimit;

        this._status = {
            active: false,
            synced: false,
            availableConnectionCount: this.connectionLimit,
            queryTime: 0
        }

        this._isValid = false;
        this._loadScore = 100000;

        this._validators = settings.validators;
        this._loadFactors = settings.loadFactors;

        this._timer = new Timer(this.checkStatus.bind(this))

        Logger("configuration pool finished in host: " + this.host)
    }

    public async connect(callback: () => void) {
        Logger("Creating pool in host: " + this.host)
        this._pool = createPool({
            connectionLimit: this.connectionLimit,
            host: this.host,
            user: this.user,
            password: this.password,
            database: this.database
        })

        this.status.active = true;
        await this.checkStatus();

        if (this._isValid) {
            callback();
        }
    }

    public disconnect() {
        Logger("closing pool in host: " + this.host)
        this._pool.end((error) => {
            if (error) {
                Logger(error.message)
            }
        });
        this.status.active = false;
        this.stopTimerCheck();

        Logger("Pool in host " + this.host + " closed");
    }

    private stopTimerCheck() {
        this._timer.dispose();
    }

    public async checkStatus() {
        try {
            if (!this.status.active) return;

            Logger("checking pool status in host: " + this.host);
            const timeBefore = new Date().getTime();

            const result = await this.query(`SHOW GLOBAL STATUS;`) as GlobalStatusResult[];

            const timeAfter = new Date().getTime();
            this.status.queryTime = Math.abs(timeAfter - timeBefore) / 1000;

            this.validatorsCheck(result);
            this.loadFactorsCheck(result);

            this.nextCheckStatus()
        } catch (err) {
            Logger("Error: Something wrong while checking status in host: " + this.host + ".\n Message: " + err.message);
            this.nextCheckStatus(true)
        }
    }

    private nextCheckStatus(downgrade: boolean = false) {
        if (downgrade) {
            this._nextCheckTime /= this.timerCheckMultiplier;
        } else {
            this._nextCheckTime *= this.timerCheckMultiplier;
        }
        this._nextCheckTime = Utils.clamp(this._nextCheckTime, this.timerCheckRange[0] * 1000, this.timerCheckRange[1] * 1000)

        this._timer.start(this._nextCheckTime);
    }

    private validatorsCheck(result: GlobalStatusResult[]): void {
        let validateCount: number = 0;
        this._validators.forEach(validator => {
            let value: string;
            switch (validator.key) {
                case 'available_connection_count':
                    value = this.status.availableConnectionCount.toString();
                    break;
                case 'query_time':
                    value = this.status.queryTime.toString();
                    break;
                case 'active':
                    value = this.status.active.toString();
                    break;
                default:
                    value = result.find(res => res.Variable_name === validator.key).Value;
            }

            if (Pool.checkValueIsValid(value, validator)) validateCount++;
        })

        this._isValid = validateCount === this._validators.length;
        Logger("Is status ok in host " + this.host + "? -> " + this._isValid.toString())
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
        Logger("Load score by checking status in host " + this.host + " is " + this._loadScore);
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

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, timeout: number = this.queryTimeout): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.status.availableConnectionCount--;
            this._pool.query({ sql, timeout }, (error, result: T) => {
                this.status.availableConnectionCount++;
                if (error) reject(error)
                resolve(result);
            })
        })
    }
}
