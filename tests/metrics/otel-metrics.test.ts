jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));

import { metrics } from '@opentelemetry/api';
import {
    AggregationTemporality,
    InMemoryMetricExporter,
    MeterProvider,
    PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import Metrics, { MetricsClass } from '../../src/metrics/Metrics';
import { Pool } from '../../src/pool/Pool';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Redis from '../../src/Redis/Redis';
import Logger from '../../src/utils/Logger';

type Cb = (err: any, res?: any) => void;

interface IPoint { attributes: any, value: { count: number, sum: number, buckets: { boundaries: number[] } } }
interface ICollected { [name: string]: { unit: string, scope: { name: string, version?: string }, points: IPoint[] } }

const OPERATION = 'mysql_dynamic_cluster.operation.duration';
const QUERY = 'mysql_dynamic_cluster.query.duration';
const CACHE = 'mysql_dynamic_cluster.cache.lookup.duration';

// attribute keys
const SOURCE = 'mysql_dynamic_cluster.result.source';
const CACHE_RESULT = 'mysql_dynamic_cluster.cache.result';
const SERVICE = 'mysql_dynamic_cluster.service.name';
const CLUSTER = 'mysql_dynamic_cluster.cluster.name';

// delta temporality: every collect returns only what was recorded since the previous one
const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
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
                    scope: scopeMetrics.scope,
                    points: metric.dataPoints as any
                };
            }
        }
    }
    exporter.reset();
    return collected;
};

// number of records behind every series of a metric: 1 each when nothing was recorded twice
const counts = (collected: ICollected, name: string): number[] =>
    collected[name] ? collected[name].points.map(point => point.value.count) : [];

const makeConn = (opts: { queryErr?: any, rows?: any } = {}) => ({
    changeUser: jest.fn((_o: any, cb: Cb) => cb(null)),
    query: jest.fn((_o: any, cb: Cb) => cb(opts.queryErr ?? null, opts.rows)),
    release: jest.fn(),
    destroy: jest.fn()
});

const makePool = (conn: any, id: number = 1): Pool => {
    const pool = new Pool({
        id, host: `10.0.0.${id}`, port: 3307, name: `node${id}`,
        user: 'u', password: 'p', database: 'd',
        queryTimeout: 1000, slowQueryTime: 1000, redisFactor: 1, redisExpire: 1,
        connectionLimit: 10, minConnections: 0, idleTimeout: 30000, idleCheckInterval: 10000,
        validators: [], loadFactors: [], timerCheckRange: { start: 1000, end: 10000 }, timerCheckMultiplier: 2
    } as any, 'c1');
    (pool as any)._pool = { getConnection: jest.fn((cb: Cb) => cb(null, conn)) };
    (pool.status as any)._isValid = true;
    return pool;
};

// a cluster over one pool, built without the config singletons
const makeCluster = (...pools: Pool[]): GaleraCluster => Object.assign(Object.create(GaleraCluster.prototype), {
    _pools: pools,
    _useRedis: true,
    _errorRetryCount: pools.length,
    _clusterName: 'c1',
    _nullServiceName: 'mdc',
    _clusterHashing: { connected: false }
});

const accessDenied = Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 });

