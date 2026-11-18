jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: {
        init: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()
    }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn(), disconnect: jest.fn() }
}));
// a mysql2 pool that opens nothing. Its three lists are the ones Pool.stats() reads. The
// connection it hands out answers the health check with no rows
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => ({
            on: jest.fn(), end: jest.fn(),
            getConnection: jest.fn((cb: any) => cb(null, {
                changeUser: (_o: any, done: any) => done(null),
                query: (_o: any, done: any) => done(null, []),
                release: jest.fn(), destroy: jest.fn()
            })),
            _allConnections: [], _freeConnections: [], _connectionQueue: []
        })),
        createConnection: jest.fn()
    }
}));

import { metrics } from '@opentelemetry/api';
import {
    AggregationTemporality,
    DataPointType,
    InMemoryMetricExporter,
    MeterProvider,
    PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { createPoolCluster } from '../../index';
import Metrics from '../../src/metrics/Metrics';
import { Pool } from '../../src/pool/Pool';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import { Settings } from '../../src/utils/Settings';
import Logger from '../../src/utils/Logger';

interface IPoint { attributes: any, value: any }
interface IMetric {
    unit: string,
    // a sum that is not monotonic is an up-down counter
    dataPointType: DataPointType,
    isMonotonic?: boolean,
    scope: { name: string, version?: string },
    points: IPoint[]
}
interface ICollected { [name: string]: IMetric }

const COUNT = 'mysql_dynamic_cluster.connection.count';
const PENDING = 'mysql_dynamic_cluster.connection.pending_requests';
const LIMIT = 'mysql_dynamic_cluster.connection.limit';
const OPERATION = 'mysql_dynamic_cluster.operation.duration';

// attribute keys
const POOL = 'db.client.connection.pool.name';
const STATE = 'db.client.connection.state';
const CLUSTER = 'mysql_dynamic_cluster.cluster.name';

const { CUMULATIVE, DELTA } = AggregationTemporality;

const sdks: { provider: MeterProvider }[] = [];
const clusters: any[] = [];

// An SDK of the app, read back through an in-memory exporter. Cumulative: every collect
// returns the values as they are. Delta: a collect returns no point for a series that was
// not observed since the collect before, which is how a test sees that reporting stopped
const makeSdk = (temporality: AggregationTemporality = CUMULATIVE) => {
    const exporter = new InMemoryMetricExporter(temporality);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
    const provider = new MeterProvider({ readers: [reader] });
    const collect = async (): Promise<ICollected> => {
        await reader.forceFlush();
        const collected: ICollected = {};
        for (const resourceMetrics of exporter.getMetrics()) {
            for (const scopeMetrics of resourceMetrics.scopeMetrics) {
                for (const metric of scopeMetrics.metrics) {
                    collected[metric.descriptor.name] = {
                        unit: metric.descriptor.unit,
                        dataPointType: metric.dataPointType,
                        isMonotonic: (metric as any).isMonotonic,
                        scope: scopeMetrics.scope,
                        points: metric.dataPoints as any
                    };
                }
            }
        }
        exporter.reset();
        return collected;
    };
    sdks.push({ provider });
    return { provider, reader, collect };
};

// the app registers its SDK, in place of the one before
const register = (sdk: { provider: MeterProvider }) => {
    metrics.disable();
    metrics.setGlobalMeterProvider(sdk.provider);
};

// a registered cumulative SDK
const registeredSdk = () => {
    const sdk = makeSdk();
    register(sdk);
    return sdk;
};

// flags are set, so connect() asks no server. No validators: an answered check is a valid pool
const makePool = (id: number, connectionLimit: number = 5): any => {
    const host = Settings.mixSettings({
        clusterName: 'c1',
        hosts: [{ host: `db${id}.example`, port: 3300 + id, name: `node${id}` }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], connectionLimit,
            validators: [], loadFactors: []
        }
    } as any).hosts[0];
    return new Pool({ id, ...host }, 'c1');
};

// a cluster over these pools, built without the config singletons
const makeCluster = (...pools: any[]): any => {
    const cluster = Object.assign(Object.create(GaleraCluster.prototype), {
        connected: false,
        _pools: pools,
        _useClusterHashing: false,
        _clusterHashing: { stop: jest.fn() }
    });
    clusters.push(cluster);
    return cluster;
};

// the lists of the mysql2 pool: `open` connections, `free` of them idle, `waiting` requests
const setState = (pool: any, state: { open: number, free: number, waiting: number }) => {
    pool._pool._allConnections = new Array(state.open).fill({});
    pool._pool._freeConnections = new Array(state.free).fill({});
    pool._pool._connectionQueue = new Array(state.waiting).fill(() => undefined);
};

