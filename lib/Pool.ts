import { Pool as MySQLPool } from "mysql2/typings/mysql"
import { OkPacket, ResultSetHeader, RowDataPacket, QueryError } from "mysql2/typings/mysql";
import { createPool } from "mysql2";
import { Logger } from "./Logger";
import { PoolSettings, PoolStatus } from "./interfaces";
import globalSettings from "./config";

// TODO: create filtering
export class Pool {
    private _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }
    private set status(val: PoolStatus) {
        this._status = val;
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

    private _pool: MySQLPool;

    constructor(settings: PoolSettings) {
        this.host = settings.host;
        this.port = settings.port ? settings.port : globalSettings.port;
        this.id = settings.id ? settings.id.toString() : this.host + ":" + this.port
        Logger("configure pool in host " + this.host)

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : globalSettings.connectionLimit;

        this.status = {
            active: false,
            synced: false,
            availableConnectionCount: this.connectionLimit
        }

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

    public checkStatus() {
        Logger("checking pool status")
        this.isReady((error, result) => {
            if (error) {
                Logger("Error while checking ready status in host " + this.host  + " -> " + error.message)
                return
            }
            this.status.active = result;
        })
        this.isSynced((error, result) => {
            if (error) {
                Logger("Error while checking synced status in host " + this.host  + " -> " + error.message)
                return
            }
            this.status.synced = result;
        })
    }

    private isReady(callback: (error: QueryError | null, result: boolean) => void) {
        Logger("Checking if node is active")
        this.query(`SHOW GLOBAL STATUS LIKE 'wsrep_ready'`)
            .then(res => {
                Logger('Is pool in host ' + this.host + ' ready? -> ' + res[0].Value)
                callback(null, res[0].Value === 'ON')
            })
            .catch(error => {
                Logger(error.message)
                callback(error, false)
                return;
            })
    }

    private isSynced(callback: (error: QueryError | null, result: boolean) => void) {
        Logger("Checking if node is synced")
        this.query(`SHOW GLOBAL STATUS LIKE 'wsrep_local_state_comment';`)
            .then(res => {
                Logger('Is pool in host ' + this.host + ' synced? -> ' + res[0].Value)
                callback(null, res[0].Value === 'Synced')
            })
            .catch(error => {
                Logger(error.message)
                callback(error, false)
                return;
            })
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
