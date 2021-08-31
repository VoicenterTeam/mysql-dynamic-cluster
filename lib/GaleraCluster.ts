import { UserSettings, PoolSettings } from "./interfaces";
import { Logger } from "./Logger"

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import { Utils } from "./Utils";
import { Pool } from "./Pool";

export class GaleraCluster {
    private pools: Pool[] = []

    constructor(userSettings: UserSettings ) {
        userSettings.hosts.forEach(poolSettings => {
            poolSettings = GaleraCluster.mixPoolSettings(poolSettings, userSettings)

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
        return new Promise((resolve, reject) => {
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
