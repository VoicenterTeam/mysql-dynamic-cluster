import fs from 'fs';
import { RowDataPacket } from 'mysql2';
import { createPoolCluster } from '../../index';

// Smoke test of the three-node Galera rig (tests/rig/galera.sh). Skipped unless MDC_TEST_GALERA
// is set. The rig writes the host, the ports and the login to the env file named by
// MDC_RIG_ENV, /tmp/mdc-rig-state/rig.env when that is not set. Default package settings
const describeRig = process.env.MDC_TEST_GALERA ? describe : describe.skip;

const readEnv = (): Record<string, string> => {
    const file = process.env.MDC_RIG_ENV || `${process.env.TMPDIR || '/tmp'}/mdc-rig-state/rig.env`;
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    return env;
};

describeRig('Galera rig', () => {
    let cluster: ReturnType<typeof createPoolCluster>;

    beforeAll(async () => {
        const env = readEnv();
        cluster = createPoolCluster({
            clusterName: 'rig',
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE
            },
            hosts: [1, 2, 3].map(n => ({
                host: env.MDC_GALERA_HOST,
                port: Number(env['MDC_GALERA_PORT' + n]),
                name: 'node' + n
            }))
        });
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(async () => {
        await cluster?.disconnect();
    });

    it('connects to the three nodes', async () => {
        const results = await cluster.ready;

        expect(results.map(result => result.ok)).toEqual([true, true, true]);
        expect(cluster.nodes().map(node => node.isValid)).toEqual([true, true, true]);
    });

    it('has every node answer a query, and the cluster size is 3', async () => {
        const seen: number[] = [];
        for (let i = 0; i < 3; i++) {
            const { connection, nodeId } = await cluster.getConnection({ exclude: seen });
            seen.push(nodeId);
            try {
                const [rows] = await connection.promise()
                    .query("SHOW STATUS LIKE 'wsrep_cluster_size'");
                expect(Number((rows as { Value: string }[])[0].Value)).toBe(3);
            } finally {
                connection.release();
            }
        }

        expect(seen.length).toBe(3);
        expect(new Set(seen).size).toBe(3);
    });

    it('answers a query of the cluster', async () => {
        const rows = await cluster.query<RowDataPacket[]>(
            "SHOW STATUS LIKE 'wsrep_cluster_size'"
        );

        expect(Number(rows[0].Value)).toBe(3);
    });
});
