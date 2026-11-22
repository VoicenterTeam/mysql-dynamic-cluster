import net, { AddressInfo } from 'net';
import mysqlPromise from 'mysql2/promise';
import { createPoolCluster } from '../../index';
import { cleanUp, describeRig, logger, readEnv, rootTo } from './support';

// #93 on the Galera rig: a pooled connection whose path died without a close is probed after
// probeIdle (1 s by default) and replaced, and the write of the call runs once, on a new
// connection. A TCP proxy in front of one node plays the path. The package's default
// settings, as the app user, cluster hashing off. Skipped unless MDC_TEST_GALERA is set
const TABLE = 'contract_dead';

// A path to one node. cut() makes the open flows silent: what the client writes goes nowhere,
// nothing comes back and nothing is closed on its side, as on a path a firewall forgot. The
// node's end is closed. New connections pass
interface IProxy {
    port: number,
    // the flows open now
    open: () => number,
    cut: () => void,
    close: () => void
}
const proxyTo = async (host: string, port: number): Promise<IProxy> => {
    const flows = new Set<{ client: net.Socket, node: net.Socket, cut: boolean }>();
    const server = net.createServer(client => {
        const flow = { client, node: net.connect(port, host), cut: false };
        flows.add(flow);
        client.on('error', () => undefined);
        flow.node.on('error', () => undefined);
        client.on('data', data => flow.cut || flow.node.write(data));
        flow.node.on('data', data => flow.cut || client.write(data));
        client.on('close', () => {
            flows.delete(flow);
            flow.node.destroy();
        });
        flow.node.on('close', () => flow.cut || client.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        open: () => flows.size,
        cut: () => flows.forEach(flow => {
            flow.cut = true;
            flow.node.destroy();
        }),
        close: () => {
            server.close();
            flows.forEach(flow => flow.client.destroy());
        }
    };
};

describeRig('a connection whose path died silently, on Galera', () => {
    let root: mysqlPromise.Connection;
    let proxy: IProxy;
    let cluster: ReturnType<typeof createPoolCluster>;

    beforeAll(async () => {
        const env = readEnv();
        root = await rootTo(env, 1);
        await root.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await root.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
            'conn BIGINT UNSIGNED) ENGINE=InnoDB');
        proxy = await proxyTo(env.MDC_GALERA_HOST, Number(env.MDC_GALERA_PORT1));
        cluster = createPoolCluster({
            clusterName: 'dead',
            useClusterHashing: false,
            defaultPoolSettings: {
                user: env.MDC_GALERA_USER,
                password: env.MDC_GALERA_PASSWORD,
                database: env.MDC_GALERA_DATABASE
            },
            hosts: [{ host: '127.0.0.1', port: proxy.port, id: 1 }],
            logger: logger()
        });
        await cluster.connect();
        await cluster.ready;
    });

    afterAll(() => cleanUp(
        () => cluster?.disconnect(),
        () => proxy?.close(),
        () => root?.query(`DROP TABLE IF EXISTS ${TABLE}`),
        () => root?.end()
    ));

    it('after 1 s idle the next call answers from a new connection, and its write runs once',
        async () => {
            // a connection in the pool, through the proxy
            await cluster.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
            expect(proxy.open()).toBeGreaterThan(0);
            // the highest connection id of the node: a connection opened later gets a higher one
            const [[{ mark }]] = await root.query(
                'SELECT MAX(ID) AS mark FROM information_schema.PROCESSLIST'
            ) as any;

            proxy.cut();
            await new Promise(resolve => setTimeout(resolve, 1100));
            // a statement sent on the dead connection would wait for the query timeout
            const result = await cluster.query<any>(
                `INSERT INTO ${TABLE} (conn) VALUES (CONNECTION_ID())`, null,
                { signal: AbortSignal.timeout(10000) }
            );

            expect(result.affectedRows).toBe(1);
            const [rows] = await root.query(`SELECT conn FROM ${TABLE}`) as any;
            expect(rows).toHaveLength(1);
            expect(Number(rows[0].conn)).toBeGreaterThan(Number(mark));
        });
});
