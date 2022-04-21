import { GaleraCluster } from "../cluster/GaleraCluster";
import Logger from "./Logger";

class ServiceNames {
    private _serviceIds: Map<string, number>;
    private _cluster: GaleraCluster;
    private _database: string;

    public init(cluster: GaleraCluster, database: string) {
        this._cluster = cluster;
        this._database = database;
    }

    public async getID(serviceName: string): Promise<number> {
        return undefined;
        if (this._serviceIds.has(serviceName)) return this._serviceIds.get(serviceName);

        return await this._receiveIDbyName(serviceName);
    }

    private async _receiveIDbyName(serviceName: string): Promise<number> {
        try {
            const res = await this._cluster.query('', [], { database: this._database });
            console.log(res);
            this._serviceIds.set(serviceName, 10);
            return 10;
        } catch (e) {
            Logger.error(e);
            return undefined;
        }
    }
}

export default new ServiceNames();
