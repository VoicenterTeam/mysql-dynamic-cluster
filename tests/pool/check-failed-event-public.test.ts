import { createPoolCluster } from '../../index';

// No mocks: the cluster the app gets, built by createPoolCluster, and its own on().
// Only the query of its pool is replaced, so no database is needed
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('pool_check_failed, the way an app subscribes', () => {
    it('cluster.on delivers the error of a failed check and the pool id', async () => {
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: [{ host: '127.0.0.1' }],
            defaultPoolSettings: { user: 'u', password: 'wrong', database: 'd' },
            useClusterHashing: false,
            logger
        } as any);
        const pool = cluster.pools[0];
        const error = Object.assign(
            new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 }
        );
        pool.query = jest.fn().mockRejectedValue(error);
        const received: any[] = [];
        cluster.on('pool_check_failed', (args: any) => received.push(args));

        pool.status.active = true;
        await pool.status.checkStatus();
        pool.status.stopTimerCheck();

        expect(received).toEqual([[error, pool.id]]);
        expect(received[0][0].errno).toBe(1045);
    });
});
