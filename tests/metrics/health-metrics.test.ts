jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn(), disconnect: jest.fn() }
}));
// a mysql2 pool that opens nothing. Until a test says otherwise, the connection it hands out
// answers the status query with a node that is ready and has seen 7 connections
jest.mock('mysql2', () => ({
    __esModule: true,
    default: {
        createPool: jest.fn(() => ({
            on: jest.fn(), end: jest.fn(),
            getConnection: jest.fn((cb: any) => cb(null, {
                changeUser: (_o: any, done: any) => done(null),
                query: (_o: any, done: any) => done(null, [
                    { Variable_name: 'wsrep_ready', Value: 'ON' },
                    { Variable_name: 'Connections', Value: '7' }
                ]),
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
import Metrics from '../../src/metrics/Metrics';
import { Pool } from '../../src/pool/Pool';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import { Settings } from '../../src/utils/Settings';
import Logger from '../../src/utils/Logger';

type Cb = (err: any, res?: any) => void;

interface IPoint { attributes: any, value: any }
interface IMetric {
    unit: string,
    dataPointType: DataPointType,
    scope: { name: string, version?: string },
    points: IPoint[]
}
interface ICollected { [name: string]: IMetric }

const HEALTH = 'mysql_dynamic_cluster.health_check.duration';
const VALID = 'mysql_dynamic_cluster.node.valid';
const LOAD = 'mysql_dynamic_cluster.node.load_score';
const OPERATION = 'mysql_dynamic_cluster.operation.duration';
const CACHE = 'mysql_dynamic_cluster.cache.lookup.duration';
const COUNT = 'mysql_dynamic_cluster.connection.count';

// attribute keys
const RESULT = 'mysql_dynamic_cluster.health_check.result';
const POOL = 'db.client.connection.pool.name';
const CLUSTER = 'mysql_dynamic_cluster.cluster.name';

// the attributes of node 1, on every point of the health-check metric and of the node gauges
const NODE = {
    'db.system.name': 'mysql',
    [POOL]: 'node1', 'server.address': 'db1.example', 'server.port': 3301,
    [CLUSTER]: 'c1'
};

const CHECK_TIMEOUT = 1000;
const { CUMULATIVE, DELTA } = AggregationTemporality;

const sdks: { provider: MeterProvider }[] = [];
const spies: jest.SpyInstance[] = [];
const pools: any[] = [];
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

// An SDK of the app whose meters throw from one method, for every name or for one
const brokenSdk = (method: string, onlyName?: string) => {
    const sdk = makeSdk();
    const getMeter = (name: string, version?: string) => {
        const meter: any = sdk.provider.getMeter(name, version);
        const refuse = (metric: string, options: any) => {
            if (onlyName && metric !== onlyName) return meter[method](metric, options);
            throw new Error('not on this meter');
        };
        return Object.create(meter, { [method]: { value: refuse } });
    };
    return { ...sdk, provider: { getMeter } as any };
};

// flags are set, so connect() asks no server. Valid when wsrep_ready is ON, and the load
// score is twice the Connections value
const makePool = (id: number = 1): any => {
    const host = Settings.mixSettings({
        clusterName: 'c1',
        hosts: [{ host: `db${id}.example`, port: 3300 + id, name: `node${id}` }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], queryTimeout: CHECK_TIMEOUT,
            validators: [{ key: 'wsrep_ready', operator: '=', value: 'ON' }],
            loadFactors: [{ key: 'Connections', multiplier: 2 }],
            timerCheckRange: { start: CHECK_TIMEOUT, end: 10000 }
        }
    } as any).hosts[0];
    const pool = new Pool({ id, ...host }, 'c1');
    pools.push(pool);
    return pool;
};

// a pool that connected, with its first check answered
const connectedPool = async (id: number = 1): Promise<any> => {
    const pool = makePool(id);
    await pool.connect();
    return pool;
};

// a cluster over these pools, built without the config singletons
const makeCluster = (...ofPools: any[]): any => {
    const cluster = Object.assign(Object.create(GaleraCluster.prototype), {
        connected: false,
        _pools: ofPools,
        _useClusterHashing: false,
        _clusterHashing: { stop: jest.fn() }
    });
    clusters.push(cluster);
    return cluster;
};

// a cluster that connected, every pool with its first check answered
const connectedCluster = async (...ofPools: any[]): Promise<any> => {
    const cluster = makeCluster(...ofPools);
    await cluster.connect();
    await cluster.ready;
    return cluster;
};

const status = (ready: string, connections: number) => [
    { Variable_name: 'wsrep_ready', Value: ready },
    { Variable_name: 'Connections', Value: String(connections) }
];

// from now on the status query of the pool is answered with these rows
const answers = (pool: any, rows: object[]) => {
    pool._pool.getConnection.mockImplementation((cb: Cb) => cb(null, {
        changeUser: (_o: any, done: Cb) => done(null),
        query: (_o: any, done: Cb) => done(null, rows),
        release: jest.fn(), destroy: jest.fn()
    }));
};

// from now on the status query of the pool fails with this error
const fails = (pool: any, error: any) => {
    pool._pool.getConnection.mockImplementation((cb: Cb) => cb(null, {
        changeUser: (_o: any, done: Cb) => done(null),
        query: (_o: any, done: Cb) => done(error),
        release: jest.fn(), destroy: jest.fn()
    }));
};

// from now on the pool gets no connection: mysql2 hands the error to getConnection
const refuses = (pool: any, error: any) => {
    pool._pool.getConnection.mockImplementation((cb: Cb) => cb(error));
};

const coded = (fields: object) => Object.assign(new Error('from the server'), fields);

// number of records behind every series of a histogram
const counts = (metric?: IMetric): number[] => (metric ? metric.points : [])
    .map(point => point.value.count);

// [pool name, value] of every point of a gauge, in a fixed order
const rows = (metric?: IMetric): any[][] => (metric ? metric.points : [])
    .map(point => [point.attributes[POOL], point.value])
    .sort();

const metricWarnings = (): string[] => (Logger.warn as jest.Mock).mock.calls
    .map(call => call[0])
    .filter(message => /Recording a metric failed/.test(message));

beforeEach(() => {
    jest.clearAllMocks();
    Metrics.init('c1');
    // the singleton logs its first failure only
    (Metrics as any)._failureLogged = false;
});

afterEach(async () => {
    jest.useRealTimers();
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const cluster of clusters.splice(0)) await cluster.disconnect();
    for (const pool of pools.splice(0)) pool.disconnect();
    for (const sdk of sdks.splice(0)) await sdk.provider.shutdown();
    metrics.disable();
});

describe('mysql_dynamic_cluster.health_check.duration', () => {
    it('is a histogram in seconds with the duration buckets, of the package scope', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        const pkg = require('../../package.json');
        expect(health.unit).toBe('s');
        expect(health.dataPointType).toBe(DataPointType.HISTOGRAM);
        expect(health.points[0].value.buckets.boundaries)
            .toEqual([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]);
        expect(health.scope).toMatchObject({ name: pkg.name, version: pkg.version });
    });

    it.each([
        ['valid', 'the validator passed', status('ON', 7)],
        ['invalid', 'the validator said no', status('OFF', 7)],
        ['invalid', 'the status has no row for the validator', status('ON', 7).slice(1)]
    ])('records %s when the status query ran and %s', async (result, _name, statusRows) => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        answers(pool, statusRows);
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        expect(counts(health)).toEqual([1]);
        expect(health.points[0].attributes).toStrictEqual({ ...NODE, [RESULT]: result });
    });

    const withCode = { 'error.type': 'ER_ACCESS_DENIED_ERROR', 'db.response.status_code': '1045' };
    it.each([
        ['the query failed with a code and an errno',
            (pool: any) => fails(pool, coded({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 })),
            withCode],
        ['no connection came, with a code and an errno',
            (pool: any) => refuses(pool, coded({ code: 'ECONNREFUSED', errno: -111 })),
            { 'error.type': 'ECONNREFUSED', 'db.response.status_code': '-111' }],
        ['the error has a code and no errno',
            (pool: any) => fails(pool, coded({ code: 'PROTOCOL_CONNECTION_LOST' })),
            { 'error.type': 'PROTOCOL_CONNECTION_LOST' }],
        ['the error has an errno and no code',
            (pool: any) => fails(pool, coded({ errno: 1205 })),
            { 'error.type': '_OTHER', 'db.response.status_code': '1205' }],
        ['the error has an empty code',
            (pool: any) => fails(pool, coded({ code: '' })),
            { 'error.type': '_OTHER' }]
    ])('records error with what the check failed with: %s', async (_name, arrange, failure) => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        arrange(pool);
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        expect(counts(health)).toEqual([1]);
        expect(health.points[0].attributes)
            .toStrictEqual({ ...NODE, [RESULT]: 'error', ...failure });
    });

    const thrownAfterTheAnswer = (pool: any) => {
        const failure = coded({ code: 'ER_NOT_OF_THE_SERVER', errno: 9999 });
        pool.status._validator.check = () => { throw failure; };
    };
    const failedByTheApp = (pool: any) => {
        pool._pool.getConnection.mockImplementation((cb: Cb) => {
            pool._pool._connectionQueue.push(cb);
            pool.failWaiting(coded({ code: 'APP_DRAINS_THE_NODE', errno: 7 }));
        });
    };
    it.each([
        ['a mysql2 pool that does not exist yet', (pool: any) => { pool._pool = undefined; }],
        ['an error thrown after the answer came', thrownAfterTheAnswer],
        ['the error the app failed the waiting check with', failedByTheApp]
    ])('records error with _OTHER and no status code for %s', async (_name, arrange) => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        arrange(pool);
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        expect(counts(health)).toEqual([1]);
        expect(health.points[0].attributes)
            .toStrictEqual({ ...NODE, [RESULT]: 'error', 'error.type': '_OTHER' });
    });

    it('records error with _OTHER for the timeout of the check itself', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        pool.query = () => new Promise(() => undefined);
        jest.useFakeTimers();
        const check = pool.status.checkStatus();
        jest.advanceTimersByTime(CHECK_TIMEOUT);
        await check;
        jest.useRealTimers();

        const health = (await sdk.collect())[HEALTH];
        expect(counts(health)).toEqual([1]);
        expect(health.points[0].attributes)
            .toStrictEqual({ ...NODE, [RESULT]: 'error', 'error.type': '_OTHER' });
    });

    it('leaves the cluster name out when the cluster has none', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        Metrics.init(undefined);
        await pool.status.checkStatus();

        const { [CLUSTER]: _left, ...unnamed } = NODE;
        expect((await sdk.collect())[HEALTH].points[0].attributes)
            .toStrictEqual({ ...unnamed, [RESULT]: 'valid' });
    });

    it('records the time the check took, as the status keeps it', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        pool.query = jest.fn().mockResolvedValue(status('ON', 7));
        // the check reads the clock when it starts and when it ends
        const clock = jest.spyOn(Date.prototype, 'getTime');
        spies.push(clock.mockReturnValueOnce(1000).mockReturnValueOnce(3500));
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        expect(pool.status.queryTime).toBe(2.5);
        expect(health.points[0].value.sum).toBe(2.5);
    });

    it('records one series per result, and every check once', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        await pool.status.checkStatus();
        await pool.status.checkStatus();
        answers(pool, status('OFF', 7));
        await pool.status.checkStatus();
        fails(pool, coded({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 }));
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        const byResult = health.points.map(point => [point.attributes[RESULT], point.value.count]);
        expect(byResult.sort()).toEqual([['error', 1], ['invalid', 1], ['valid', 2]]);
    });

    it('records a check once, as an error, when a step after its answer throws', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        const broke = () => { throw new Error('timer broke'); };
        spies.push(jest.spyOn(pool.status._timer, 'start').mockImplementationOnce(broke));
        await pool.status.checkStatus();

        const health = (await sdk.collect())[HEALTH];
        expect(counts(health)).toEqual([1]);
        expect(health.points[0].attributes)
            .toStrictEqual({ ...NODE, [RESULT]: 'error', 'error.type': '_OTHER' });
    });

    it('leaves the check counted as a SHOW operation of the pool too', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        await pool.status.checkStatus();

        const collected = await sdk.collect();
        expect(counts(collected[HEALTH])).toEqual([1]);
        expect(counts(collected[OPERATION])).toEqual([1]);
        expect(collected[OPERATION].points[0].attributes['db.operation.name']).toBe('SHOW');
    });
});

