import { MysqlGaleraHost, GaleraClusterOptions } from "./interfaces";
import {OkPacket, ResultSetHeader, RowDataPacket, QueryError, FieldPacket, Pool, Query} from "mysql2/typings/mysql";
import { Logger } from "./Logger"

import { createPool } from "mysql2";

export class GaleraCluster {
    private pools: Pool[] = []
    private galeraHosts: MysqlGaleraHost[] = []

    constructor(mysqlGaleraHosts: MysqlGaleraHost[], options?: GaleraClusterOptions ) {
        this.galeraHosts = mysqlGaleraHosts

        Logger("init configuration")
    }

    public connect(user: string, password: string, database: string) {
        this.galeraHosts.forEach((host) => {
            Logger("Creating pool in host: " + host.host)
            this.pools.push(
                createPool({
                    connectionLimit: host.connectionLimit,
                    host: host.host,
                    user,
                    password,
                    database
                })
            )
        })
    }

    public disconnect() {
        this.pools.forEach(pool => {
            pool.end()
        })
    }

    // private async connectPoolEvents(pool: Pool): Promise<void> {
    //
    // }

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, callback?: (error: QueryError, result: T, fields: FieldPacket) => void): Query {
        return this.pools[0].query(sql, callback);
    }
}
