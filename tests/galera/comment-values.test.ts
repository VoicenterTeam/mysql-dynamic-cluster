import mysql from 'mysql2/promise';
import { format } from 'sql-escaper';
import { createPoolCluster } from '../../index';
import { cleanUp, describeRig, logger, readEnv } from './support';

// The contract test of #134 on the three-node Galera rig (tests/rig/galera.sh), MySQL 8.0.42.
// Skipped unless MDC_TEST_GALERA is set. A server that reads /*+ */ or /*!NNNNN */ as a plain
// comment ends it at a */ inside the quotes of a value, and a skipped /*!NNNNN */ nests a /* of a
// value in it: the rest of the value runs as SQL. A value can write the version of /*! too. The
// raw text is the one query() would send, written by sql-escaper's format()

// the statement with a ? for each value, and values that add a column named injected
const CASES: [string, string, (string | number)[]][] = [
    ['/*+ */ after a select item', 'SELECT 1 AS a /*+ ? */', ['*/ , 2 AS injected -- ']],
    ['/*+ */ in a hint position', 'SELECT /*+ QB_NAME(?) */ 2 AS a', ['*/ 1 AS injected, /*']],
    ['/*!99999 */, above the version of the server', 'SELECT 2 AS a /*!99999 ? */',
        ['*/ , 1 AS injected -- ']],
    // the inputs of the review: no */ of a value is needed inside the comment
    ['a comment nested in /*!99999 */', 'SELECT 2 AS a /*!99999 /* note */ , ? AS b */',
        ['*/ , 1 AS injected -- ']],
    ['a /* in /*!99999 */, a */ after it', 'SELECT 1 AS a /*!99999 ? */ FROM t WHERE name = ?',
        ['/*', '*/ , 1 AS injected -- ']],
    // the version written by a value
    ['the version of /*! from a value', 'SELECT 2 AS a /*!? , ? AS b */',
        [99999, '*/ , 1 AS injected -- ']]
];

// the same statement with :v0, :v1 ... and an object of the values
const named = (sql: string, values: (string | number)[]) => {
    let k = 0;
    return {
        sql: sql.replace(/\?/g, () => ':v' + k++),
        values: Object.fromEntries(values.map((value, i) => ['v' + i, value]))
    };
};

describeRig('a value holding /* or */ with /*+ */ or /*!NNNNN */ on MySQL 8.0.42', () => {
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

    it.each(CASES)('%s: the raw text returns the injected column', async (_where, sql, values) => {
        const [, fields] = await raw.query(format(sql, values));

        expect(fields.map(field => field.name)).toContain('injected');
    });

    it.each(CASES)('%s: query() refuses the values with a ?', async (_where, sql, values) => {
        const error = await cluster.query(sql, values).catch((e: any) => e);

        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
    });

    it.each(CASES)('%s: query() refuses the values with a :name', async (_where, sql, values) => {
        const call = named(sql, values);
        const error = await cluster.query(call.sql, call.values).catch((e: any) => e);

        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
    });

    it('a hint with a number still works', async () => {
        const rows = await cluster.query('SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1 AS a',
            { ms: 1000 });

        expect(rows).toEqual([{ a: 1 }]);
    });
});