describe('a check that records no health-check metric', () => {
    // the provider is live: the cache lookup is recorded, the check is not
    const expectNoHealthRecord = async (sdk: { collect: () => Promise<ICollected> }) => {
        Metrics.recordCacheLookup(0.01, 'miss');
        const collected = await sdk.collect();
        expect(counts(collected[CACHE])).toEqual([1]);
        expect(collected[HEALTH]).toBeUndefined();
    };

    it.each([
        ['answered', (settle: { resolve: Cb, reject: Cb }) => settle.resolve(status('ON', 7))],
        ['failed', (settle: { resolve: Cb, reject: Cb }) => settle.reject(coded({ code: 'X' }))]
    ])('is one that was %s after stopTimerCheck()', async (_name, end) => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        const settle: any = {};
        pool.query = () => new Promise((resolve, reject) => {
            Object.assign(settle, { resolve, reject });
        });
        const check = pool.status.checkStatus();
        pool.status.stopTimerCheck();
        end(settle);
        await check;

        await expectNoHealthRecord(sdk);
    });

    it('is one of a status that is not active', async () => {
        const pool = await connectedPool();
        const sdk = registeredSdk();
        pool.status.active = false;
        await pool.status.checkStatus();

        await expectNoHealthRecord(sdk);
    });

    it('is one of a pool that never connected', async () => {
        const sdk = registeredSdk();
        await makePool().status.checkStatus();

        await expectNoHealthRecord(sdk);
    });
});

