/**
 * Created by Bohdan on Sep, 2021
 */

import { GaleraCluster } from "./GaleraCluster";
import Logger from "../utils/Logger";
import { Timer } from "../utils/Timer";
import { IServiceNodeMap } from "../types/PoolInterfaces";
import { readFileSync, readdirSync }  from 'fs'
import { join, parse } from "path";
import { IClusterHashingSettings, ISQLLocations } from "../types/ClusterHashingInterfaces";

export class ClusterHashing {
    public serviceNodeMap: Map<number, number> = new Map<number, number>(); // key: serviceID; value: nodeID

    private _cluster: GaleraCluster;
    private _timer: Timer;

    // Next time for hashing check
    private readonly _nextCheckTime: number;
    private readonly _database: string;
    private readonly _databaseVersion: number = 1;

    // TODO: cluster hashing db version. Change created status

    /**
     * @param cluster cluster for what hashing data
     * @param clusterName cluster name used for prefix
     * @param options cluster settings
     */
    constructor(cluster: GaleraCluster, clusterName: string, options: IClusterHashingSettings) {
        Logger.debug("Configuring hashing in cluster...");
        this._cluster = cluster;
        this._nextCheckTime = options.nextCheckTime;
        this._database = `${clusterName}_${options.dbName}`;

        this._timer = new Timer(this.checkHashing.bind(this));
        Logger.debug("Cluster hashing configured");
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
            const sqlLocations: ISQLLocations = {
                tables: extraPath + '../../assets/sql/create_hashing_database/tables/',
                routines: extraPath + '../../assets/sql/create_hashing_database/routines/',
                metadata: extraPath + '../../assets/sql/create_hashing_database/metadata/'
            }

            if (await this._isDatabaseCreated()) {
                Logger.info(`Database ${this._database} has created for hashing`);
                return;
            }

            Logger.debug(`Creating database ${this._database} and procedures for hashing...`);
            await this._cluster.pools[0].query(`CREATE SCHEMA IF NOT EXISTS \`${this._database}\` COLLATE utf8_general_ci;`);

            const sqls: string[] = [];
            sqls.push( ...this._readFilesInDir(join(__dirname, sqlLocations.tables)).fileContents );

            const routinesSqls = this._readFilesInDir(join(__dirname, sqlLocations.routines));
            sqls.push( ...routinesSqls.fileContents );

            const sqlsMetadata: string[] = this._readFilesInDir(join(__dirname, sqlLocations.metadata)).fileContents;

            const sqlsDrop: string[] = [];
            routinesSqls.fileNames.forEach(name => {
                sqlsDrop.push(`DROP PROCEDURE IF EXISTS ${name};`);
            });

            await this._cluster.pools[0].multiStatementQuery(sqlsDrop, { database: this._database });
            await this._cluster.pools[0].multiStatementQuery(sqls, { database: this._database });
            await this._cluster.pools[0].multiStatementQuery(sqlsMetadata, { database: this._database });

            Logger.info(`Database ${this._database} created for hashing`);
        } catch (e) {
            Logger.error(e.message);
        }
    }

    /**
     * Check if database for hashing completely created
     * @private
     */
    private async _isDatabaseCreated(): Promise<boolean> {
        try {
            Logger.debug(`Checking if database ${this._database} created for hashing...`);
            const resDb: any[] = await this._cluster.query(
                `show databases where \`Database\` = '${this._database}';`,
                null,
                { maxRetry: 1 }
            );

            if (resDb.length < 1) return false;

            const resTable: any[] = await this._cluster.query(
                `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = "metadata";`,
                null,
                { maxRetry: 1 }
            );

            if (resTable.length < 1) return false;

        } catch (e) {
            throw e;
        }
    }

    private async _isDatabaseVersionEquals(): Promise<boolean> {
        return false;
    }

    /**
     * Read content in files which in folder
     * @param dirname path to folder
     * @private
     */
    private _readFilesInDir(dirname: string): { fileNames: string[], fileContents: string[] } {
        const fullFileNames: string[] = readdirSync(dirname);
        const fileNames: string[] = [];
        const fileContents: string[] = [];
        fullFileNames.forEach(filename => {
            fileContents.push(readFileSync(dirname + filename).toString());
            fileNames.push(parse(filename).name);
        })

        return { fileNames, fileContents };
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
            const res: IServiceNodeMap = result[0].Result as IServiceNodeMap;
            console.log(res);

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
        Logger.info("Checking hashing in the cluster stopped");
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
