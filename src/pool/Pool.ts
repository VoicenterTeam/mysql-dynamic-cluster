import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import mysql from "mysql2";
import { Logger } from "../utils/Logger";
import { PoolSettings } from "../types/SettingsInterfaces";
import globalSettings from "../configs/GlobalSettings";
import { PoolStatus } from './PoolStatus'

export class Pool {
    private readonly _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }

    public readonly id: number;
    public readonly host: string;
    public readonly connectionLimit: number;

    private readonly port: string;
    private readonly user: string;
    private readonly password: string;
    private readonly database: string;
    private readonly queryTimeout: number;

    private _pool: mysql.Pool;

    constructor(settings: PoolSettings) {
        this.host = settings.host;
        this.port = settings.port ? settings.port : globalSettings.port;
        this.id = settings.id;
        Logger("configure pool in host " + this.host);

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;
        this.queryTimeout = settings.queryTimeout;

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : globalSettings.connectionLimit;

        this._status = new PoolStatus(this, settings, false, this.connectionLimit, 10000);

        Logger("configuration pool finished in host: " + this.host);
    }

    public async connect(callback: (err: Error) => void) {
        Logger("Creating pool in host: " + this.host);
        this._pool = mysql.createPool({
            connectionLimit: this.connectionLimit,
            host: this.host,
            user: this.user,
            password: this.password,
            database: this.database
        })

        this.status.active = true;
        await this.status.checkStatus();

        if (this.status.isValid) {
            callback(null);
        } else {
            callback(new Error("pool in host " + this.host + " is not valid"));
        }
    }

    public disconnect() {
        Logger("closing pool in host: " + this.host);
        this._pool.end((error) => {
            if (error) {
                Logger(error.message);
            }
        });
        this.status.active = false;
        this.status.stopTimerCheck();

        Logger("pool in host " + this.host + " closed");
    }

    public async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, timeout: number = this.queryTimeout): Promise<T> {
        return new Promise((resolve, reject) => {
            this.status.availableConnectionCount--;

            this._pool.getConnection((err, conn) => {
                if (err) reject(err);

                conn?.query({ sql, timeout }, (error, result: T) => {
                    this.status.availableConnectionCount++;
                    conn.release();
                    if (error) reject(error);
                    resolve(result);
                });
            })
        })
    }
}
