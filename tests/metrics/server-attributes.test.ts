import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { metrics } from '@opentelemetry/api';
import {
    InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, AggregationTemporality
} from '@opentelemetry/sdk-metrics';
import { createPoolCluster } from '../../index';
import Metrics from '../../src/metrics/Metrics';
import { Settings } from '../../src/utils/Settings';
import MetricNames from '../../src/metrics/MetricNames';

// metrics.serverAttributes (#160): a cluster that keeps the database, hosts and ports off its
// metrics, on its own, beside a cluster that does not. Real mysql2 against mysql2's own server
// class on the loopback interface, read back through an in-memory reader
jest.setTimeout(20000);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach(close => close()));

// mysql2's server class does not count the packets of a client command and says so on stderr.
// Only that line is dropped
const consoleError = console.error;
beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('got packets out of order')) consoleError(...args);
    });
});
afterAll(() => jest.restoreAllMocks());

const column = (name: string) => ({
    catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: '',
    characterSet: 33, columnLength: 384, columnType: 253, flags: 0, decimals: 0
});
// what the health check of a pool wants to see from a node
const STATUS = [
    { Variable_name: 'wsrep_ready', Value: 'ON' },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '1' },
    { Variable_name: 'Connections', Value: '1' },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0' }
];

// A node that takes every login and answers every query with the status rows
const listen = (): Promise<number> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    closers.push(() => {
        connections.forEach(connection => connection.stream.destroy());
        server.close();
    });
    server.on('connection', (connection: any) => {
        connections.push(connection);
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => done(null)
        });
        connection.on('query', () => {
            connection.sequenceId = 1;
            connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => connection.close());
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server._server.address() as AddressInfo).port);
        });
    });
};

const clusters: any[] = [];
afterEach(async () => {
    for (const cluster of clusters.splice(0)) await cluster.disconnect();
    for (const provider of providers.splice(0)) await provider.shutdown();
    metrics.disable();
});

const providers: MeterProvider[] = [];
// The SDK of the app, registered, read back through an in-memory exporter
const registeredSdk = () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
    const provider = new MeterProvider({ readers: [reader] });
    providers.push(provider);
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
    return async (): Promise<{ [name: string]: { attributes: any }[] }> => {
        await reader.forceFlush();
        const collected = {};
        for (const resourceMetrics of exporter.getMetrics()) {
            for (const scopeMetrics of resourceMetrics.scopeMetrics) {
                for (const metric of scopeMetrics.metrics) {
                    collected[metric.descriptor.name] = metric.dataPoints;
                }
            }
        }
        exporter.reset();
        return collected;
    };
};

// A Redis client of the app: createPoolCluster looks at the name of its constructor. It is
// ready at once, and answers each get with the next of its answers, then with nothing
class Redis {
    answers: string[] = [];
    on(event: string, listener: () => void) {
        if (event === 'ready') listener();
    }
    async get(): Promise<string | null> {
        return this.answers.shift() ?? null;
    }
    async set(): Promise<string> {
        return 'OK';
    }
    disconnect() {
        return undefined;
    }
}


const SERVER = ['server.address', 'server.port', 'db.namespace'];
const POOL_NAME = 'db.client.connection.pool.name';
const CLUSTER = 'mysql_dynamic_cluster.cluster.name';

type Points = { [name: string]: { attributes: any }[] };
const allPoints = (collected: Points) => {
    return Object.values(collected).reduce((all, points) => all.concat(points), []);
};
const ofCluster = (collected: Points, clusterName: string) => {
    return allPoints(collected).filter(({ attributes }) => attributes[CLUSTER] === clusterName);
};
const poolNames = (points: { attributes: any }[]) => {
    return [...new Set(points.map(({ attributes }) => attributes[POOL_NAME]))].sort();
};
const withServer = (points: { attributes: any }[], key: string) => {
    return points.filter(({ attributes }) => key in attributes).length;
};

