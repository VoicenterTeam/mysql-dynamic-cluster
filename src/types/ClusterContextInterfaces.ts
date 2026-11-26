import { ILogger } from "./LoggerInterfaces";

/**
 * What the parts of one cluster share and those of no other cluster have (#86). The cluster
 * hands it to its pools, and a pool to its check, its connections and its session
 */
export interface IClusterContext {
    // the logger of the cluster: the level and the logger of the app of its own settings
    logger: ILogger,
    // the cluster name its metrics carry. Not set: the name of Metrics.init, read at each record
    clusterName?: string,
    // false: its metrics carry no server.address, server.port and db.namespace (#160). Not set: true
    serverAttributes?: boolean
}
