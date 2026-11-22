import { PoolConnection } from 'mysql2';
import mysqlPromise from 'mysql2/promise';
import { createPoolCluster } from '../../index';
import { cleanUp, describeRig, logger, readEnv, rootTo } from './support';

// #90 and #93 on the Galera rig: a transaction a caller left open, with a row lock, is rolled
// back before the connection goes to the next caller. The package's default settings, as the
// app user, cluster hashing off. One node: a row lock is a lock of the node that holds it.
// Skipped unless MDC_TEST_GALERA is set
const TABLE = 'contract_lock';

// What a caller sees on its connection
interface ISeen {
    id: number,
    // a transaction is open, as the header of a reply says: bit 1 of serverStatus
    open: boolean
}
// the next caller on a connection, and what it saw there
interface INextCaller extends ISeen {
    connection: PoolConnection
}
const look = async (connection: PoolConnection): Promise<ISeen> => {
    const [rows] = await connection.promise().query('SELECT CONNECTION_ID() AS id') as any;
    const [header] = await connection.promise().query('DO 0') as any;
    return { id: rows[0].id, open: (header.serverStatus & 1) === 1 };
};

describeRig('a transaction left open, on Galera', () => {
    let root: mysqlPromise.Connection;
    let cluster: ReturnType<typeof createPoolCluster>;

    // The connection with this id, as a caller of getConnection() gets it: the next caller on
    // it. It is back in the pool once its reset is answered, so the connections that come
    // before it are held, not released, until it comes. A wait for a connection past the
    // limit of the pool ends after 5 s
    const nextCallerOn = async (id: number): Promise<INextCaller> => {
        const held: PoolConnection[] = [];
        try {
            for (let i = 0; i < 20; i++) {
                const signal = AbortSignal.timeout(5000);
                const { connection } = await cluster.getConnection({ signal });
                const seen = await look(connection);
                if (seen.id === id) return { connection, ...seen };
                held.push(connection);
            }
            throw new Error(`no caller got connection ${id}`);
        } finally {
            held.forEach(connection => connection.release());
        }
    };

    // Another session takes the lock of the row at once, NOWAIT, and sees the value as it was
    const lockFromAnotherSession = async (): Promise<number> => {
        await root.query('START TRANSACTION');
        try {
            const [rows] = await root.query(
                `SELECT v FROM ${TABLE} WHERE id = 1 FOR UPDATE NOWAIT`
            ) as any;
            return rows[0].v;
        } finally {
            await root.query('ROLLBACK');
        }
    };

    beforeAll(async () => {
        const env = readEnv();
        root = await rootTo(env, 1);
        await root.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await root.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, v INT) ENGINE=InnoDB`);
        await root.query(`INSERT INTO ${TABLE} VALUES (1, 0)`);
        await root.query('DROP PROCEDURE IF EXISTS leave_open');
        await root.query(`CREATE PROCEDURE leave_open() BEGIN
            START TRANSACTION;
            UPDATE ${TABLE} SET v = v + 1 WHERE id = 1;
            SELECT CONNECTION_ID() AS id;
        END`);
        cluster = createPoolCluster({
            clusterName: 'leftopen',
            useClusterHashing: false,
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE
            },
            hosts: [{ host: env.MDC_GALERA_HOST, port: Number(env.MDC_GALERA_PORT1), id: 1 }],
            logger: logger()
        });
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(() => cleanUp(
        () => cluster?.disconnect(),
        () => root?.query('DROP PROCEDURE IF EXISTS leave_open'),
        () => root?.query(`DROP TABLE IF EXISTS ${TABLE}`),
        () => root?.end()
    ));

    it('a query: the next caller on its connection sees no transaction, another session ' +
        'takes the row lock at once', async () => {
        const [[{ id }], header] = await cluster.query<any>('CALL leave_open()');
        // the transaction is still open when the reply comes: its header says so
        expect(header.serverStatus & 1).toBe(1);

        const next = await nextCallerOn(id);
        try {
            expect(next.open).toBe(false);
            expect(await lockFromAnotherSession()).toBe(0);
        } finally {
            next.connection.release();
        }
    });

    it('a caller of getConnection() who releases: the next caller on that connection sees ' +
        'no transaction, another session takes the row lock at once', async () => {
        const { connection } = await cluster.getConnection();
        await connection.promise().query('START TRANSACTION');
        await connection.promise().query(`UPDATE ${TABLE} SET v = v + 1 WHERE id = 1`);
        const seen = await look(connection);
        expect(seen.open).toBe(true);
        connection.release();

        const next = await nextCallerOn(seen.id);
        try {
            expect(next.open).toBe(false);
            expect(await lockFromAnotherSession()).toBe(0);
        } finally {
            next.connection.release();
        }
    });
});
