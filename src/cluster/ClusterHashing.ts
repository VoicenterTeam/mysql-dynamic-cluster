/**
 * Created by Bohdan on Sep, 2021
 */

import { GaleraCluster } from "./GaleraCluster";
import Logger from "../utils/Logger";
import { Timer } from "../utils/Timer";
import { ServiceNodeMap } from "../types/PoolInterfaces";
import { readFileSync, readdirSync }  from 'fs'
import { join } from "path";

export class ClusterHashing {
    private _cluster: GaleraCluster;
    private _timer: Timer;

    // Next time for hashing check
    private readonly _nextCheckTime: number = 5000;
    private readonly _database: string = "mysql_dynamic_cluster";

    public serviceNodeMap: ServiceNodeMap;

    /**
     * @param cluster cluster for what hashing data
     * @param timeCheck time to next time check
     * @param database database in what helper data will be saved
     */
    constructor(cluster: GaleraCluster, timeCheck?: number, database?: string) {
        this._cluster = cluster;
        if (timeCheck) this._nextCheckTime = timeCheck;
        if (database) this._database = database;

        this._timer = new Timer(this.checkHashing.bind(this));
    }

    /**
     * activate hashing and create helper db if needed
     */
    public async connect() {
        try {
            await this._createDB();
            await this._insertNodes();
            this.checkHashing();
        } catch (err) {
            Logger.error(err.message);
        }
    }

    private async _createDB() {
        try {
            const res: any[] = await this._cluster.pools[0].query(`show databases like '${this._database}';`);
            if (res.length) {
                Logger.debug(`Database ${this._database} has created for hashing`);
                return;
            }

            Logger.debug(`Creating database ${this._database} and procedures for hashing`);
            await this._cluster.pools[0].query(`CREATE SCHEMA IF NOT EXISTS \`${this._database}\` COLLATE utf8_general_ci;`);

            for ( const sql of this._readFilesInDir( join(__dirname, '../../assets/sql/create_hashing_database/tables/') ) ) {
                await this._cluster.pools[0].query(sql, { database: this._database });
            }
            for ( const sql of this._readFilesInDir( join(__dirname, '../../assets/sql/create_hashing_database/routines/') ) ) {
                await this._cluster.pools[0].query(sql, { database: this._database });
            }
        } catch (e) {
            Logger.error(e.message);
        }
    }

    private _readFilesInDir(dirname: string): string[] {
        const fileNames: string[] = readdirSync(dirname);
        const fileContents: string[] = [];
        fileNames.forEach(filename => {
            fileContents.push(readFileSync(dirname + filename).toString());
        })
        return fileContents;
    }

    /**
     * create helper db
     * @private
     */
    private async _insertNodes() {
        this._cluster.pools.forEach(pool => {
            try {
                this._cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [pool.id, pool.name, pool.host, pool.port],
                {
                    database: this._database
                });
            } catch (e) {
                Logger.error(e.message);
            }
        });
    }

    /**
     * update hashing data from db
     */
    public async checkHashing() {
        try {
            if (!this._timer.active) return;

            Logger.debug("checking async status in cluster");
            const result = await this._cluster.query(`SELECT FN_GetServiceNodeMapping();`, null,
            {
                database: this._database
            });
            this.serviceNodeMap = result[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;

            this._nextCheckHashing()
        } catch (err) {
            Logger.error("Something wrong while checking hashing status in cluster.\n Message: " + err.message);
            this._nextCheckHashing()
        }
    }

    /**
     * activate next hashing check
     * @private
     */
    private _nextCheckHashing() {
        this._timer.start(this._nextCheckTime);
    }

    /**
     * stop timer for hashing check
     */
    public stop() {
        this._timer.dispose();
    }

    /**
     * update data in db for hashing
     * @param serviceId service what need to hashing
     * @param nodeId pool which hashing data
     */
    public updateServiceForNode(serviceId: number, nodeId: number) {
        this._cluster.query('CALL SP_NodeServiceUpdate(?, ?);', [nodeId, serviceId], {
            database: this._database
        });
    }
}
