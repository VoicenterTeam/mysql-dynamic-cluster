/**
 * Created by Bohdan on Sep, 2021
 */

import { GaleraCluster } from "./GaleraCluster";
import Logger from "../utils/Logger";
import { Timer } from "../utils/Timer";
import { ServiceNodeMap } from "../types/PoolInterfaces";
import { readFileSync, readdirSync }  from 'fs'
import { join, parse } from "path";

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
     * Activate hashing and create helper db if needed
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

    /**
     * Create database for hashing
     * @private
     */
    private async _createDB() {
        try {
            // const extraPath = '';
            const extraPath = '../';
            const sqlLocations: string[] = [
                extraPath + '../../assets/sql/create_hashing_database/tables/',
                extraPath + '../../assets/sql/create_hashing_database/routines/'
            ];

            if (await this._isDatabaseCompletelyCreated(sqlLocations)) {
                Logger.info(`Database ${this._database} has created for hashing`);
                return;
            }

            Logger.info(`Creating database ${this._database} and procedures for hashing`);
            await this._cluster.pools[0].query(`CREATE SCHEMA IF NOT EXISTS \`${this._database}\` COLLATE utf8_general_ci;`);

            const sqls: string[] = [];
            for (const path of sqlLocations) {
                for ( const sql of this._readFilesInDir( join(__dirname, path) ) ) {
                    sqls.push(sql);
                }
            }

            const sqlsDrop = [
                `DROP PROCEDURE IF EXISTS FN_GetServiceNodeMapping;`,
                `DROP PROCEDURE IF EXISTS SP_NodeInsert;`,
                `DROP PROCEDURE IF EXISTS SP_NodeServiceUpdate;`,
                `DROP PROCEDURE IF EXISTS SP_RemoveNode;`,
                `DROP PROCEDURE IF EXISTS SP_RemoveService;`
            ]

            await this._cluster.pools[0].multiStatementQuery(sqlsDrop, { database: this._database });
            await this._cluster.pools[0].multiStatementQuery(sqls, { database: this._database });

            Logger.info(`Database ${this._database} completely created for hashing`);
        } catch (e) {
            Logger.error(e.message);
        }
    }

    /**
     * Check if database for hashing completely created
     * @param pathToSqls path to folders with sql files
     * @private
     */
    private async _isDatabaseCompletelyCreated(pathToSqls: string[]): Promise<boolean> {
        try {
            Logger.info(`Checking if database ${this._database} completely created for hashing...`);
            const res: any[] = await this._cluster.pools[0].query(`show databases where \`Database\` = '${this._database}';`);
            if (res.length) {
                const sqlFileNames: string[] = [];
                let countCorrectlyCreated: number = 0;

                pathToSqls.forEach(path => {
                    readdirSync(join(__dirname, path)).forEach(filename => {
                        sqlFileNames.push(parse(filename).name);
                    });
                })

                const resultTable: any[] = await this._cluster.pools[0].query(`show table status from \`${this._database}\`;`);
                const resultFunc: any[] = await this._cluster.pools[0].query(`show function status WHERE Db = '${this._database}';`);
                const resultProc: any[] = await this._cluster.pools[0].query(`show procedure status WHERE Db = '${this._database}';`);
                [...resultTable, ...resultFunc, ...resultProc].forEach(elem => {
                    if (sqlFileNames.includes(elem.Name)) countCorrectlyCreated++;
                })

                if (countCorrectlyCreated === sqlFileNames.length) return true;
            }

            return false;
        } catch (e) {
            throw e;
        }
    }

    /**
     * Read content in files which in folder
     * @param dirname path to folder
     * @private
     */
    private _readFilesInDir(dirname: string): string[] {
        const fileNames: string[] = readdirSync(dirname);
        const fileContents: string[] = [];
        fileNames.forEach(filename => {
            fileContents.push(readFileSync(dirname + filename).toString());
        })
        return fileContents;
    }

    /**
     * Create helper db
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
     * Update hashing data from db
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
     * Activate next hashing check
     * @private
     */
    private _nextCheckHashing() {
        this._timer.start(this._nextCheckTime);
    }

    /**
     * Stop timer for hashing check
     */
    public stop() {
        this._timer.dispose();
    }

    /**
     * Update data in db for hashing
     * @param serviceId service what need to hashing
     * @param nodeId pool which hashing data
     */
    public async updateServiceForNode(serviceId: number, nodeId: number) {
        await this._cluster.query('CALL SP_NodeServiceUpdate(?, ?);', [nodeId, serviceId], {
            database: this._database
        });
    }
}