// A second connect() of the cluster, while it is connected. The pool's own connect() is
// replaced for it: a second Pool.connect() would leave the timer of the first one running
const connectAgain = async (cluster: any) => {
    cluster.pools.forEach((pool: any) => {
        pool.connect = jest.fn().mockResolvedValue(undefined);
    });
    cluster.connect();
    await cluster.ready;
};

// [pool name, state, value] of every point of a metric, in a fixed order
const rows = (metric?: IMetric): any[][] => (metric ? metric.points : [])
    .map(point => [point.attributes[POOL], point.attributes[STATE], point.value])
    .sort();

const poolWarnings = (): string[] => (Logger.warn as jest.Mock).mock.calls
    .map(call => call[0])
    .filter(message => /Recording a metric failed/.test(message));

beforeEach(() => {
    jest.clearAllMocks();
    Metrics.init('c1');
    // the singleton logs its first failure only
    (Metrics as any)._failureLogged = false;
});

afterEach(async () => {
    for (const cluster of clusters.splice(0)) await cluster.disconnect();
    for (const sdk of sdks.splice(0)) await sdk.provider.shutdown();
    metrics.disable();
});

describe('pool connection metrics', () => {
    it.each([
        [COUNT, '{connection}'],
        [PENDING, '{request}'],
        [LIMIT, '{connection}']
    ])('publishes %s in %s as an up-down counter of the package scope', async (name, unit) => {
        const sdk = registeredSdk();
        await makeCluster(makePool(1)).connect();

        const metric = (await sdk.collect())[name];
        const pkg = require('../../package.json');
        expect(metric.unit).toBe(unit);
        expect(metric.dataPointType).toBe(DataPointType.SUM);
        expect(metric.isMonotonic).toBe(false);
        expect(metric.scope.name).toBe(pkg.name);
        expect(metric.scope.version).toBe(pkg.version);
    });

    it.each([
        ['some idle, some used', { open: 5, free: 3, waiting: 0 }, 3, 2],
        ['all used', { open: 4, free: 0, waiting: 0 }, 0, 4],
        ['all idle', { open: 1, free: 1, waiting: 0 }, 1, 0],
        ['none open', { open: 0, free: 0, waiting: 0 }, 0, 0]
    ])('reports the open connections of a node by state: %s', async (_name, state, idle, used) => {
        const sdk = registeredSdk();
        const pool = makePool(1);
        await makeCluster(pool).connect();
        setState(pool, state);

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', idle], ['node1', 'used', used]]);
    });

    it.each([
        ['four wait', 4],
        ['none waits', 0]
    ])('reports the requests that wait for a connection: %s', async (_name, waiting) => {
        const sdk = registeredSdk();
        const pool = makePool(1);
        await makeCluster(pool).connect();
        setState(pool, { open: 5, free: 0, waiting });

        expect(rows((await sdk.collect())[PENDING])).toEqual([['node1', undefined, waiting]]);
    });

    it('reports connectionLimit as the most connections of a node', async () => {
        const sdk = registeredSdk();
        await makeCluster(makePool(1, 5), makePool(2, 12)).connect();

        const collected = await sdk.collect();
        expect(rows(collected[LIMIT])).toEqual([
            ['node1', undefined, 5], ['node2', undefined, 12]
        ]);
    });

    it('reports no connection.limit point for a node with limit 0, but its counts', async () => {
        const sdk = registeredSdk();
        const cluster = makeCluster(makePool(1, 0), makePool(2, 7));
        await cluster.connect();
        await cluster.ready;

        const collected = await sdk.collect();
        expect(rows(collected[LIMIT])).toEqual([['node2', undefined, 7]]);
        const pools = (metric: IMetric) => rows(metric).map(row => row[0]);
        expect(pools(collected[PENDING])).toEqual(['node1', 'node2']);
        expect(pools(collected[COUNT])).toEqual(['node1', 'node1', 'node2', 'node2']);
    });

    it('reports every node of the cluster with its own values', async () => {
        const sdk = registeredSdk();
        const pools = [makePool(1), makePool(2)];
        const cluster = makeCluster(...pools);
        await cluster.connect();
        await cluster.ready;
        setState(pools[0], { open: 5, free: 3, waiting: 1 });
        setState(pools[1], { open: 2, free: 2, waiting: 6 });

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([
            ['node1', 'idle', 3], ['node1', 'used', 2], ['node2', 'idle', 2], ['node2', 'used', 0]
        ]);
        expect(rows(collected[PENDING])).toEqual([
            ['node1', undefined, 1], ['node2', undefined, 6]
        ]);
    });

    it('reads the pool at every collection', async () => {
        const sdk = registeredSdk();
        const pool = makePool(1);
        await makeCluster(pool).connect();
        setState(pool, { open: 5, free: 3, waiting: 4 });
        await sdk.collect();
        setState(pool, { open: 3, free: 0, waiting: 1 });

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', 0], ['node1', 'used', 3]]);
        expect(rows(collected[PENDING])).toEqual([['node1', undefined, 1]]);
    });
});

