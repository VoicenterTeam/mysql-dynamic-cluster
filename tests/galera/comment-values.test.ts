import mysql from 'mysql2/promise';
import { format } from 'sql-escaper';
import { createPoolCluster } from '../../index';
import { cleanUp, describeRig, logger, readEnv } from './support';

// The contract test of #134 on the three-node Galera rig (tests/rig/galera.sh), MySQL 8.0.42.
// Skipped unless MDC_TEST_GALERA is set. A server that reads /*+ */ or /*!NNNNN */ as a plain
// comment ends it at the first */, also one inside the quotes of a value: the rest of the value
// runs as SQL. The raw text is the one query() would send, written by sql-escaper's format()

// the statement with a ? for the value, and a value that adds a column named injected there
const CASES: [string, string, string][] = [
    ['/*+ */ after a select item', 'SELECT 1 AS a /*+ ? */', '*/ , 2 AS injected -- '],
    ['/*+ */ in a hint position', 'SELECT /*+ QB_NAME(?) */ 2 AS a', '*/ 1 AS injected, /*'],
    ['/*!99999 */, above the version of the server', 'SELECT 2 AS a /*!99999 ? */',
        '*/ , 1 AS injected -- ']
];

describeRig('a value holding */ inside /*+ */ or /*!NNNNN */ on MySQL 8.0.42', () => {
    let cluster: any;
    let raw: mysql.Connection;

    beforeAll(async () => {
        const env = readEnv();
        const node = { host: env.MDC_GALERA_HOST, port: Number(env.MDC_GALERA_PORT1) };
        raw = await mysql.createConnection({
            ...node,
            user: env.MDC_GALERA_USER,
            password: env.MDC_GALERA_PASSWORD,
            database: env.MDC_GALERA_DATABASE
        });
        cluster = createPoolCluster({
            clusterName: 'commentvalues',
            useClusterHashing: false,
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE
            },
            hosts: [node],
            logger: logger()
        });
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(() => cleanUp(
        () => cluster?.disconnect(),
        () => raw?.end()
    ));

    it.each(CASES)('%s: the raw text returns the injected column', async (_where, sql, value) => {
        const [, fields] = await raw.query(format(sql, [value]));

        expect(fields.map(field => field.name)).toContain('injected');
    });

    it.each(CASES)('%s: query() refuses the value with a ?', async (_where, sql, value) => {
        const error = await cluster.query(sql, [value]).catch((e: any) => e);

        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
    });

    it.each(CASES)('%s: query() refuses the value with a :name', async (_where, sql, value) => {
        const error = await cluster.query(sql.replace('?', ':v'), { v: value })
            .catch((e: any) => e);

        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
    });

    it('a hint with a value that holds no */ still works', async () => {
        const rows = await cluster.query('SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1 AS a',
            { ms: 1000 });

        expect(rows).toEqual([{ a: 1 }]);
    });
});
