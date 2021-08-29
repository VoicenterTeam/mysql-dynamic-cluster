import { Pool as MySQLPool } from "mysql2/typings/mysql"
import {OkPacket, ResultSetHeader, RowDataPacket, QueryError, FieldPacket, Query} from "mysql2/typings/mysql";
import { createPool } from "mysql2";
import { Host } from "./Host";
import {Logger} from "./Logger";

export class Pool {
    private _active: boolean = false;
    get active(): boolean {
        return  this._active;
    }

    private _pool: MySQLPool

    private readonly host: Host
    private readonly connectionLimit: number

    constructor(host: Host, connectionLimit?: number) {
        this.host = host
        this.connectionLimit = connectionLimit ? connectionLimit : host.connectionLimit
        Logger("configuration finished for pool from host: " + this.host.host)
    }

    public create(user: string, password: string, database: string) {
        Logger("Creating pool from host: " + this.host.host)
        this._pool = createPool({
            connectionLimit: this.connectionLimit,
            host: this.host.host,
            user,
            password,
            database
        })

        this._active = true;
    }

    public close(callback: (err: NodeJS.ErrnoException) => void) {
        Logger("closing pool from host: " + this.host.host)
        this._pool.end(callback);
    }

    private checkReady() {
        Logger("Checking if node is active")
        this._pool.query(`SHOW GLOBAL STATUS LIKE 'wsrep_ready'`, (err, res) => {
            if (err) {
                Logger(err.message)
                return
            }

            Logger('Is node in host ' + this.host.host + ' ready? -> ' + res[0].Value)

            this._active = res[0].Value === 'ON';
        })
    }

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query {
        return this._pool.query(sql, values, callback);
    }

    // #TODO: repeat query after error
}