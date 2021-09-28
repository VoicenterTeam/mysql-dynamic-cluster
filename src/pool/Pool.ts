/**
 * Created by Bohdan on Sep, 2021
 */

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import mysql from "mysql2";
import Logger from "../utils/Logger";
import { PoolSettings } from "../types/SettingsInterfaces";
import defaultSettings from "../configs/DefaultSettings";
import { PoolStatus } from './PoolStatus'
import Metrics from "../metrics/Metrics";
import MetricNames from "../metrics/MetricNames";

// AKA galera node
export class Pool {
    private readonly _status: PoolStatus;
    public get status(): PoolStatus {
        return this._status;
    }

    public readonly id: number;
    public readonly name: string;
    public readonly host: string;
    public readonly port: string;
    // max connection count in pool
    public readonly connectionLimit: number;

    private readonly user: string;
    private readonly password: string;
    private readonly database: string;
    private readonly queryTimeout: number;

    private _pool: mysql.Pool;

    /**
     * @param settings pool settings
     */
    constructor(settings: PoolSettings) {
        this.id = settings.id;
        this.host = settings.host;
        this.port = settings.port ? settings.port : defaultSettings.port;
        this.name = settings.name ? settings.name : `${this.host}:${this.port}`
        Logger.debug("configure pool in host " + this.host);

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;
        this.queryTimeout = settings.queryTimeout;

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : defaultSettings.connectionLimit;

        this._status = new PoolStatus(this, settings, false, this.connectionLimit, 10000);

        Logger.info("configuration pool finished in host: " + this.host);
    }

    /** create pool connection
     * @param callback error callback
     */
    public async connect(callback: (err: Error) => void) {
        Logger.debug("Creating pool in host: " + this.host);
        this._pool = mysql.createPool({
            connectionLimit: this.connectionLimit,
            host: this.host,
            user: this.user,
            password: this.password,
            database: this.database
        })

        this.status.active = true;
        Metrics.activateMetrics(MetricNames.pools);
        await this.status.checkStatus();

        if (this.status.isValid) {
            callback(null);
        } else {
            callback(new Error("pool in host " + this.host + " is not valid"));
        }
    }

    /**
     * close pool connection
     */
    public disconnect() {
        Logger.debug("closing pool in host: " + this.host);
        this._pool.end((error) => {
            if (error) {
                Logger.error(error.message);
            }
        });
        this.status.active = false;
        this.status.stopTimerCheck();

        Logger.info("pool in host " + this.host + " closed");
    }

    /**
     * @param sql mysql query
     * @param timeout query timeout
     * @param database change database for this query
     */
    public async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, timeout: number = this.queryTimeout, database: string = this.database): Promise<T> {
        return new Promise((resolve, reject) => {
            this.status.availableConnectionCount--;
            Metrics.inc(MetricNames.pools.allQueries);
            Metrics.mark(MetricNames.pools.queryPerSecond);

            this._pool.getConnection((err, conn) => {
                if (err) {
                    Metrics.inc(MetricNames.pools.errorQueries);
                    reject(err);
                }

                conn?.changeUser({ database }, (error) => {
                    if (error) {
                        Metrics.inc(MetricNames.pools.errorQueries);
                        reject(error)
                    }
                })
                conn?.query({ sql, timeout }, (error, result: T) => {
                    this.status.availableConnectionCount++;
                    conn.release();
                    if (error) {
                        Metrics.inc(MetricNames.pools.errorQueries);
                        reject(error);
                    }
                    Metrics.inc(MetricNames.pools.successfulQueries);
                    resolve(result);
                });
            })
        })
    }
}