describe('attributes of the pool connection metrics', () => {
    const node = {
        'db.system.name': 'mysql',
        [POOL]: 'node1', 'server.address': 'db1.example', 'server.port': 3301
    };
    const attributes = (metric: IMetric) => metric.points
        .map(point => point.attributes)
        .sort((a, b) => String(a[STATE]).localeCompare(String(b[STATE])));

    it('names the system, the pool, its address and the cluster on every point', async () => {
        const sdk = registeredSdk();
        await makeCluster(makePool(1)).connect();

        const collected = await sdk.collect();
        const named = { ...node, [CLUSTER]: 'c1' };
        expect(attributes(collected[PENDING])).toEqual([named]);
        expect(attributes(collected[LIMIT])).toEqual([named]);
        expect(attributes(collected[COUNT])).toEqual([
            { ...named, [STATE]: 'idle' }, { ...named, [STATE]: 'used' }
        ]);
    });

    it('leaves the cluster name out when the cluster has none', async () => {
        const sdk = registeredSdk();
        Metrics.init(undefined);
        await makeCluster(makePool(1)).connect();

        const collected = await sdk.collect();
        expect(attributes(collected[PENDING])).toEqual([node]);
        expect(attributes(collected[LIMIT])).toEqual([node]);
        expect(attributes(collected[COUNT])).toEqual([
            { ...node, [STATE]: 'idle' }, { ...node, [STATE]: 'used' }
        ]);
    });
});

describe('pool connection metrics of a cluster made by createPoolCluster', () => {
    it('carry the pool name, the address and the cluster name of the settings', async () => {
        const sdk = registeredSdk();
        const cluster: any = createPoolCluster({
            clusterName: 'orders',
            hosts: [{ host: 'db1.example', port: 3311, connectionLimit: 8 }],
            defaultPoolSettings: { flags: [], validators: [], loadFactors: [] },
            useClusterHashing: false
        } as any);
        clusters.push(cluster);
        await cluster.connect();

        const point = (await sdk.collect())[LIMIT].points[0];
        expect(point.value).toBe(8);
        expect(point.attributes).toEqual({
            'db.system.name': 'mysql',
            [POOL]: 'db1.example:3311', 'server.address': 'db1.example', 'server.port': 3311,
            [CLUSTER]: 'orders'
        });
    });
});

describe('pool connection metrics over connect() and disconnect()', () => {
    it('reports zeros and the limit for a pool that is not connected yet', async () => {
        const sdk = registeredSdk();
        const pool = makePool(1);
        // still asks the server for its version: no mysql2 pool yet
        pool.connect = () => new Promise(() => undefined);
        makeCluster(pool).connect();

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', 0], ['node1', 'used', 0]]);
        expect(rows(collected[PENDING])).toEqual([['node1', undefined, 0]]);
        expect(rows(collected[LIMIT])).toEqual([['node1', undefined, 5]]);
    });

    it('reports nothing after disconnect(), and reads the pools no more', async () => {
        const sdk = makeSdk(DELTA);
        register(sdk);
        const pool = makePool(1);
        const cluster = makeCluster(pool);
        await cluster.connect();
        const before = Object.keys(await sdk.collect());
        expect(before).toEqual(expect.arrayContaining([COUNT, PENDING, LIMIT]));
        await cluster.disconnect();
        const stats = jest.spyOn(pool, 'stats');

        const collected = await sdk.collect();
        expect(collected[COUNT]).toBeUndefined();
        expect(collected[PENDING]).toBeUndefined();
        expect(collected[LIMIT]).toBeUndefined();
        expect(stats).not.toHaveBeenCalled();
    });

    it('reads a pool once per collection after a second connect()', async () => {
        const sdk = registeredSdk();
        const pool = makePool(1);
        const cluster = makeCluster(pool);
        await cluster.connect();
        await connectAgain(cluster);
        setState(pool, { open: 5, free: 3, waiting: 4 });
        const stats = jest.spyOn(pool, 'stats');

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', 3], ['node1', 'used', 2]]);
        expect(stats).toHaveBeenCalledTimes(1);
    });

    it('reports nothing after two connect() calls and one disconnect()', async () => {
        const sdk = makeSdk(DELTA);
        register(sdk);
        const cluster = makeCluster(makePool(1));
        await cluster.connect();
        await connectAgain(cluster);
        expect(rows((await sdk.collect())[COUNT])).toHaveLength(2);
        await cluster.disconnect();

        expect((await sdk.collect())[COUNT]).toBeUndefined();
    });

    it('reports again after disconnect() and a new connect()', async () => {
        const sdk = registeredSdk();
        const pool = makePool(1);
        const cluster = makeCluster(pool);
        await cluster.connect();
        await cluster.disconnect();
        await cluster.connect();
        setState(pool, { open: 2, free: 1, waiting: 0 });

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', 1], ['node1', 'used', 1]]);
    });

    it('keeps the pools of a connected cluster when another one disconnects', async () => {
        const sdk = makeSdk(DELTA);
        register(sdk);
        const gone = makeCluster(makePool(1));
        await gone.connect();
        await makeCluster(makePool(2)).connect();
        await gone.disconnect();

        expect(rows((await sdk.collect())[PENDING])).toEqual([['node2', undefined, 0]]);
    });
});