// the instruments whose points name a pool
const NODE_LEVEL = [
    'mysql_dynamic_cluster.operation.duration',
    'mysql_dynamic_cluster.connection.wait_time',
    'mysql_dynamic_cluster.health_check.duration',
    'mysql_dynamic_cluster.connection.count',
    'mysql_dynamic_cluster.connection.pending_requests',
    'mysql_dynamic_cluster.connection.limit',
    'mysql_dynamic_cluster.node.valid',
    'mysql_dynamic_cluster.node.load_score'
];

const makeCluster = (clusterName: string, hosts: object[], more: object = {}): any => {
    const cluster: any = createPoolCluster({
        clusterName,
        hosts,
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            timerCheckRange: { start: 600000, end: 600000 }
        },
        useClusterHashing: false,
        logs: { level: 'silent' },
        ...more
    } as any);
    clusters.push(cluster);
    return cluster;
};

describe('metrics.serverAttributes in the settings', () => {
    const mix = (metricsSettings?: unknown) => {
        return Settings.mixSettings(
            { clusterName: 'c', hosts: [{ host: 'h' }], metrics: metricsSettings } as any
        );
    };

    it('is true when the block or the key is left out', () => {
        expect((Settings.mixSettings({ clusterName: 'c', hosts: [{ host: 'h' }] } as any) as any)
            .metrics).toEqual({ serverAttributes: true });
        expect((mix({}) as any).metrics).toEqual({ serverAttributes: true });
    });

    it('takes false', () => {
        expect((mix({ serverAttributes: false }) as any).metrics)
            .toEqual({ serverAttributes: false });
    });

    it('rejects a value that is not a boolean and a key it does not know', () => {
        expect(() => mix({ serverAttributes: 'no' })).toThrow();
        expect(() => mix({ serverAttributes: false, hosts: true })).toThrow();
    });
});

describe('a cluster with serverAttributes false', () => {
    it('has no server.address, server.port or db.namespace on any point, and the id as the ' +
        'pool name of a host without a name',
        async () => {
            const collect = registeredSdk();
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const client = new Redis();
            const cluster = makeCluster('hidden', [
                { host: '127.0.0.1', port: portA },
                { host: '127.0.0.1', port: portB, name: 'named' }
            ], {
                metrics: { serverAttributes: false },
                redis: { enabled: true }, redisInstant: client
            });
            await cluster.connect();
            await cluster.query('SELECT 1', undefined, { database: 'tenant' });
            await cluster.query('SELECT 2', undefined, { database: 'tenant' });
            const collected = await collect();

            // every instrument of the library made a point, so a new one cannot go unchecked
            const names = Object.values(MetricNames).map(metric => metric.name).sort();
            expect(Object.keys(collected).sort()).toEqual(expect.arrayContaining(names));
            const points = allPoints(collected);
            expect(points.length).toBeGreaterThan(0);
            for (const key of SERVER) expect(withServer(points, key)).toBe(0);
            for (const { attributes } of points) expect(attributes[CLUSTER]).toBe('hidden');
            // every point but the cache lookup, which never had db.system.name
            for (const name of Object.keys(collected)) {
                if (name === MetricNames.cacheLookupDuration.name) continue;
                for (const { attributes } of collected[name]) {
                    expect([name, attributes['db.system.name']]).toEqual([name, 'mysql']);
                }
            }
            // the status query of the check is an operation too: SHOW
            for (const { attributes } of collected['mysql_dynamic_cluster.query.duration']) {
                expect(attributes['db.operation.name']).toBe('SELECT');
            }
            expect(collected['mysql_dynamic_cluster.operation.duration']
                .filter(({ attributes }) => attributes['db.operation.name'] === 'SELECT').length)
                .toBeGreaterThan(0);

            const ids = cluster.nodes().map(node => String(node.id));
            expect(ids.length).toBe(2);
            // the pool name is the id for the host without a name, its own name for the other
            const byPool = {};
            for (const name of [
                'mysql_dynamic_cluster.operation.duration',
                'mysql_dynamic_cluster.connection.wait_time',
                'mysql_dynamic_cluster.health_check.duration',
                'mysql_dynamic_cluster.connection.count',
                'mysql_dynamic_cluster.node.valid'
            ]) byPool[name] = poolNames(collected[name]);
            for (const name of Object.keys(byPool)) {
                expect([name, byPool[name]]).toEqual([name, [ids[0], 'named'].sort()]);
            }
        });

    it('keeps host:port as the name of the pool, in the nodes and in the stats', async () => {
        const port = await listen();
        const cluster = makeCluster('hidden', [{ host: '127.0.0.1', port }], {
            metrics: { serverAttributes: false }
        });
        await cluster.connect();

        expect(cluster._pools[0].name).toBe('127.0.0.1:' + port);
        expect(cluster.nodes()[0].name).toBe('127.0.0.1:' + port);
        expect(cluster.getPoolStats()[0].nodeId).toBe(cluster.nodes()[0].id);
    });
});

