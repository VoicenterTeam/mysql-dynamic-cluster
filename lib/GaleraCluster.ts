import { UserSettings } from "./interfaces";
import { Logger } from "./Logger"

import {Host} from "./Host";
import {FieldPacket, OkPacket, Query, QueryError, ResultSetHeader, RowDataPacket} from "mysql2/typings/mysql";
import {Utils} from "./Utils";

export class GaleraCluster {
    private galeraHosts: Host[] = []

    constructor(userSettings?: UserSettings ) {
        userSettings.hosts.forEach(hostSettings => {
            hostSettings = {
                user: userSettings.user,
                password: userSettings.password,
                database: userSettings.database,
                ...hostSettings
            }

            if (!hostSettings.connectionLimit && userSettings.connectionLimit) {
                hostSettings.connectionLimit = userSettings.connectionLimit
            }

            if (!hostSettings.port && userSettings.port) {
                hostSettings.port = userSettings.port
            }

            this.galeraHosts.push(
                new Host(hostSettings)
            )
        })

        Logger("configuration finished")
    }

    public connect() {
        Logger("connecting all hosts")
        this.galeraHosts.forEach((host) => {
            host.connect();
        })
    }

    public disconnect() {
        Logger("disconnecting all hosts")
        this.galeraHosts.forEach((host) => {
            host.disconnect();
        })
    }

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query {
        const activeHosts: Host[] = this.galeraHosts.filter(host => host.checkStatus())
        const bestHost: Host = activeHosts[Utils.getRandomIntInRange(0, activeHosts.length - 1)]

        return bestHost.pool.query(sql, values, callback);
    }
}
