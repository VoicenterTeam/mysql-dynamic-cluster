import { mysqlGaleraHost, GaleraClusterOptions } from "./interfaces";
import { OkPacket, ResultSetHeader, RowDataPacket, QueryError, FieldPacket, Pool } from "mysql2/typings/mysql";
import { Logger } from "./Logger"

import { createPool } from "mysql2";

export class GaleraCluster {
    private connections: Pool[] = []
    private galeraHosts: mysqlGaleraHost[] = []

    constructor(mysqlGaleraHosts: mysqlGaleraHost[], options?: GaleraClusterOptions ) {
        this.galeraHosts = mysqlGaleraHosts

        Logger("init configuration")
    }

    public connect(user: string, password: string, database: string) {
        this.galeraHosts.forEach((host) => {
            Logger("Creating pool in host: " + host.host)
            this.connections.push(
                createPool({
                    connectionLimit: host.connectionLimit,
                    host: host.host,
                    user: user,
                    password: password,
                    database: database
                })
            )
        })
    }

    // private async connectPoolEvents(pool: Pool): Promise<void> {
    //
    // }

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, callback?: (error: QueryError, result: T, fields: FieldPacket) => void) {
        this.connections[0].query(sql, callback)
    }
}
