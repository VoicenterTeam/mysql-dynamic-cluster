import { Pool as MySQLPool } from "mysql2/typings/mysql"
import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { createPool } from "mysql2";
import { Logger } from "./Logger";
import { LoadFactor, PoolSettings, PoolStatus, Validator } from "./interfaces";
import globalSettings from "./config";

export class Pool {
    private readonly _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }

    private _isValid: boolean = false;
    public get isValid() {
        return this._isValid;
    }
    private _loadScore: number = 0;
    public get loadScore() {
        return this._loadScore;
    }

    public readonly id: string;
    public readonly host: string;
    public readonly connectionLimit: number;

    private readonly port: string;
    private readonly user: string;
    private readonly password: string;
    private readonly database: string;

    private _timer: NodeJS.Timer;
    private _nextCheckTime: number = 10000;

    private _validators: Validator[];
    private _loadFactors: LoadFactor[];

    private _pool: MySQLPool;

    constructor(settings: PoolSettings, validators?: Validator[], loadFactors?: LoadFactor[]) {
        this.host = settings.host;
        this.port = settings.port ? settings.port : globalSettings.port;
        this.id = settings.id ? settings.id.toString() : this.host + ":" + this.port
        Logger("configure pool in host " + this.host)

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : globalSettings.connectionLimit;

        this._status = {
            active: false,
            synced: false,
            availableConnectionCount: this.connectionLimit
        }

        this._isValid = false;
        this._loadScore = 0;

        this._validators = validators ? validators : globalSettings.validators;
        this._loadFactors = loadFactors ? loadFactors : globalSettings.loadFactors;

        Logger("configuration pool finished in host: " + this.host)
    }

    public connect() {
        Logger("Creating pool in host: " + this.host)
        this._pool = createPool({
            connectionLimit: this.connectionLimit,
            host: this.host,
            user: this.user,
            password: this.password,
            database: this.database
        })

        this.status.active = true;
        this.startTimerCheck();
    }

    public disconnect() {
        Logger("closing pool in host: " + this.host)
        this._pool.end((error) => {
            if (error) {
                Logger(error.message)
            }
        });
        this.stopTimerCheck();
    }

    private startTimerCheck() {
        this._timer = setInterval(this.checkStatus.bind(this), this._nextCheckTime)
        this.checkStatus()
    }

    private stopTimerCheck() {
        clearInterval(this._timer)
    }

    public async checkStatus() {
        try {
            Logger("checking pool status")

            const result = await this.query(`SHOW GLOBAL STATUS;`) as { Variable_name: string, Value: string }[];

            let validateCount: number = 0;
            this._validators.forEach(validator => {
                const value = result.find(res => res.Variable_name === validator.key).Value;
                if (Pool.checkValueIsValid(value, validator)) validateCount++;
            })

            this._isValid = validateCount === this._validators.length;
        } catch (err) {
            Logger("Something wrong while checking status in pool in host: " + this.host + ".\n Message: " + err.message);
        }
    }

    private static checkValueIsValid(value: string, validator: Validator): boolean {
        if (isNaN(+value)) {
            const val = value as string;
            const validatorVal = validator.value as string;

            if (validator.operator === '=') {
                if (val === validatorVal) {
                    return true;
                }
            } else {
                Logger('Error: Operator ' + validator.operator + ' doesn\'t support for another type except number')
            }
        } else {
            const val = +value;
            const validatorVal = +validator.value;

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

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[] | { [param: string]: any }): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.status.availableConnectionCount--;
            if (values) {
                this._pool.query(sql, values, (error, result: T) => {
                    this.status.availableConnectionCount++;
                    if (error) reject(error)
                    resolve(result);
                })
            } else {
                return this._pool.query(sql, (error, result: T) => {
                    this.status.availableConnectionCount++;
                    if (error) reject(error)
                    resolve(result);
                })
            }
        })
    }
}
