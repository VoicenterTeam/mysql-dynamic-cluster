import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { metrics } from '@opentelemetry/api';
import {
    InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, AggregationTemporality
} from '@opentelemetry/sdk-metrics';
import { createPoolCluster } from '../../index';
import Logger from '../../src/utils/Logger';

// Two clusters made by createPoolCluster in one process (#86), each on a node of its own: the
// real mysql2 against mysql2's own server class on the loopback interface. Each cluster logs
// through the logger and the level of its own settings, and its metrics carry its own
// clusterName, also after a later createPoolCluster. The module logger follows the last
// createPoolCluster, as before
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

const appLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
type AppLogger = ReturnType<typeof appLogger>;

// A cluster of one node. flags are set, so connect() asks no server first, and the next
// health check is ten minutes away: connect() runs the only one. `more` goes on top of the
// settings
const makeCluster = (
    clusterName: string, port: number, level: string, logger: AppLogger, more: object = {}
): any => {
    const cluster: any = createPoolCluster({
        clusterName,
        hosts: [{ host: '127.0.0.1', port }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [],
            timerCheckRange: { start: 600000, end: 600000 }
        },
        useClusterHashing: false,
        logs: { level },
        logger,
        ...more
    } as any);
    clusters.push(cluster);
    return cluster;
};

// the messages of one method of an app logger
const lines = (method: jest.Mock): string[] => method.mock.calls.map(call => call[0]);
const count = (method: jest.Mock, line: string): number => {
    return lines(method).filter(message => message === line).length;
};

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

const CLUSTER = 'mysql_dynamic_cluster.cluster.name';
const PORT = 'server.port';
const OPERATION = 'db.operation.name';

// The cluster names on the points of a metric, by the value of another attribute
const namesBy = (points: { attributes: any }[] = [], key: string): object => {
    const names = {};
    for (const { attributes } of points) {
        const by = attributes[key];
        names[by] = [...new Set([...(names[by] || []), attributes[CLUSTER]])].sort();
    }
    return names;
};

describe('two clusters made in one process', () => {
    it.each([
        ['debug', 'info'],
        ['info', 'debug']
    ])('each logs its pool, check and query through its own logger, A at %s and B at %s',
        async (levelA, levelB) => {
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const loggerA = appLogger();
            const loggerB = appLogger();
            const a = makeCluster('A', portA, levelA, loggerA);
            const b = makeCluster('B', portB, levelB, loggerB);

            // all of it after B was made
            await a.connect();
            await b.connect();
            await a.query('SELECT 1');
            await b.query('SELECT 1');

            for (const [logger, level] of [[loggerA, levelA], [loggerB, levelB]] as const) {
                // the pool of the cluster, at info: its own, never the pool of the other
                expect(count(logger.info, 'Pool is connected')).toBe(1);
                if (level === 'debug') {
                    // its check and its query, once each
                    expect(count(logger.debug, 'Check status in pool started')).toBe(1);
                    expect(count(logger.debug, 'Query use host: 127.0.0.1')).toBe(1);
                } else {
                    // at info: nothing at debug, neither its own nor what the other logs
                    expect(logger.debug).not.toHaveBeenCalled();
                }
            }
        });

    it('the module logger follows the last createPoolCluster, the first cluster keeps its own',
        async () => {
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const loggerA = appLogger();
            const loggerB = appLogger();
            const a = makeCluster('A', portA, 'debug', loggerA);
            makeCluster('B', portB, 'warn', loggerB);

            // the module logger: the logger of B, at the level of B
            Logger.info('a line of the module logger');
            Logger.warn('a warning of the module logger');
            await a.connect();

            expect(lines(loggerB.warn)).toContain('a warning of the module logger');
            expect(lines(loggerB.info)).toEqual([]);
            expect(lines(loggerA.warn)).not.toContain('a warning of the module logger');
            expect(lines(loggerA.info)).not.toContain('a line of the module logger');
            // A: its own logger, at its own level
            expect(lines(loggerA.info)).toContain('Pool is connected');
            expect(lines(loggerA.debug)).toContain('Check status in pool started');
        });

    it('the error of a validator of A whose key is not in the status goes to the logger of A only',
        async () => {
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const loggerA = appLogger();
            const loggerB = appLogger();
            // added to the default validators: the node of A is not valid
            const missing = { key: 'no_such_status', operator: '=', value: 'ON' };
            const a = makeCluster('A', portA, 'info', loggerA, {
                hosts: [{ host: '127.0.0.1', port: portA, validators: [missing] }]
            });
            const b = makeCluster('B', portB, 'info', loggerB);

            await a.connect().catch(() => undefined);
            await b.connect();

            const line = "Validator key no_such_status isn't in the global status, validator fails";
            expect(count(loggerA.error, line)).toBe(1);
            expect(lines(loggerB.error)).toEqual([]);
        });

    it('the disconnect() of A logs to the logger of A, the shared Redis to the module logger',
        async () => {
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const loggerA = appLogger();
            const loggerB = appLogger();
            const a = makeCluster('A', portA, 'info', loggerA);
            const b = makeCluster('B', portB, 'info', loggerB);
            await a.connect();
            await b.connect();

            await a.disconnect();
            clusters.splice(clusters.indexOf(a), 1);

            for (const line of [
                'Checking hashing in the cluster stopped',
                'Check status in pool stopped',
                'pool named 127.0.0.1:' + portA + ' closed'
            ]) {
                expect([line, count(loggerA.info, line), count(loggerB.info, line)])
                    .toEqual([line, 1, 0]);
            }
            // Redis is one for the process: its line goes to the module logger, B's settings
            expect(count(loggerB.info, 'Redis disconnected')).toBe(1);
            expect(count(loggerA.info, 'Redis disconnected')).toBe(0);
        });

    it('each stamps its own clusterName on its cache lookups, through one shared Redis client',
        async () => {
            const collect = registeredSdk();
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const client = new Redis();
            const more = { redis: { enabled: true }, redisInstant: client };
            const a = makeCluster('A', portA, 'silent', appLogger(), more);
            const b = makeCluster('B', portB, 'silent', appLogger(), more);
            await a.connect();
            await b.connect();

            // the query of A finds fresh data, that of B finds nothing
            client.answers.push(JSON.stringify({ data: [{ a: 1 }], expired: Date.now() + 600000 }));
            expect(await a.query('SELECT 1')).toEqual([{ a: 1 }]);
            await b.query('SELECT 1');
            const collected = await collect();

            expect(namesBy(
                collected['mysql_dynamic_cluster.cache.lookup.duration'],
                'mysql_dynamic_cluster.cache.result'
            )).toEqual({ hit: ['A'], miss: ['B'] });
            expect(namesBy(
                collected['mysql_dynamic_cluster.query.duration'],
                'mysql_dynamic_cluster.result.source'
            )).toEqual({ cache: ['A'], pool: ['B'] });
        });

    it('each stamps its own clusterName on its query, wait, check, connection and node metrics',
        async () => {
            const collect = registeredSdk();
            const [portA, portB] = await Promise.all([listen(), listen()]);
            const a = makeCluster('A', portA, 'silent', appLogger());
            const b = makeCluster('B', portB, 'silent', appLogger());

            await a.connect();
            await b.connect();
            await a.query('SELECT 1');
            await b.query('SHOW STATUS');
            const collected = await collect();

            const byNode = { [portA]: ['A'], [portB]: ['B'] };
            expect(namesBy(collected['mysql_dynamic_cluster.query.duration'], OPERATION))
                .toEqual({ SELECT: ['A'], SHOW: ['B'] });
            for (const name of [
                'mysql_dynamic_cluster.operation.duration',
                'mysql_dynamic_cluster.connection.wait_time',
                'mysql_dynamic_cluster.health_check.duration',
                'mysql_dynamic_cluster.connection.count',
                'mysql_dynamic_cluster.connection.pending_requests',
                'mysql_dynamic_cluster.connection.limit',
                'mysql_dynamic_cluster.node.valid',
                'mysql_dynamic_cluster.node.load_score'
            ]) {
                expect([name, namesBy(collected[name], PORT)]).toEqual([name, byNode]);
            }
        });
});

