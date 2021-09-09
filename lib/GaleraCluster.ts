import { UserSettings, PoolSettings, QueryOptions } from "./interfaces";
import { Logger } from "./Logger";
import globalSettings from "./config";

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { Pool } from "./Pool";

export class GaleraCluster {
    private pools: Pool[] = []

    constructor(userSettings: UserSettings) {
        userSettings.hosts.forEach(poolSettings => {
            poolSettings = GaleraCluster.mixPoolSettings(poolSettings, userSettings)

            // #TODO: connect to Pool mixed userSettings with globalSettings for validators and loadFactors
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

    public connect() {
        Logger("connecting all pools")
        this.pools.forEach((pool) => {
            pool.connect();
        })
    }

    public disconnect() {
        Logger("disconnecting all pools")
        this.pools.forEach((pool) => {
            pool.disconnect();
        })
    }

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, queryOptions?: QueryOptions): Promise<T> {
        return new Promise<T>(async (resolve, reject) => {
            try {
                const activePools = await this.getActivePools();
                activePools[0].query(sql, queryOptions?.values, queryOptions?.timeout)
                    .then(res => resolve(res as T))
                    .catch(err => reject(err))
            } catch (e) {
                reject(e)
            }
        })
    }

    private getActivePools() : Promise<Pool[]> {
        return new Promise<Pool[]>((resolve, reject) => {
            const activePools: Pool[] = this.pools.filter(pool => pool.isValid)
            activePools.sort((a, b) => a.loadScore - b.loadScore)

            if (activePools.length < 1) {
                reject({ message: "There is no pool that satisfies the parameters" })
            }

            resolve(activePools);
        })
    }
}
