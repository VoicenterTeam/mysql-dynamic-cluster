import { UserSettings } from "./interfaces";
import { Logger } from "./Logger"

import { OkPacket, ResultSetHeader, RowDataPacket } from "mysql2/typings/mysql";
import {Utils} from "./Utils";
import {Pool} from "./Pool";

export class GaleraCluster {
    private pools: Pool[] = []

    constructor(userSettings?: UserSettings ) {
        userSettings.hosts.forEach(poolSettings => {
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

            this.pools.push(
                new Pool(poolSettings)
            )
        })

        Logger("configuration finished")
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
                const activePools: Pool[] = this.pools.filter(pool => pool.status.active)
                const bestPool: Pool = activePools[Utils.getRandomIntInRange(0, activePools.length - 1)]

                if (!bestPool) {
                    reject({ message: "There is no pool that satisfies the parameters" })
                }

                bestPool.query(sql, values, (error, result: T) => {
                    if (error) {
                        reject(error)
                    }

                    resolve(result);
                });
            } catch (e) {
                reject(e)
            }
        })
    }
}