describe('a health check when the metric cannot be recorded', () => {
    it('still ends as valid when the provider throws', async () => {
        const pool = await connectedPool();
        const broken = () => { throw new Error('broken sdk'); };
        spies.push(jest.spyOn(metrics, 'getMeterProvider').mockImplementation(broken));

        await expect(pool.status.checkStatus()).resolves.toBeUndefined();

        expect(pool.status.isValid).toBe(true);
        expect(pool.status.checkError).toBeUndefined();
        expect(metricWarnings()).toHaveLength(1);
    });

    it('keeps the other metrics when the provider cannot make the histogram', async () => {
        const sdk = brokenSdk('createHistogram', HEALTH);
        register(sdk);
        const pool = makePool();
        await expect(connectedCluster(pool)).resolves.toBeDefined();

        const collected = await sdk.collect();
        expect(pool.status.isValid).toBe(true);
        expect(collected[HEALTH]).toBeUndefined();
        expect(counts(collected[OPERATION])).toEqual([1]);
        expect(rows(collected[VALID])).toEqual([['node1', 1]]);
        expect(collected[COUNT].points).toHaveLength(2);
        expect(metricWarnings()).toEqual([expect.stringContaining('not on this meter')]);
    });

    it('keeps the record that finds a provider that cannot make the histogram', async () => {
        const pool = await connectedPool();
        const sdk = brokenSdk('createHistogram', HEALTH);
        register(sdk);

        Metrics.recordCacheLookup(0.01, 'miss');
        await pool.status.checkStatus();

        const collected = await sdk.collect();
        expect(counts(collected[CACHE])).toEqual([1]);
        expect(counts(collected[OPERATION])).toEqual([1]);
        expect(collected[HEALTH]).toBeUndefined();
        expect(pool.status.isValid).toBe(true);
    });
});

