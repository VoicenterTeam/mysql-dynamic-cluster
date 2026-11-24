/**
 * Created by Bohdan on Apr, 2022
 */

import { GaleraCluster } from "../cluster/GaleraCluster";
import Logger from "./Logger";
import { ILogger } from "../types/LoggerInterfaces";
import { IServiceMetricsSettings } from "../types/MetricsInterfaces";

interface ServiceNameResult {
    Result: number
}

export default class ServiceNames {
    private _serviceIds: Map<string, number> = new Map<string, number>();
    private _cluster: GaleraCluster;
    private readonly _database: string;
    private readonly _table: string;
    // the logger of the cluster (#86). The module logger when the cluster passes none
    private readonly _logger: ILogger;

    constructor(cluster: GaleraCluster, options: IServiceMetricsSettings, logger: ILogger = Logger) {
        this._cluster = cluster;
        this._database = options.database;
        this._table = options.table;
        this._logger = logger;
    }

    public async getID(serviceName: string): Promise<number> {
        if (this._serviceIds.has(serviceName)) return this._serviceIds.get(serviceName);

        return await this._receiveIDbyName(serviceName);
    }

    private async _receiveIDbyName(serviceName: string): Promise<number> {
        try {
            const res = await this._cluster.execute(
                `SELECT ServiceID AS Result FROM ${this._table} WHERE ServiceName LIKE ?;`,
                // bound by the server: the name comes from the caller of query()
                [serviceName],
                {
                    maxRetry: 1,
                    database: this._database,
                    redis: false
                }
            ) as ServiceNameResult[];

            if (res.length <= 0) {
                this._logger.error(`Didn't find service id by name ${serviceName}`);
                return undefined;
            }

            this._serviceIds.set(serviceName, res[0].Result);
            return this._serviceIds.get(serviceName);
        } catch (e) {
            this._logger.error(e);
            return undefined;
        }
    }
}