describe('OpenTelemetry metrics', () => {
    beforeAll(async () => {
        Metrics.init('c1');
        // recorded before the app registered its SDK: a no-op that must not pin no-op instruments
        Metrics.recordCacheLookup(0.01, 'miss');
        metrics.setGlobalMeterProvider(provider);
    });

    afterAll(async () => {
        await provider.shutdown();
        metrics.disable();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        await collect();
    });

    it('records once the app registers its MeterProvider, even after earlier no-op records', async () => {
        Metrics.recordCacheLookup(0.02, 'hit');

        const collected = await collect();
        expect(collected[CACHE].points).toHaveLength(1);
        expect(collected[CACHE].points[0].value.count).toBe(1);
        expect(collected[CACHE].unit).toBe('s');
        expect(collected[CACHE].points[0].attributes).toEqual({
            [CACHE_RESULT]: 'hit',
            [CLUSTER]: 'c1'
        });
    });

    it('uses the package name and version as the instrumentation scope', async () => {
        Metrics.recordCacheLookup(0.02, 'hit');

        const { scope } = (await collect())[CACHE];
        const pkg = require('../../package.json');
        expect(scope.name).toBe(pkg.name);
        expect(scope.version).toBe(pkg.version);
    });

    it('records a successful pool query as mysql_dynamic_cluster.operation.duration', async () => {
        await makePool(makeConn({ rows: [{ a: 1 }] })).query('SELECT 1', { serviceId: 7, serviceName: 'billing' });

        const collected = await collect();
        expect(Object.keys(collected)).toEqual([OPERATION]);
        expect(collected[OPERATION].unit).toBe('s');
        expect(collected[OPERATION].points).toHaveLength(1);
        expect(collected[OPERATION].points[0].value.count).toBe(1);
        expect(collected[OPERATION].points[0].value.buckets.boundaries)
            .toEqual([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]);
        expect(collected[OPERATION].points[0].attributes).toEqual({
            'db.system.name': 'mysql',
            'db.namespace': 'd',
            'db.operation.name': 'SELECT',
            'server.address': '10.0.0.1',
            'server.port': 3307,
            'db.client.connection.pool.name': 'node1',
            [CLUSTER]: 'c1',
            [SERVICE]: 'billing'
        });
    });

    it('adds error.type and the status code to a failed pool query', async () => {
        await expect(makePool(makeConn({ queryErr: accessDenied })).query('UPDATE t SET a = 1', { database: 'other' }))
            .rejects.toBe(accessDenied);

        const collected = await collect();
        expect(counts(collected, OPERATION)).toEqual([1]);
        const { attributes } = collected[OPERATION].points[0];
        expect(attributes).toEqual({
            'db.system.name': 'mysql',
            'db.namespace': 'other',
            'db.operation.name': 'UPDATE',
            'error.type': 'ER_ACCESS_DENIED_ERROR',
            'db.response.status_code': '1045',
            'server.address': '10.0.0.1',
            'server.port': 3307,
            'db.client.connection.pool.name': 'node1',
            [CLUSTER]: 'c1'
        });
    });

    it('uses _OTHER as error.type when the error has no code', async () => {
        await expect(makePool(makeConn({ queryErr: new Error('odd') })).query('SELECT 1')).rejects.toThrow('odd');

        const { attributes } = (await collect())[OPERATION].points[0];
        expect(attributes['error.type']).toBe('_OTHER');
        expect(attributes['db.response.status_code']).toBeUndefined();
    });

    it('records a transaction once, without an operation name', async () => {
        await makePool(makeConn({ rows: [] })).multiStatementQuery(['INSERT INTO t VALUES (1)', 'DELETE FROM t'], {});

        const collected = await collect();
        expect(collected[OPERATION].points).toHaveLength(1);
        expect(collected[OPERATION].points[0].value.count).toBe(1);
        expect(collected[OPERATION].points[0].attributes['db.operation.name']).toBeUndefined();
        expect(collected[OPERATION].points[0].attributes['error.type']).toBeUndefined();
    });

    it('records a failed transaction once, with its error.type', async () => {
        const conn = makeConn({ queryErr: accessDenied });
        await expect(makePool(conn).multiStatementQuery(['INSERT INTO t VALUES (1)'], {})).rejects.toBe(accessDenied);

        const collected = await collect();
        expect(counts(collected, OPERATION)).toEqual([1]);
        expect(collected[OPERATION].points[0].attributes['error.type']).toBe('ER_ACCESS_DENIED_ERROR');
    });

    it('keeps the operation name when a string value holds a semicolon', async () => {
        await makePool(makeConn({ rows: [] })).query("SELECT 'a; b'");

        const { attributes } = (await collect())[OPERATION].points[0];
        expect(attributes['db.operation.name']).toBe('SELECT');
    });

    it('records a cluster query answered by a pool, with a cache miss', async () => {
        (Redis.get as jest.Mock).mockResolvedValue(null);
        const cluster = makeCluster(makePool(makeConn({ rows: [{ a: 1 }] })));
        await expect(cluster.query('SELECT ?', [1], { serviceId: 7, serviceName: 'billing' })).resolves.toEqual([{ a: 1 }]);

        const collected = await collect();
        expect(collected[CACHE].points[0].attributes[CACHE_RESULT]).toBe('miss');
        expect(counts(collected, CACHE)).toEqual([1]);
        expect(counts(collected, OPERATION)).toEqual([1]);
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[QUERY].unit).toBe('s');
        expect(collected[QUERY].points[0].attributes).toEqual({
            'db.system.name': 'mysql',
            'db.operation.name': 'SELECT',
            [CLUSTER]: 'c1',
            [SERVICE]: 'billing',
            [SOURCE]: 'pool'
        });
    });

    it('records a cluster query answered from fresh cache without a pool operation', async () => {
        (Redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ data: [{ a: 2 }], expired: Date.now() + 60000 }));
        await expect(makeCluster(makePool(makeConn())).query('SELECT 1')).resolves.toEqual([{ a: 2 }]);

        const collected = await collect();
        expect(collected[OPERATION]).toBeUndefined();
        expect(counts(collected, CACHE)).toEqual([1]);
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[CACHE].points[0].attributes[CACHE_RESULT]).toBe('hit');
        expect(collected[QUERY].points[0].attributes[SOURCE]).toBe('cache');
        expect(collected[QUERY].points[0].attributes[SERVICE]).toBeUndefined();
    });

    it('records stale cache served after every pool failed', async () => {
        (Redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ data: [{ a: 3 }], expired: 0 }));
        const cluster = makeCluster(makePool(makeConn({ queryErr: accessDenied })));
        await expect(cluster.query('SELECT 1')).resolves.toEqual([{ a: 3 }]);

        const collected = await collect();
        expect(counts(collected, CACHE)).toEqual([1]);
        expect(counts(collected, OPERATION)).toEqual([1]);
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[CACHE].points[0].attributes[CACHE_RESULT]).toBe('expired');
        expect(collected[OPERATION].points[0].attributes['error.type']).toBe('ER_ACCESS_DENIED_ERROR');
        expect(collected[QUERY].points[0].attributes[SOURCE]).toBe('stale_cache');
        expect(collected[QUERY].points[0].attributes['error.type']).toBeUndefined();
    });

    it('records every attempt of a retried query, and the cluster query once', async () => {
        const cluster = makeCluster(makePool(makeConn({ queryErr: accessDenied }), 1), makePool(makeConn({ rows: [{ a: 4 }] }), 2));
        await expect(cluster.query('SELECT 1', null, { redis: false })).resolves.toEqual([{ a: 4 }]);

        const collected = await collect();
        const attempts = collected[OPERATION].points.map(point => [point.attributes['server.address'], point.attributes['error.type']]);
        expect(attempts).toHaveLength(2);
        expect(attempts).toContainEqual(['10.0.0.1', 'ER_ACCESS_DENIED_ERROR']);
        expect(attempts).toContainEqual(['10.0.0.2', undefined]);
        expect(counts(collected, OPERATION)).toEqual([1, 1]);
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[QUERY].points[0].attributes[SOURCE]).toBe('pool');
    });

    it('records a cluster query that found no valid pool as failed', async () => {
        const pool = makePool(makeConn());
        (pool.status as any)._isValid = false;
        await expect(makeCluster(pool).query('SELECT 1', null, { redis: false })).rejects.toThrow('There is no pool');

        const collected = await collect();
        expect(collected[OPERATION]).toBeUndefined();
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[QUERY].points[0].attributes['error.type']).toBe('_OTHER');
    });

    it('records a cached value that does not parse as a failed query, when no pool is valid', async () => {
        (Redis.get as jest.Mock).mockResolvedValue('{not json');
        const pool = makePool(makeConn());
        (pool.status as any)._isValid = false;
        await expect(makeCluster(pool).query('SELECT 1')).rejects.toThrow(SyntaxError);

        const collected = await collect();
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[QUERY].points[0].attributes['error.type']).toBe('_OTHER');
        expect(collected[QUERY].points[0].attributes[SOURCE]).toBeUndefined();
    });

    it('records a cached value that does not parse as a failed query, when a pool is valid', async () => {
        (Redis.get as jest.Mock).mockResolvedValue('{not json');
        await expect(makeCluster(makePool(makeConn({ rows: [] }))).query('SELECT 1')).rejects.toThrow(SyntaxError);

        const collected = await collect();
        expect(collected[OPERATION]).toBeUndefined();
        expect(counts(collected, CACHE)).toEqual([1]);
        expect(counts(collected, QUERY)).toEqual([1]);
        expect(collected[QUERY].points[0].attributes['error.type']).toBe('_OTHER');
    });

    it('records a failed cluster query with error.type and no result source', async () => {
        const cluster = makeCluster(makePool(makeConn({ queryErr: accessDenied })));
        await expect(cluster.query('SELECT 1', null, { redis: false })).rejects.toThrow('Access denied');

        const collected = await collect();
        expect(collected[CACHE]).toBeUndefined();
        expect(collected[QUERY].points).toHaveLength(1);
        expect(collected[QUERY].points[0].attributes['error.type']).toBe('_OTHER');
        expect(collected[QUERY].points[0].attributes[SOURCE]).toBeUndefined();
    });
});

