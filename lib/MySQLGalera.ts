import { GaleraCluster } from './GaleraCluster'
import { MysqlGaleraHost } from './interfaces'

function createPoolCluster(mysqlGaleraHosts: MysqlGaleraHost[]): GaleraCluster {
    return new GaleraCluster(mysqlGaleraHosts);
}

export default {
    createPoolCluster
};
