import mysqlPromise from 'mysql2/promise';
import { createPoolCluster } from '../../index';
import { describeRig, logger, readEnv, rootTo, until, untilEveryNode } from './support';

// #87 and #90 on the Galera rig: a node that drops out of the primary component refuses a
// statement with 1047, and the call goes on to the next node at once. Once the node is back
// the cluster uses it again. The package's default settings, as the app user, cluster hashing
// off. Skipped unless MDC_TEST_GALERA is set
const TABLE = 'contract_dropout';
// It reads a table: a node out of the primary component answers a SELECT without one
const WHO = `SELECT @@hostname AS host, COUNT(*) AS n FROM ${TABLE}`;

describeRig('a node drops out of the cluster, on Galera', () => {
    // root on each node, by node id
    const roots: Record<number, mysqlPromise.Connection> = {};
    const hostnames: Record<number, string> = {};
    let cluster: ReturnType<typeof createPoolCluster>;
    const log = logger();
    // the node taken out, until it is back
    let out: number | undefined;

    const status = async (n: number, name: string): Promise<string> => {
        const [rows] = await roots[n].query(`SHOW STATUS LIKE '${name}'`) as any;
        return rows[0]?.Value;
    };
    const synced = async (n: number): Promise<boolean> =>
        await status(n, 'wsrep_cluster_status') === 'Primary' &&
        await status(n, 'wsrep_local_state_comment') === 'Synced' &&
        await status(n, 'wsrep_cluster_size') === '3';
    const isolate = (n: number, on: 0 | 1) =>
        roots[n].query(`SET GLOBAL wsrep_provider_options = 'gmcast.isolate=${on}'`);
    const ask = async (): Promise<{ host: string, n: number }> =>
        (await cluster.query<any>(WHO))[0];
    const isValid = (n: number): boolean => cluster.nodes().find(node => node.id === n).isValid;
    // the node the cluster asks first, as it orders them: the valid one with the lowest load
    // score, the one listed first on a tie
    const first = (): number | undefined => cluster.nodes()
        .filter(node => node.isValid)
        .sort((a, b) => a.loadScore - b.loadScore)[0]?.id;

    beforeAll(async () => {
        const env = readEnv();
        for (const n of [1, 2, 3]) {
            roots[n] = await rootTo(env, n);
            const [rows] = await roots[n].query('SELECT @@hostname AS host') as any;
            hostnames[n] = rows[0].host;
        }
        await roots[1].query(`DROP TABLE IF EXISTS ${TABLE}`);
        await roots[1].query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY) ENGINE=InnoDB`);
        await roots[1].query(`INSERT INTO ${TABLE} VALUES (1)`);
        await untilEveryNode(env, `SELECT COUNT(*) FROM ${TABLE}`, 'the row');
        cluster = createPoolCluster({
            clusterName: 'dropout',
            useClusterHashing: false,
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE
            },
            hosts: [1, 2, 3].map(n => ({
                host: env.MDC_GALERA_HOST,
                port: Number(env['MDC_GALERA_PORT' + n]),
                id: n,
                name: 'node' + n
            })),
            logger: log
        });
        await cluster.connect();
        await cluster.ready;
    });

    // the next suite gets three Synced nodes, also when a test failed half way
    afterAll(async () => {
        if (out) {
            await isolate(out, 0);
            await until(() => synced(out), `node ${out} Synced again`, 120000);
        }
        await cluster?.disconnect();
        await roots[1]?.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await Promise.all(Object.values(roots).map(root => root.end()));
    }, 150000);

    it('a query answers from another node within one call', async () => {
        expect(cluster.nodes().map(node => node.isValid)).toEqual([true, true, true]);
        out = first();
        const host = hostnames[out];

        await isolate(out, 1);
        // It answers until it sees that it is out, about 6 s later (evs.suspect_timeout). The
        // call after that asks it first, gets 1047 and goes on to the next node. A call counts
        // only when the node was the first valid one by load score just before it: the check
        // of the node, up to 15 s away, can reorder the nodes or take this one out first
        let answer: { host: string, n: number };
        let took = 0;
        await until(async () => {
            if (!isValid(out)) {
                throw new Error(`the check took node ${out} out before a call met its 1047: ` +
                    'the scenario was not shown, run the suite again');
            }
            // another node is asked first for now: no call shows the scenario
            if (first() !== out) return false;
            const started = Date.now();
            answer = await ask();
            took = Date.now() - started;
            return answer.host !== host;
        }, 'an answer of another node', 60000);

        expect(answer.n).toBe(1);
        expect(took).toBeLessThan(1000);
        const refused = log.error.mock.calls.map(([message]) => message).filter(message =>
            message.startsWith(`Query failed in pool node${out}: WSREP has not yet prepared`));
        expect(refused).toHaveLength(1);
        expect(await status(out, 'wsrep_cluster_status')).toBe('non-Primary');
    });

    it('after isolate=0, once the node is Synced again, it is used again', async () => {
        expect(out).toBeDefined();
        const back = out;

        await isolate(back, 0);
        await until(() => synced(back), `node ${back} Synced again`, 120000);
        out = undefined;
        // the next check of the node takes it back: its interval is 15 s at most
        await until(() => isValid(back), `the cluster to take node ${back} back`, 60000);

        const others = [1, 2, 3].filter(n => n !== back);
        const { connection, nodeId } = await cluster.getConnection({ exclude: others });
        try {
            const [rows] = await connection.promise().query(WHO) as any;
            expect(nodeId).toBe(back);
            expect(rows[0].host).toBe(hostnames[back]);
            expect(rows[0].n).toBe(1);
        } finally {
            connection.release();
        }
    });
});
