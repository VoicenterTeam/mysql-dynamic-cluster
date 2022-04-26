/**
 * Created by Bohdan on Apr, 2022
 */

import { GaleraCluster } from "../cluster/GaleraCluster";
import Logger from "./Logger";
import { ServiceMetricsSettings } from "../types/MetricsInterfaces";

interface ServiceNameResult {
    Result: number
}

export default class ServiceNames {
    private _serviceIds: Map<string, number> = new Map<string, number>();
    private _cluster: GaleraCluster;
    private readonly _database: string;
    private readonly _table: string;

    constructor(cluster: GaleraCluster, options: ServiceMetricsSettings) {
        this._cluster = cluster;
        this._database = options.database;
        this._table = options.table;
    }

    public async getID(serviceName: string): Promise<number> {
        if (this._serviceIds.has(serviceName)) return this._serviceIds.get(serviceName);

        return await this._receiveIDbyName(serviceName);
    }

    private async _receiveIDbyName(serviceName: string): Promise<number> {
        try {
            const res = await this._cluster.query(
                `SELECT ServiceID AS Result FROM ${this._table} WHERE ServiceName LIKE '${serviceName}';`,
                null,
                { database: this._database, maxRetry: 1 }
            ) as ServiceNameResult[];

            if (res.length <= 0) {
                Logger.error(`Didn't find service id by name ${serviceName}`);
                return undefined;
            }

            this._serviceIds.set(serviceName, res[0].Result);
            return this._serviceIds.get(serviceName);
        } catch (e) {
            Logger.error(e);
            return undefined;
        }
    }
}
