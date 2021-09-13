import { UserSettings } from "./types/SettingsInterfaces";
import { QueryOptions } from './types/PoolInterfaces'
import { Logger } from "./utils/Logger";
import globalSettings from "./configs/GlobalSettings";

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { format as MySQLFormat } from 'mysql2';
import { Pool } from "./pool/Pool";
import { Settings } from "./Settings";

export class GaleraCluster {
    private pools: Pool[] = [];
    private readonly errorRetryCount: number;

    constructor(userSettings: UserSettings) {
        this.errorRetryCount = userSettings.errorRetryCount ? userSettings.errorRetryCount : globalSettings.errorRetryCount;
        userSettings.hosts.forEach(poolSettings => {
            poolSettings = Settings.mixPoolSettings(poolSettings, userSettings)
            this.pools.push(
                new Pool(poolSettings)
            )
        })

        Logger("configuration finished")
    }

    public connect(): Promise<void> {
        return new Promise(resolve => {
            Logger("connecting all pools")
            this.pools.forEach((pool) => {
                pool.connect((err) => {
                    if (err) Logger(err.message)
                    else resolve()
                });
            })
        })
    }

    public disconnect() {
        Logger("disconnecting all pools")
        this.pools.forEach((pool) => {
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
                return await activePools[i].query(sql, queryOptions?.timeout) as T;
            } catch (e) {
                Logger("Query error: " + e.message + ". Retrying query...");
            }
        }

        throw new Error("All pools have a error");

    }

    private async getActivePools() : Promise<Pool[]> {
        const activePools: Pool[] = this.pools.filter(pool => pool.status.isValid)
        activePools.sort((a, b) => a.status.loadScore - b.status.loadScore)

        if (activePools.length < 1) {
            throw new Error("There is no pool that satisfies the parameters")
        }

        return activePools;
    }
}