describe('a failing MeterProvider', () => {
    it('never throws into the query path, and is logged once', () => {
        const broken = () => { throw new Error('broken sdk'); };
        const spy = jest.spyOn(metrics, 'getMeterProvider').mockImplementation(broken);
        try {
            expect(() => Metrics.recordCacheLookup(0.01, 'hit')).not.toThrow();
            expect(() => Metrics.recordQuery(0.01, { source: 'pool' })).not.toThrow();
            expect(() => Metrics.recordOperation(0.01, { poolName: 'p', host: 'h', port: 1 })).not.toThrow();
        } finally {
            spy.mockRestore();
        }

        const warnings = (Logger.warn as jest.Mock).mock.calls.filter(call => /Recording a metric failed/.test(call[0]));
        expect(warnings).toHaveLength(1);
        expect(warnings[0][0]).toContain('broken sdk');
    });
});

describe('Metrics.operationName', () => {
    it.each([
        ['SELECT 1', 'SELECT'],
        ['  select * from t;', 'SELECT'],
        ['/* note */ CALL sp(1)', 'CALL'],
        ['-- note\nInsert into t values (1)', 'INSERT'],
        ['(SELECT 1) UNION (SELECT 2)', 'SELECT'],
        ['SHOW GLOBAL STATUS;', 'SHOW'],
        ["SELECT 'a; b'", 'SELECT'],
        ['SELECT "a;b", `c;d`', 'SELECT'],
        ["SELECT 'it''s; fine'", 'SELECT']
    ])('reads %j as %s', (sql, name) => {
        expect(MetricsClass.operationName(sql)).toBe(name);
    });

    // 28 repeats: a parser that backtracks needs seconds here and fails the bound, it does not hang.
    // The linear scan needs under a millisecond
    it.each([
        ['spaces', ' '.repeat(28) + '?'],
        ['block comments', '/* c */'.repeat(28) + '1'],
        ['line comments', '-- c\n'.repeat(28) + '?'],
        ['brackets', '('.repeat(28) + '?']
    ])('reads a run of %s that no keyword follows in one pass', (_kind, sql) => {
        const started = Date.now();
        expect(MetricsClass.operationName(sql)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(500);
    });

    it.each([
        ['SELECT 1; DELETE FROM t'],
        ['SELECT 1; -- trailing comment'],
        ['GRANT ALL ON *.* TO u'],
        ['123'],
        ['/* never closed'],
        [''],
        [undefined]
    ])('leaves %j without a name', (sql) => {
        expect(MetricsClass.operationName(sql)).toBeUndefined();
    });
});
