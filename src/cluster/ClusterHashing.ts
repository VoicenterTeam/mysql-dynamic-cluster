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
    public connected: boolean = false;

    private _serviceNodeMap: Map<number, number> = new Map<number, number>(); // key: serviceID; value: nodeID
    private _cluster: GaleraCluster;
    private _timer: Timer;

    // Next time for hashing check
    private readonly _nextCheckTime: number;
    private readonly _database: string;
    // Bumping it drops and rebuilds the schema, and older versions sharing it would drop it back.
    // Keep schema changes backward compatible and apply them in _upgradeInPlace instead
    private readonly _databaseVersion: number = 1;

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

        this._timer = new Timer(this._checkHashing.bind(this));
        Logger.debug("Cluster hashing configured");
    }

    /**
     * Activate hashing and create helper db if needed
     */
    public async connect() {
        try {
            if (!await this._isDatabaseVersionEquals()) {
                await this._cluster.query(
                    `DROP SCHEMA IF EXISTS ${this._database};`,
                    null,
                    {
                        maxRetry: 1,
                        redis: false
                    }
                );
                await this._createDB();
            } else {
                await this._upgradeInPlace();
            }
            Logger.info(`Database ${this._database} created for hashing`);

            await this._insertNodes();
            await this._checkHashing();
        } catch (err) {
            throw err;
        }
    }

    /**
     * Stop timer for hashing check
     */
    public stop() {
        this._timer.dispose();
        this.connected = false;
        Logger.info("Checking hashing in the cluster stopped");
    }

    /**
     * Update node for service in db
     * @param serviceId service what need to hashing
     * @param nodeId pool where hashing data
     */
    public async updateNodeForService(serviceId: number, nodeId: number) {
        try {
            await this._cluster.query('CALL SP_NodeServiceUpdate(?, ?);', [serviceId, nodeId], {
                maxRetry: 1,
                database: this._database,
                redis: false
            });

            this._serviceNodeMap.set(serviceId, nodeId);
        } catch (e) {
            Logger.error(e.message);
        }
    }

    /**
     * Get node / pool from hashing by service ID
     * @param serviceId service ID
     */
    public getNodeByService(serviceId: number): number {
        return this._serviceNodeMap.get(serviceId);
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

            Logger.debug(`Creating database ${this._database} and procedures for hashing...`);
            await this._cluster.query(`CREATE SCHEMA IF NOT EXISTS \`${this._database}\` COLLATE utf8_general_ci;`, null, { maxRetry: 1, redis: false });

            const sqls: string[] = [];
            sqls.push( ...this._readFilesInDir(join(__dirname, sqlLocations.tables)).fileContents );

            const routinesSqls = this._readFilesInDir(join(__dirname, sqlLocations.routines));
            sqls.push( ...routinesSqls.fileContents );

            const sqlsMetadata: string[] = this._readFilesInDir(join(__dirname, sqlLocations.metadata)).fileContents;

            const sqlsDrop: string[] = [];
            routinesSqls.fileNames.forEach(name => {
                sqlsDrop.push(`DROP ${name.startsWith('FN_') ? 'FUNCTION' : 'PROCEDURE'} IF EXISTS ${name};`);
            });

            await this._cluster.pools[0].multiStatementQuery(sqlsDrop, { database: this._database });
            await this._cluster.pools[0].multiStatementQuery(sqls, { database: this._database });
            await this._cluster.pools[0].multiStatementQuery(sqlsMetadata, { database: this._database });

            await this._cluster.query(
                `INSERT INTO metadata (version) VALUES (${this._databaseVersion});`,
                null,
                {
                    maxRetry: 1,
                    database: this._database,
                    redis: false
                }
            );
        } catch (e) {
            throw e;
        }
    }

    /**
     * Bring a schema built by an older version up to date without dropping it or its data.
     * Each step runs only when needed and keeps what older versions use: the port column is
     * only widened, and routines are recreated with the same signatures. A failed step is logged
     * and retried on the next start
     * @private
     */
    private async _upgradeInPlace() {
        const options = { maxRetry: 1, database: this._database, redis: false };
        const step = async (name: string, needed: () => Promise<boolean>, sqls: () => string[]) => {
            try {
                if (!await needed()) return;
                Logger.info(`Upgrading hashing schema ${this._database}: ${name}`);
                for (const sql of sqls()) {
                    await this._cluster.query(sql, null, options);
                }
            } catch (e) {
                Logger.error(`Upgrading hashing schema ${this._database} (${name}) failed: ${e.message}`);
            }
        };
        const routine = (name: string, kind: 'FUNCTION' | 'PROCEDURE') => {
            // same path as _createDB
            const routines = this._readFilesInDir(join(__dirname, '../' + '../../assets/sql/create_hashing_database/routines/'));
            return [`DROP ${kind} IF EXISTS ${name};`, routines.fileContents[routines.fileNames.indexOf(name)]];
        };

        // ports above 32767 (signed smallint) were rejected
        await step('node.port smallint unsigned', async () => {
            const res: any[] = await this._cluster.query(
                `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'node' AND COLUMN_NAME = 'port';`,
                [this._database], options);
            return res.length > 0 && !/unsigned/i.test(res[0].type);
        }, () => ['ALTER TABLE node MODIFY port smallint unsigned default 3306 null;']);

        // MySQL 8 with binary logging refuses the function without READS SQL DATA (error 1418)
        await step('FN_GetServiceNodeMapping READS SQL DATA', async () => {
            const res: any[] = await this._cluster.query(
                `SELECT SQL_DATA_ACCESS AS access FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'FN_GetServiceNodeMapping';`,
                [this._database], options);
            return res[0]?.access !== 'READS SQL DATA';
        }, () => routine('FN_GetServiceNodeMapping', 'FUNCTION'));

        await step('SP_NodeInsert _Port smallint unsigned', async () => {
            const res: any[] = await this._cluster.query(
                `SELECT DTD_IDENTIFIER AS type FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = 'SP_NodeInsert' AND PARAMETER_NAME = '_Port';`,
                [this._database], options);
            return !/unsigned/i.test(res[0]?.type ?? '');
        }, () => routine('SP_NodeInsert', 'PROCEDURE'));
    }

    /**
     * Check if database version is the same in the server
     * @private
     */
    private async _isDatabaseVersionEquals(): Promise<boolean> {
        try {
            const resDb: any[] = await this._cluster.query(
                `show databases where \`Database\` = '${this._database}';`,
                null,
                {
                    maxRetry: 1,
                    redis: false
                }
            );

            if (resDb.length < 1) return false;

            const res = await this._cluster.query(
                `SELECT version FROM metadata;`,
                null,
                {
                    maxRetry: 1,
                    database: this._database,
                    redis: false
                }
            );
            const serverVersion: number = res[0]?.version;
            return serverVersion === this._databaseVersion;
        } catch (e) {
            Logger.error(e.message);
            return false;
        }
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
        for (const pool of this._cluster.pools) {
            try {
                await this._cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [pool.id, pool.name, pool.host, pool.port],
                {
                    maxRetry: 1,
                    database: this._database,
                    redis: false
                });
            } catch (e) {
                Logger.error(e.message);
            }
        }
    }

    /**
     * Update hashing data from db
     */
    private async _checkHashing() {
        try {
            if (!this._timer.active) return;

            Logger.debug("checking async status in cluster");
            const result = await this._cluster.query(`SELECT FN_GetServiceNodeMapping() AS Result;`, null,
            {
                maxRetry: 1,
                database: this._database,
                redis: false
            });
            const res: IServiceNodeMap[] = result[0].Result as IServiceNodeMap[];
            res?.forEach(obj => {
                this._serviceNodeMap.set(obj.ServiceID, obj.NodeID);
            })

            this.connected = true;
            this._nextCheckHashing()
        } catch (err) {
            Logger.error("Something wrong while checking hashing status in cluster.\n Message: " + err.message);
            this.connected = false;
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
}