describe('pool connection metrics and the MeterProvider of the app', () => {
    it('reach a provider registered after connect(), at the next health check', async () => {
        const pool = makePool(1);
        await makeCluster(pool).connect();
        setState(pool, { open: 5, free: 3, waiting: 4 });
        const sdk = registeredSdk();

        await pool.status.checkStatus();

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', 3], ['node1', 'used', 2]]);
        expect(rows(collected[PENDING])).toEqual([['node1', undefined, 4]]);
        expect(rows(collected[LIMIT])).toEqual([['node1', undefined, 5]]);
    });

    it('reach a provider registered after connect(), at the next record', async () => {
        await makeCluster(makePool(1)).connect();
        const sdk = registeredSdk();

        Metrics.recordCacheLookup(0.01, 'miss');

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node1', 'idle', 0], ['node1', 'used', 0]]);
    });

    it('leave a provider that was replaced: no point there, no read of the pools', async () => {
        const first = makeSdk(DELTA);
        register(first);
        const pool = makePool(1);
        await makeCluster(pool).connect();
        expect(rows((await first.collect())[COUNT])).toHaveLength(2);
        const second = registeredSdk();
        await pool.status.checkStatus();
        const stats = jest.spyOn(pool, 'stats');

        expect((await first.collect())[COUNT]).toBeUndefined();
        expect(stats).not.toHaveBeenCalled();
        expect(rows((await second.collect())[COUNT])).toHaveLength(2);
    });
});

describe('a pool that cannot be read', () => {
    const throwing = (pool: any) => { pool.stats = () => { throw new Error('stats broke'); }; };
    const missing = (pool: any) => { pool.stats = undefined; };

    it.each([
        ['whose stats() throws', throwing, 'stats broke'],
        ['that lost its stats()', missing, 'stats is not a function']
    ])('is skipped, one %s, and the collection goes on', async (_name, breakIt, reason) => {
        const sdk = registeredSdk();
        const pools = [makePool(1), makePool(2)];
        const cluster = makeCluster(...pools);
        await cluster.connect();
        await cluster.ready;
        breakIt(pools[0]);

        const collected = await sdk.collect();
        expect(rows(collected[COUNT])).toEqual([['node2', 'idle', 0], ['node2', 'used', 0]]);
        expect(rows(collected[LIMIT])).toEqual([['node2', undefined, 5]]);
        expect(collected[OPERATION].points).toHaveLength(2);
        expect((await sdk.reader.collect()).errors).toEqual([]);
        expect(poolWarnings()).toHaveLength(1);
        expect(poolWarnings()[0]).toContain(reason);
    });
});

describe('Metrics.registerPools and unregisterPools', () => {
    const onePool = { stats: () => ({ used: 0, idle: 0, pending: 0 }) };

    it.each([
        ['registerPools', 'no argument', undefined],
        ['registerPools', 'null', null],
        ['registerPools', 'a pool outside a list', onePool],
        ['registerPools', 'a number', 5],
        ['unregisterPools', 'no argument', undefined],
        ['unregisterPools', 'a string', 'node1']
    ])('%s takes %s without throwing, and logs the argument', async (method, _name, pools) => {
        const sdk = registeredSdk();

        expect(() => (Metrics as any)[method](pools)).not.toThrow();

        expect(poolWarnings()).toHaveLength(1);
        expect(poolWarnings()[0]).toContain(method + ': pools must be an array');
        expect((await sdk.collect())[COUNT]).toBeUndefined();
    });

    it('take an empty list: nothing is reported and nothing is logged', async () => {
        const sdk = registeredSdk();

        Metrics.registerPools([]);
        Metrics.unregisterPools([]);

        expect((await sdk.collect())[COUNT]).toBeUndefined();
        expect(poolWarnings()).toEqual([]);
    });

    it('unregisterPools leaves out a pool that was never registered', async () => {
        const sdk = registeredSdk();
        await makeCluster(makePool(1)).connect();

        Metrics.unregisterPools([makePool(2)]);

        expect(rows((await sdk.collect())[PENDING])).toEqual([['node1', undefined, 0]]);
        expect(poolWarnings()).toEqual([]);
    });
});
