import { RowDataPacket } from 'mysql2';
import { createPoolCluster } from '../../index';
import { describeRig, logger, readEnv } from './support';

// The contract test of #91 on the three-node Galera rig (tests/rig/galera.sh), MySQL 8.0.42.
// Skipped unless MDC_TEST_GALERA is set. The second part loads the package from dist/, so run
// `npm run build` first: the paths of the hashing SQL assets work from dist/ only
// (docs/known-issues.md #7). It needs MDC_GALERA_ROOT_PASSWORD in the env file: only root may
// create the hashing schema and its routines while binary logging is on
const LONG = 600000;

// Strings with quotes and backslashes. Each must come back as one column holding exactly it
const HOSTILE = [
    "it's", '"double"', '\\', "\\'", "'\\", "a\\' OR '1'='1", "'; DROP TABLE t; -- ",
    "\\\\'", 'back\\slash\\', '\\0', "''", 'line\nbreak', 'nul\u0000byte', 'ünïcödé ✓', '%_'
];
// the value of SET SESSION sql_mode, and what @@SESSION.sql_mode then holds
const MODES: [string, string, string][] = [
    ['the default mode', 'DEFAULT', 'STRICT_TRANS_TABLES'],
    ['ANSI_QUOTES', "'ANSI_QUOTES'", 'ANSI_QUOTES'],
    ['NO_BACKSLASH_ESCAPES', "'NO_BACKSLASH_ESCAPES'", 'NO_BACKSLASH_ESCAPES']
];

describeRig('bound values on MySQL 8.0.42', () => {
    let cluster: any;

    // One node and one connection, so every call of the cluster runs in the session the SET
    // changed. The health check asks on a connection of its own
    beforeAll(async () => {
        const env = readEnv();
        cluster = createPoolCluster({
            clusterName: 'bound',
            useClusterHashing: false,
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE,
                connectionLimit: 1,
                healthCheck: { interval: LONG, passive: false }
            },
            hosts: [{ host: env.MDC_GALERA_HOST, port: Number(env.MDC_GALERA_PORT1) }],
            logger: logger()
        });
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(async () => {
        await cluster?.disconnect();
    });

    describe.each(MODES)('under %s', (name, mode, holds) => {
        // the reply to the SET is an OK header: the pool learns bit 512 from it
        beforeAll(async () => {
            await cluster.query(`SET SESSION sql_mode = ${mode}`);
        });

        it('the pooled connection is in that mode', async () => {
            const rows = await cluster.execute('SELECT @@SESSION.sql_mode AS mode');

            expect(rows[0].mode).toContain(holds);
        });

        it.each(HOSTILE)('execute() returns %j as one column holding exactly it', async value => {
            const rows = await cluster.execute('SELECT ? AS v', [value]) as RowDataPacket[];

            expect(rows).toHaveLength(1);
            expect(Object.keys(rows[0])).toEqual(['v']);
            expect(rows[0].v).toBe(value);
        });

        if (name === 'NO_BACKSLASH_ESCAPES') {
            it.each(HOSTILE)('query() refuses %j: the connection has seen the bit', async value => {
                const error = await cluster.query('SELECT ? AS v', [value]).catch((e: any) => e);

                expect(error.code).toBe('MDC_UNSAFE_SQL_MODE');
            });
        } else {
            it.each(HOSTILE)('query() returns %j as well', async value => {
                const rows = await cluster.query('SELECT ? AS v', [value]) as RowDataPacket[];

                expect(rows[0].v).toBe(value);
            });
        }
    });
});

describeRig('cluster hashing on MySQL 8.0.42', () => {
    const SCHEMA = 'boundhash_mysql_dynamic_cluster';
    let cluster: any;
    const log = logger();

    beforeAll(async () => {
        const env = readEnv();
        // from dist/: see the top of the file
        const built = require('../../dist/index');
        cluster = built.createPoolCluster({
            clusterName: 'boundhash',
            useClusterHashing: true,
            defaultPoolSettings: {
                user: 'root',
                password: env.MDC_GALERA_ROOT_PASSWORD,
                database: env.MDC_GALERA_DATABASE,
                healthCheck: { interval: LONG, passive: false }
            },
            hosts: [1, 2, 3].map(n => ({
                host: env.MDC_GALERA_HOST, port: Number(env['MDC_GALERA_PORT' + n]), id: n
            })),
            logger: log
        });
        // resolves once the first node is up and hashing was set up on it
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(async () => {
        await cluster?.disconnect();
    });

    it('creates its schema and registers the three nodes, with no error', async () => {
        const rows = await cluster.query(
            `SELECT node_id AS id, port FROM ${SCHEMA}.node ORDER BY node_id`
        ) as RowDataPacket[];

        expect(log.error).not.toHaveBeenCalled();
        expect(cluster._clusterHashing.connected).toBe(true);
        expect(rows.map(row => row.id)).toEqual([1, 2, 3]);
        expect(rows.map(row => row.port)).toEqual(cluster.nodes().map((node: any) => node.port));
    });

    it('pins a service to the node that ran its query', async () => {
        await cluster.query('SELECT 1', null, { serviceId: 5 });

        const rows = await cluster.execute(
            `SELECT node_id AS id FROM ${SCHEMA}.node_services WHERE service_id = ?`, [5]
        ) as RowDataPacket[];

        expect(log.error).not.toHaveBeenCalled();
        expect(rows).toHaveLength(1);
        expect([1, 2, 3]).toContain(rows[0].id);
    });
});
