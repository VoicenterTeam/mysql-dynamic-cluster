import mysql from 'mysql2/promise';
import { createPoolCluster } from '../../index';
import { cleanUp, describeRig, logger, readEnv, rootTo, untilEveryNode } from './support';

// #87 on the three-node Galera rig: a statement the server got is never sent to a second
// node, so one call writes once. The package's default settings (two nodes per call, the
// default errorRetryCount), as the app user, cluster hashing off. Skipped unless
// MDC_TEST_GALERA is set
const TABLE = 'contract_double';

describeRig('a call that fails after its write, on Galera', () => {
    let env: Record<string, string>;
    let root: mysql.Connection;
    let cluster: ReturnType<typeof createPoolCluster>;

    // the rows each procedure wrote, read on every node of the cluster: causal reads
    const rows = async (who: string): Promise<number> => {
        const [found] = await root.query(
            `SELECT COUNT(*) AS n FROM ${TABLE} WHERE who = ?`, [who]
        ) as any;
        return Number(found[0].n);
    };

    beforeAll(async () => {
        env = readEnv();
        root = await rootTo(env, 1);
        await root.query('SET SESSION wsrep_sync_wait = 1');
        await root.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await root.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
            'who VARCHAR(40)) ENGINE=InnoDB');
        await root.query('DROP PROCEDURE IF EXISTS write_then_fail');
        await root.query(`CREATE PROCEDURE write_then_fail() BEGIN
            INSERT INTO ${TABLE} (who) VALUES ('fail');
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'failed after the write';
        END`);
        await root.query('DROP PROCEDURE IF EXISTS write_then_sleep');
        await root.query(`CREATE PROCEDURE write_then_sleep() BEGIN
            INSERT INTO ${TABLE} (who) VALUES ('sleep');
            DO SLEEP(3);
        END`);
        await untilEveryNode(env, 'SELECT COUNT(*) = 2 FROM information_schema.ROUTINES ' +
            "WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME LIKE 'write_then_%'",
            'the two procedures');
        cluster = createPoolCluster({
            clusterName: 'double',
            useClusterHashing: false,
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE
            },
            hosts: [1, 2, 3].map(n => ({
                host: env.MDC_GALERA_HOST, port: Number(env['MDC_GALERA_PORT' + n]), id: n
            })),
            logger: logger()
        });
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(() => cleanUp(
        () => cluster?.disconnect(),
        () => root?.query('DROP PROCEDURE IF EXISTS write_then_fail'),
        () => root?.query('DROP PROCEDURE IF EXISTS write_then_sleep'),
        () => root?.query(`DROP TABLE IF EXISTS ${TABLE}`),
        () => root?.end()
    ));

    it('every node is valid, so a second node could be tried', () => {
        expect(cluster.nodes().map(node => node.isValid)).toEqual([true, true, true]);
    });

    it('CALL write_then_fail() rejects with the error of the server and writes one row',
        async () => {
            const error = await cluster.query('CALL write_then_fail()').catch(e => e);

            expect(error).toBeInstanceOf(Error);
            expect(error.errno).toBe(1644);
            expect(error.sqlState).toBe('45000');
            expect(error.sent).toBe(true);
            // no node was tried before this one
            expect(error.errors).toEqual([]);
            expect(await rows('fail')).toBe(1);
        });

    it('CALL write_then_sleep() with timeout 1000 rejects after 1 s and writes one row',
        async () => {
            const started = Date.now();
            const error = await cluster.query('CALL write_then_sleep()', undefined,
                { timeout: 1000 }).catch(e => e);
            const took = Date.now() - started;

            expect(error).toBeInstanceOf(Error);
            expect(error.code).toBe('PROTOCOL_SEQUENCE_TIMEOUT');
            expect(error.sent).toBe(true);
            // no node was tried before this one
            expect(error.errors).toEqual([]);
            // a second node would have made it 2 s, as #87 measured on 4.6.0
            expect(took).toBeLessThan(1900);
            // the server goes on with the procedure. Counted once its sleep is over
            await new Promise(resolve => setTimeout(resolve, Math.max(0, started + 3500 -
                Date.now())));
            expect(await rows('sleep')).toBe(1);
        });
});
