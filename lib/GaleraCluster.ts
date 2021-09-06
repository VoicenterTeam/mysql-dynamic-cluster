import { UserSettings, PoolSettings } from "./interfaces";
import { Logger } from "./Logger";
import globalSettings from "./config";

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { Utils } from "./Utils";
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

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[] | { [param: string]: any }): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            try {
                this.getBestPool()
                    .catch(error => {
                        reject(error)
                    })
                    .then(bestPool => {
                        bestPool = bestPool as Pool;
                        bestPool?.query(sql, values)
                            .then(res => resolve(res as T))
                            .catch(err => {
                                Logger("QUERY: retry query after error. Error message: " + err.message);

                                this.query(sql, values)
                                    .catch(error => reject(error))
                                    .then(result => resolve(result as T))
                            })
                    })

            } catch (e) {
                reject(e)
            }
        })
    }

    private getBestPool() : Promise<Pool> {
        return new Promise<Pool>((resolve, reject) => {
            const activePools: Pool[] = this.pools.filter(pool => pool.status.active)
            const bestPool: Pool = activePools[Utils.getRandomIntInRange(0, activePools.length - 1)]

            if (!bestPool) {
                reject({ message: "There is no pool that satisfies the parameters" })
            }

            resolve(bestPool);
        })
    }
}