describe('two clusters in one process, one with serverAttributes false', () => {
    it.each([['A first', true], ['B first', false]])('only the points of A lose the attributes, %s',
        async (_title, aFirst) => {
            const collect = registeredSdk();
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const hostsA = [{ host: '127.0.0.1', port: portA }];
            const hostsB = [{ host: '127.0.0.1', port: portB }];
            let a: any, b: any;
            if (aFirst) {
                a = makeCluster('A', hostsA, { metrics: { serverAttributes: false } });
                b = makeCluster('B', hostsB);
            } else {
                b = makeCluster('B', hostsB);
                a = makeCluster('A', hostsA, { metrics: { serverAttributes: false } });
            }
            await a.connect();
            await b.connect();
            await a.query('SELECT 1', undefined, { database: 'tenant' });
            await b.query('SELECT 1', undefined, { database: 'tenant' });
            const collected = await collect();

            const pointsA = ofCluster(collected, 'A');
            const pointsB = ofCluster(collected, 'B');
            expect(pointsA.length).toBeGreaterThan(0);
            expect(pointsB.length).toBeGreaterThan(0);
            for (const key of SERVER) expect(withServer(pointsA, key)).toBe(0);
            expect(poolNames(pointsA)).toEqual([String(a.nodes()[0].id)]);

            // B as in 4.2.0: all three attributes where they were, and host:port
            expect(poolNames(pointsB)).toEqual(['127.0.0.1:' + portB]);
            expect(withServer(pointsB, 'db.namespace')).toBeGreaterThan(0);
            // every point of B that has a pool name has the host and the port of B, by value
            let checked = 0;
            for (const name of Object.keys(collected)) {
                const ofB = collected[name].filter(({ attributes }) => {
                    return attributes[CLUSTER] === 'B' && POOL_NAME in attributes;
                });
                for (const { attributes } of ofB) {
                    expect([name, attributes['server.address'], attributes['server.port']])
                        .toEqual([name, '127.0.0.1', portB]);
                    checked++;
                }
            }
            // the node-level instruments, each one has a point of B
            for (const name of NODE_LEVEL) {
                expect([name, collected[name].some(({ attributes }) => {
                    return attributes[CLUSTER] === 'B';
                })]).toEqual([name, true]);
            }
            expect(checked).toBeGreaterThan(NODE_LEVEL.length);
        });
});

describe('a pool source with serverAttributes false', () => {
    it('reports neither server.* nor its host as the name, registered with the cluster name only',
        async () => {
            const collect = registeredSdk();
            const source = {
                name: '10.0.0.1:3306', metricName: '7', serverAttributes: false,
                host: '10.0.0.1', port: 3306, connectionLimit: 10,
                stats: () => ({ used: 1, idle: 2, pending: 0 }),
                status: { isValid: true, loadScore: 3 }
            };
            Metrics.registerPools([source], 'unit');
            const collected = await collect();
            Metrics.unregisterPools([source]);

            const points = ['connection.count', 'connection.pending_requests',
                'connection.limit', 'node.valid', 'node.load_score']
                .flatMap(name => collected['mysql_dynamic_cluster.' + name] || []);
            expect(points.length).toBeGreaterThanOrEqual(5);
            for (const { attributes } of points) {
                expect(attributes['server.address']).toBeUndefined();
                expect(attributes['server.port']).toBeUndefined();
                expect(attributes[POOL_NAME]).toBe('7');
            }
        });
});
