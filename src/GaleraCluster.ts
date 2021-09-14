import { UserSettings } from "./types/SettingsInterfaces";
import { QueryOptions } from './types/PoolInterfaces'
import { Logger } from "./utils/Logger";
import globalSettings from "./configs/GlobalSettings";

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { format as MySQLFormat } from 'mysql2';
import { Pool } from "./pool/Pool";
import { Settings } from "./Settings";
import {ClusterAshync} from "./ClusterAshync";

export class GaleraCluster {
    private _pools: Pool[] = [];
    public get pools(): Pool[] {
        return this._pools;
    }
    private _poolIds: number[] =[];
    private _clusterAshync: ClusterAshync;
    private readonly errorRetryCount: number;

    constructor(userSettings: UserSettings) {
        this.errorRetryCount = userSettings.errorRetryCount ? userSettings.errorRetryCount : globalSettings.errorRetryCount;
        userSettings.hosts.forEach(host => {
            if (host.id) this._poolIds.push(host.id);
        })
        this._poolIds.sort((a, b) => a - b);

        userSettings.hosts.forEach(poolSettings => {
            poolSettings = Settings.mixPoolSettings(poolSettings, userSettings);

            if (!poolSettings.id) {
                poolSettings.id = this._poolIds.length <= 0 ? 0 : this._poolIds[this._poolIds.length - 1] + 1;
                this._poolIds.push(poolSettings.id);
            }

            this._pools.push(
                new Pool(poolSettings)
            )
        })

        this._clusterAshync = new ClusterAshync(this);

        Logger("configuration finished")
    }

    public connect(): Promise<void> {
        return new Promise(resolve => {
            Logger("connecting all pools")
            this._pools.forEach((pool) => {
                pool.connect((err) => {
                    if (err) Logger(err.message)
                    else {
                        this._clusterAshync.connect();
                        resolve();
                    }
                });
            })
        })
    }

    public disconnect() {
        Logger("disconnecting all pools")
        this._clusterAshync.stop();
        this._pools.forEach((pool) => {
            pool.disconnect();
        })
    }

    public async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, queryOptions?: QueryOptions): Promise<T> {
        let activePools: Pool[];
        try {
            activePools = await this.getActivePools();
            if (this.errorRetryCount > activePools.length) {
                Logger("Active pools less than error retry count");
            }
        } catch (e) {
            throw new Error(e);
        }

        if (queryOptions?.values) {
            const values = queryOptions.values;
            if (typeof values === 'object') {
                sql = sql.replace(/:(\w+)/g, (txt, key) => {
                    return values.hasOwnProperty(key) ? values[key] : txt
                })
            } else {
                sql = MySQLFormat(sql, values)
            }
        }

        Logger("Query use host: " + activePools[0].host)
        const retryCount = Math.min(this.errorRetryCount, activePools.length);
        for (let i = 0; i < retryCount; i++) {
            try {
                return await activePools[i].query(sql, queryOptions?.timeout, queryOptions?.database) as T;
            } catch (e) {
                Logger("Query error: " + e.message + ". Retrying query...");
            }
        }

        throw new Error("All pools have a error");

    }

    private async getActivePools() : Promise<Pool[]> {
        const activePools: Pool[] = this._pools.filter(pool => pool.status.isValid)
        activePools.sort((a, b) => a.status.loadScore - b.status.loadScore)

        if (activePools.length < 1) {
            throw new Error("There is no pool that satisfies the parameters")
        }

        return activePools;
    }
}
