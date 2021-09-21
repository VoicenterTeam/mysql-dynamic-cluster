/**
 * Created by Bohdan on Sep, 2021
 */

import { GaleraCluster } from "./GaleraCluster";
import Logger from "./utils/Logger";
import { Timer } from "./utils/Timer";
import { ServiceNodeMap } from "./types/PoolInterfaces";

// #FIXME: don't want close after closing all pools
export class ClusterHashing {
    private _cluster: GaleraCluster;
    private _timer: Timer;

    // Next time for hashing check
    private readonly _nextCheckTime: number = 5000;
    private readonly _database: string = "mysql-dynamic-cluster";

    public serviceNodeMap: ServiceNodeMap;

    /**
     * @param cluster cluster for what hashing data
     * @param timeCheck time to next time check
     * @param database database in what helper data will be saved
     */
    constructor(cluster: GaleraCluster, timeCheck?: number, database?: string) {
        this._cluster = cluster;
        if (timeCheck) {
            this._nextCheckTime = timeCheck;
        }
        if (database) {
            this._database = database;
        }

        this._timer = new Timer(this.checkHashing.bind(this));
    }

    /**
     * activate hashing and create helper db if needed
     */
    public async connect() {
        try {
            this._createDB();
            this.checkHashing();
        } catch (err) {
            Logger.error(err.message);
        }
    }

    /**
     * create helper db
     * @private
     */
    private async _createDB() {
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
            Logger.debug("checking async status in cluster");
            const result = await this._cluster.query(`SELECT FN_GetServiceNodeMapping();`, null,
            {
                database: this._database
            });
            this.serviceNodeMap = result[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;

            this._nextCheckHashing()
        } catch (err) {
            Logger.error("Error: Something wrong while checking hashing status in cluster.\n Message: " + err.message);
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
