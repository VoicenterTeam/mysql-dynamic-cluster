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

    public isReady(callback: (error: QueryError | null, result: boolean) => void) {
        Logger("Checking if node is active")
        this._pool.query(`SHOW GLOBAL STATUS LIKE 'wsrep_ready'`, (error, res) => {
            if (error) {
                Logger(error.message)
                this._active = false;
                callback(error, false)
                return;
            }

            Logger('Is node in host ' + this.host.host + ' ready? -> ' + res[0].Value)

            this._active = res[0].Value === 'ON';
            callback(null, this._active)
        })
    }

    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    public query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query {
        if (values) {
            return this._pool.query(sql, values, (error, result: T, fields) => {
                if (error) {
                    Logger("Error in pool from host " + this.host.host + error.message)
                    return this.queryAfterError(sql, values, callback);
                }

                callback(error, result, fields)
            })
        } else {
            return this._pool.query(sql, (error, result: T, fields) => {
                if (error) {
                    Logger("Error in pool from host " + this.host.host + error.message)
                    return this.queryAfterError(sql, callback);
                }

                callback(error, result, fields)
            })
        }
    }
    private queryAfterError<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    private queryAfterError<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query;
    private queryAfterError<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[] | { [param: string]: any }, callback?: (err: QueryError | null, result: T, fields: FieldPacket[]) => any): Query {
        Logger("retry query after error in pool from host " + this.host.host);

        if (values) {
            return this._pool.query(sql, values, callback)
        } else {
            return this._pool.query(sql, callback)
        }
    }
}
