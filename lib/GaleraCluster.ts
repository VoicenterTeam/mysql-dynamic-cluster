import { PoolSettings, QueryOptions, UserSettings } from "./interfaces";
import { Logger } from "./Logger";
import globalSettings from "./config";

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { format as MySQLFormat } from 'mysql2';
import { Pool } from "./Pool";

export class GaleraCluster {
    private pools: Pool[] = []
    private errorRetryCount: number;

    constructor(userSettings: UserSettings) {
        userSettings.hosts.forEach(poolSettings => {
            poolSettings = GaleraCluster.mixPoolSettings(poolSettings, userSettings)

            this.errorRetryCount = userSettings.errorRetryCount ? userSettings.errorRetryCount : globalSettings.errorRetryCount;

            this.pools.push(
                new Pool(poolSettings)
            )
        })

        Logger("configuration finished")
    }

    private static mixPoolSettings(poolSettings: PoolSettings, userSettings: UserSettings) : PoolSettings {
        poolSettings = {
            user: userSettings.user,
            password: userSettings.password,
            database: userSettings.database,
            ...poolSettings
        }

        if (!poolSettings.connectionLimit && userSettings.connectionLimit) {
            poolSettings.connectionLimit = userSettings.connectionLimit
        }

        if (!poolSettings.port && userSettings.port) {
            poolSettings.port = userSettings.port
        }

        if (!poolSettings.validators && userSettings.validators) {
            poolSettings.validators = userSettings.validators
        } else if (!poolSettings.validators && !userSettings.validators) {
            poolSettings.validators = globalSettings.validators
        }

        if (!poolSettings.loadFactors && userSettings.loadFactors) {
            poolSettings.loadFactors = userSettings.loadFactors
        } else if (!poolSettings.loadFactors && !userSettings.loadFactors) {
            poolSettings.loadFactors = globalSettings.loadFactors
        }

        if (!poolSettings.timerCheckRange && userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = userSettings.timerCheckRange
        } else if (!poolSettings.timerCheckRange && !userSettings.timerCheckRange) {
            poolSettings.timerCheckRange = globalSettings.timerCheckRange
        }

        if (!poolSettings.timerCheckMultiplier && userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = userSettings.timerCheckMultiplier
        } else if (!poolSettings.timerCheckMultiplier && !userSettings.timerCheckMultiplier) {
            poolSettings.timerCheckMultiplier = globalSettings.timerCheckMultiplier
        }

        if (!poolSettings.queryTimeout && userSettings.queryTimeout) {
            poolSettings.queryTimeout = userSettings.queryTimeout
            console.log("Get timeout from user settings. Value: " + poolSettings.queryTimeout);
        } else if (!poolSettings.queryTimeout && !userSettings.queryTimeout) {
            poolSettings.queryTimeout = globalSettings.queryTimeout
        }

        return poolSettings;
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
        const activePools: Pool[] = this.pools.filter(pool => pool.isValid)
        activePools.sort((a, b) => a.loadScore - b.loadScore)

        if (activePools.length < 1) {
            throw new Error("There is no pool that satisfies the parameters")
        }

        return activePools;
    }
}
