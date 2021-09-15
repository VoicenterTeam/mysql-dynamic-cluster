import { GaleraCluster } from "./GaleraCluster";
import { Logger } from "./utils/Logger";
import { Timer } from "./utils/Timer";
import { ServiceNodeMap } from "./types/PoolInterfaces";

export class ClusterHashing {
    private _cluster: GaleraCluster;
    private _timer: Timer;

    private readonly _nextCheckTime: number = 5000;
    private readonly _database: string = "mysql-dynamic-cluster";

    public serviceNodeMap: ServiceNodeMap;

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

    public async connect() {
        try {
            this._createDB();
            this.checkHashing();
        } catch (err) {
            Logger(err.message);
        }
    }

    private async _createDB() {
        this._cluster.pools.forEach(pool => {
            try {
                this._cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );', [pool.id, pool.name, pool.host, pool.port],
                {
                    database: this._database
                });
            } catch (e) {
                Logger(e.message);
            }
        });
    }

    public async checkHashing() {
        try {
            Logger("checking async status in cluster");
            const result = await this._cluster.query(`SELECT FN_GetServiceNodeMapping();`, null,
            {
                database: this._database
            });
            this.serviceNodeMap = result[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;

            this._nextCheckHashing()
        } catch (err) {
            Logger("Error: Something wrong while checking hashing status in cluster.\n Message: " + err.message);
            this._nextCheckHashing()
        }
    }

    private _nextCheckHashing() {
        this._timer.start(this._nextCheckTime);
    }

    public stop() {
        this._timer.dispose();
    }

    public updateServiceForNode(serviceId: number, nodeId: number) {
        this._cluster.query('CALL SP_NodeServiceUpdate(?, ?);', [nodeId, serviceId], {
            database: this._database
        });
    }
}