describe('one cluster alone', () => {
    it('logs the lines of before #86 through the logger of its settings', async () => {
        const port = await listen();
        const logger = appLogger();
        const cluster = makeCluster('solo', port, 'info', logger);
        await cluster.connect();
        await cluster.query('SELECT 1');
        await cluster.disconnect();
        clusters.splice(0);

        expect(lines(logger.info)).toEqual([
            'Initialized app',
            'configuration pool finished in host: 127.0.0.1',
            'Cluster configuration finished',
            'Pool is connected',
            'Cluster connected',
            'Checking hashing in the cluster stopped',
            'Redis disconnected',
            'Check status in pool stopped',
            'pool named 127.0.0.1:' + port + ' closed'
        ]);
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it('stamps the clusterName of its settings on every metric', async () => {
        const collect = registeredSdk();
        const port = await listen();
        const cluster = makeCluster('solo', port, 'silent', appLogger());
        await cluster.connect();
        await cluster.query('SELECT 1');
        const collected = await collect();

        const node = {
            'db.system.name': 'mysql', 'db.client.connection.pool.name': '127.0.0.1:' + port,
            'server.address': '127.0.0.1', 'server.port': port, [CLUSTER]: 'solo'
        };
        const attributes = (name: string) => collected[name].map(point => point.attributes);
        expect(attributes('mysql_dynamic_cluster.query.duration')).toStrictEqual([{
            'db.system.name': 'mysql', [OPERATION]: 'SELECT', [CLUSTER]: 'solo',
            'mysql_dynamic_cluster.result.source': 'pool'
        }]);
        // the status query of the check of connect(), then the query
        const step = { 'db.namespace': 'd', 'mysql_dynamic_cluster.attempt.step': 'statement' };
        expect(attributes('mysql_dynamic_cluster.operation.duration')).toStrictEqual([
            { ...node, ...step, [OPERATION]: 'SHOW' },
            { ...node, ...step, [OPERATION]: 'SELECT' }
        ]);
        expect(attributes('mysql_dynamic_cluster.connection.wait_time')).toStrictEqual([node]);
        expect(attributes('mysql_dynamic_cluster.health_check.duration')).toStrictEqual([{
            ...node, 'mysql_dynamic_cluster.health_check.result': 'valid'
        }]);
        expect(attributes('mysql_dynamic_cluster.connection.count')).toStrictEqual([
            { ...node, 'db.client.connection.state': 'idle' },
            { ...node, 'db.client.connection.state': 'used' }
        ]);
        expect(attributes('mysql_dynamic_cluster.connection.pending_requests'))
            .toStrictEqual([node]);
        expect(attributes('mysql_dynamic_cluster.connection.limit')).toStrictEqual([node]);
        expect(attributes('mysql_dynamic_cluster.node.valid')).toStrictEqual([node]);
        expect(attributes('mysql_dynamic_cluster.node.load_score')).toStrictEqual([node]);
    });
});
