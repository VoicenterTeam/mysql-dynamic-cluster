import { GaleraCluster } from './GaleraCluster'
import { mysqlGaleraHost } from './interfaces'

function createPoolCluster(mysqlGaleraHosts: Array<mysqlGaleraHost>): GaleraCluster {
    return new GaleraCluster(mysqlGaleraHosts);
}

export default {
    createPoolCluster
};