describe('the node gauges', () => {
    it.each([
        [VALID],
        [LOAD]
    ])('publishes %s as a gauge with no unit, of the package scope', async (name) => {
        const sdk = registeredSdk();
        await connectedCluster(makePool());

        const gauge = (await sdk.collect())[name];
        const pkg = require('../../package.json');
        expect(gauge.unit).toBe('');
        expect(gauge.dataPointType).toBe(DataPointType.GAUGE);
        expect(gauge.scope).toMatchObject({ name: pkg.name, version: pkg.version });
    });

    it('carry the attributes of the node and no other', async () => {
        const sdk = registeredSdk();
        await connectedCluster(makePool());

        const collected = await sdk.collect();
        expect(collected[VALID].points.map(point => point.attributes)).toStrictEqual([NODE]);
        expect(collected[LOAD].points.map(point => point.attributes)).toStrictEqual([NODE]);
    });

    it('leave the cluster name out when the cluster has none', async () => {
        const sdk = registeredSdk();
        Metrics.init(undefined);
        await connectedCluster(makePool());

        const { [CLUSTER]: _left, ...unnamed } = NODE;
        const collected = await sdk.collect();
        expect(collected[VALID].points.map(point => point.attributes)).toStrictEqual([unnamed]);
        expect(collected[LOAD].points.map(point => point.attributes)).toStrictEqual([unnamed]);
    });

    it('report 1 and the load score of the last check for a valid node', async () => {
        const sdk = registeredSdk();
        await connectedCluster(makePool());

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node1', 1]]);
        expect(rows(collected[LOAD])).toEqual([['node1', 14]]);
    });

    it('report every node of the cluster with its own values', async () => {
        const sdk = registeredSdk();
        const [first, second] = [makePool(1), makePool(2)];
        await connectedCluster(first, second);
        answers(second, status('OFF', 30));
        await second.status.checkStatus();

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node1', 1], ['node2', 0]]);
        expect(rows(collected[LOAD])).toEqual([['node1', 14], ['node2', 60]]);
    });

    it('keep a node valid after one failed check, and report 0 after the second', async () => {
        const sdk = registeredSdk();
        const pool = makePool();
        await connectedCluster(pool);
        fails(pool, coded({ code: 'ECONNRESET' }));

        await pool.status.checkStatus();
        expect(rows((await sdk.collect())[VALID])).toEqual([['node1', 1]]);

        await pool.status.checkStatus();
        expect(rows((await sdk.collect())[VALID])).toEqual([['node1', 0]]);
    });

    it('report 1 again once a check passed, and the load score it read', async () => {
        const sdk = registeredSdk();
        const pool = makePool();
        await connectedCluster(pool);
        answers(pool, status('OFF', 7));
        await pool.status.checkStatus();
        answers(pool, status('ON', 50));
        await pool.status.checkStatus();

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node1', 1]]);
        expect(rows(collected[LOAD])).toEqual([['node1', 100]]);
    });

    it('keep the load score of the last answered check after a failed one', async () => {
        const sdk = registeredSdk();
        const pool = makePool();
        await connectedCluster(pool);
        fails(pool, coded({ code: 'ECONNRESET' }));
        await pool.status.checkStatus();

        expect(rows((await sdk.collect())[LOAD])).toEqual([['node1', 14]]);
    });

    it('report 0 and the score a status starts with for a node never checked', async () => {
        const sdk = registeredSdk();
        const pool = makePool();
        // still asks the server for its version: no mysql2 pool and no check yet
        pool.connect = () => new Promise(() => undefined);
        makeCluster(pool).connect();

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node1', 0]]);
        expect(rows(collected[LOAD])).toEqual([['node1', 100000]]);
    });

    it('report nothing after disconnect()', async () => {
        const sdk = makeSdk(DELTA);
        register(sdk);
        const cluster = await connectedCluster(makePool());
        const before = Object.keys(await sdk.collect());
        expect(before).toEqual(expect.arrayContaining([VALID, LOAD]));
        await cluster.disconnect();

        const collected = await sdk.collect();
        expect(collected[VALID]).toBeUndefined();
        expect(collected[LOAD]).toBeUndefined();
    });
});

