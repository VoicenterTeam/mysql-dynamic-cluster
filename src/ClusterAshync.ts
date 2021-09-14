import { GaleraCluster } from "./GaleraCluster";
import { Logger } from "./utils/Logger";
import { Timer } from "./utils/Timer";

export class ClusterAshync {
    private _cluster: GaleraCluster;
    private _timer: Timer;
    private readonly _nextCheckTime: number = 5000;
    private readonly database: string = "mysql-dynamic-cluster";
    public serviceNodeMap;

    constructor(cluster: GaleraCluster, timeCheck?: number) {
        this._cluster = cluster;
        if (timeCheck) {
            this._nextCheckTime = timeCheck;
        }
        this._timer = new Timer(this.checkAshync.bind(this));
    }

    public async connect() {
        try {
            // const res = await this._cluster.query('SELECT FN_GetServiceNodeMapping();', { database: this.database });
            // console.log(res);
            this.checkAshync();
        } catch (err) {
            Logger(err.message);
        }
    }

    public async checkAshync() {
        try {
            Logger("checking async status in cluster");
            const result = await this._cluster.query(`SELECT FN_GetServiceNodeMapping();`, { database: this.database });

            const num = 1;
            console.log(result[0]["FN_GetServiceNodeMapping()"][num]);

            this.serviceNodeMap = result;

            this.nextCheckAshync()
        } catch (err) {
            Logger("Error: Something wrong while checking ashync status in cluster.\n Message: " + err.message);
            this.nextCheckAshync()
        }
    }

    private nextCheckAshync() {
        this._timer.start(this._nextCheckTime);
    }

    public stop() {
        this._timer.dispose();
    }
}
