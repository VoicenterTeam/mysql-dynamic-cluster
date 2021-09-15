import { GaleraCluster } from "./GaleraCluster";
import { Logger } from "./utils/Logger";
import { Timer } from "./utils/Timer";
import {ServiceNodeMap} from "./types/PoolInterfaces";

export class ClusterAshync {
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

        this._timer = new Timer(this.checkAshync.bind(this));
    }

    public async connect() {
        try {
            this._createDB();
            this.checkAshync();
        } catch (err) {
            Logger(err.message);
        }
    }

    private async _createDB() {
        this._cluster.pools.forEach(pool => {
            try {
                this._cluster.query('CALL SP_NodeInsert( ? , ? , ? , ? );',
                {
                    values: [pool.id, pool.name, pool.host, pool.port],
                    database: this._database
                });
            } catch (e) {
                Logger(e.message);
            }
        });
    }

    public async checkAshync() {
        try {
            Logger("checking async status in cluster");
            const result = await this._cluster.query(`SELECT FN_GetServiceNodeMapping();`,
            {
                database: this._database
            });
            this.serviceNodeMap = result[0]["FN_GetServiceNodeMapping()"] as ServiceNodeMap;

            this._nextCheckAshync()
        } catch (err) {
            Logger("Error: Something wrong while checking ashync status in cluster.\n Message: " + err.message);
            this._nextCheckAshync()
        }
    }

    private _nextCheckAshync() {
        this._timer.start(this._nextCheckTime);
    }

    public stop() {
        this._timer.dispose();
    }

    public updateServiceForNode(serviceId: number, nodeId: number) {
        this._cluster.query('CALL SP_NodeServiceUpdate(?, ?);',
        {
            values: [nodeId, serviceId],
            database: this._database
        });
    }
}