describe('the node gauges and the MeterProvider of the app', () => {
    it('reach a provider registered after connect(), at the next health check', async () => {
        const pool = makePool();
        await connectedCluster(pool);
        const sdk = registeredSdk();

        await pool.status.checkStatus();

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node1', 1]]);
        expect(rows(collected[LOAD])).toEqual([['node1', 14]]);
    });

    it('leave a provider that was replaced', async () => {
        const first = makeSdk(DELTA);
        register(first);
        const pool = makePool();
        await connectedCluster(pool);
        expect(rows((await first.collect())[VALID])).toEqual([['node1', 1]]);
        const second = registeredSdk();
        await pool.status.checkStatus();

        expect((await first.collect())[VALID]).toBeUndefined();
        expect(rows((await second.collect())[VALID])).toEqual([['node1', 1]]);
    });

    it('are left out by a provider that cannot make gauges, which keeps the rest', async () => {
        const sdk = brokenSdk('createObservableGauge');
        register(sdk);
        await expect(connectedCluster(makePool())).resolves.toBeDefined();

        const collected = await sdk.collect();
        expect(collected[VALID]).toBeUndefined();
        expect(collected[LOAD]).toBeUndefined();
        expect(counts(collected[OPERATION])).toEqual([1]);
        expect(counts(collected[HEALTH])).toEqual([1]);
        expect(collected[COUNT].points).toHaveLength(2);
        expect(metricWarnings()).toEqual([expect.stringContaining('not on this meter')]);
    });

    it('do not cost the record that finds a provider that cannot make gauges', async () => {
        await connectedCluster(makePool());
        const sdk = brokenSdk('createObservableGauge');
        register(sdk);

        Metrics.recordCacheLookup(0.01, 'miss');

        const collected = await sdk.collect();
        expect(counts(collected[CACHE])).toEqual([1]);
        expect(collected[COUNT].points).toHaveLength(2);
        expect(collected[VALID]).toBeUndefined();
    });
});

