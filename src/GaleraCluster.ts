import { UserSettings } from "./types/SettingsInterfaces";
import {QueryOptions, QueryValues} from './types/PoolInterfaces'
import { Logger } from "./utils/Logger";
import globalSettings from "./configs/GlobalSettings";

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { format as MySQLFormat } from 'mysql2';
import { Pool } from "./pool/Pool";
import { Settings } from "./Settings";
import {ClusterHashing} from "./ClusterHashing";

export class GaleraCluster {
    private _pools: Pool[] = [];
    public get pools(): Pool[] {
        return this._pools;
    }
    private _poolIds: number[] =[];
    private _clusterHashing: ClusterHashing;
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

        this._clusterHashing = new ClusterHashing(this);

        Logger("configuration finished")
    }

    public connect(): Promise<void> {
        return new Promise(resolve => {
            Logger("connecting all pools")
            this._pools.forEach((pool) => {
                pool.connect((err) => {
                    if (err) Logger(err.message)
                    else {
                        this._clusterHashing.connect();
                        resolve();
                    }
                });
            })
        })
    }

    public disconnect() {
        Logger("disconnecting all pools")
        this._clusterHashing.stop();
        this._pools.forEach((pool) => {
            pool.disconnect();
        })
    }

    public async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: QueryValues, queryOptions?: QueryOptions): Promise<T> {
        let activePools: Pool[];
        try {
            activePools = await this.getActivePools();
            // #TODO: use max retry - QueryOption value
            if (this.errorRetryCount > activePools.length) {
                Logger("Active pools less than error retry count");
            }
        } catch (e) {
            throw new Error(e);
        }

        if (values) {
            if (Array.isArray(values)) {
                sql = MySQLFormat(sql, values);
            } else if (typeof values === 'string') {
                sql = MySQLFormat(sql, [values]);
            } else {
                sql = sql.replace(/:(\w+)/g, (txt, key) => {
                    return values.hasOwnProperty(key) ? values[key] : txt
                })
            }
        }


        Logger("Query use host: " + activePools[0].host);
        const retryCount = Math.min(this.errorRetryCount, activePools.length);
        for (let i = 0; i < retryCount; i++) {
            try {
                const result = await activePools[i].query(sql, queryOptions?.timeout, queryOptions?.database) as T;
                if (queryOptions?.serviceId) {
                    this._clusterHashing.updateServiceForNode(queryOptions.serviceId, activePools[i].id);
                }
                return result;
            } catch (e) {
                if (queryOptions?.serviceId) {
                    this._clusterHashing.updateServiceForNode(queryOptions.serviceId, activePools[i].id);
                }
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