describe('a node whose state cannot be read', () => {
    const noState = (pool: any) => {
        const broke = () => { throw new Error('status broke'); };
        Object.defineProperty(pool.status, 'isValid', { get: broke });
    };

    it('is left out of the gauges, and the collection goes on', async () => {
        const sdk = registeredSdk();
        const [broken, healthy] = [makePool(1), makePool(2)];
        await connectedCluster(broken, healthy);
        noState(broken);

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node2', 1]]);
        expect(rows(collected[LOAD])).toEqual([['node2', 14]]);
        expect((await sdk.reader.collect()).errors).toEqual([]);
        expect(metricWarnings()).toHaveLength(1);
    });

    it('still reports its connection metrics', async () => {
        const sdk = registeredSdk();
        const broken = makePool();
        await connectedCluster(broken);
        noState(broken);

        const collected = await sdk.collect();
        expect(collected[COUNT].points).toHaveLength(2);
        expect(collected[VALID]).toBeUndefined();
    });

    it('still reports the gauges of a node whose connection counts cannot be read', async () => {
        const sdk = registeredSdk();
        const pool = makePool();
        await connectedCluster(pool);
        pool.stats = () => { throw new Error('stats broke'); };

        const collected = await sdk.collect();
        expect(rows(collected[VALID])).toEqual([['node1', 1]]);
        expect(collected[COUNT]).toBeUndefined();
    });
});
