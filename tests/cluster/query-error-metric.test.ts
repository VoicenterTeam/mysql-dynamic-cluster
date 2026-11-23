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
import Metrics from '../../src/metrics/Metrics';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';

// The query-duration point of a query whose error has a code or an errno that throws when it
// is read (#106): the real Metrics and an in-memory exporter, the pools are fakes
const QUERY = 'mysql_dynamic_cluster.query.duration';

const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
const provider = new MeterProvider({ readers: [reader] });

// the attributes of every point of the query metric since the last call
const queryPoints = async (): Promise<any[]> => {
    await reader.forceFlush();
    const points: any[] = [];
    for (const resourceMetrics of exporter.getMetrics()) {
        for (const scopeMetrics of resourceMetrics.scopeMetrics) {
            for (const metric of scopeMetrics.metrics) {
                if (metric.descriptor.name !== QUERY) continue;
                metric.dataPoints.forEach(point => points.push(point.attributes));
            }
        }
    }
    exporter.reset();
    return points;
};

// a pool that fails the query before the statement went out
const node = (id: number, rejection: unknown): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore: id },
    query: jest.fn((_sql: string, _options: object, outcome: any) => {
        outcome.sent = false;
        return Promise.reject(rejection);
    })
});
const makeCluster = (pools: any[]): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });
// an error whose member `name` throws when it is read
const throwing = (name: string, base: object) =>
    Object.defineProperty(base, name, {
        get() { throw new Error(name + ' cannot be read'); }
    });

describe('the query-duration point of an error whose code or errno cannot be read', () => {
    beforeAll(() => {
        Metrics.init('c1');
        metrics.setGlobalMeterProvider(provider);
    });

    afterAll(async () => {
        await provider.shutdown();
        metrics.disable();
    });

    beforeEach(async () => {
        await queryPoints();
    });

    it.each([
        ['the code throws', throwing('code', Object.assign(new Error('down'), { errno: 1213 })),
            { 'error.type': '_OTHER', 'db.response.status_code': '1213' }],
        ['the errno throws', throwing('errno', Object.assign(new Error('down'), { code: 'ER_X' })),
            { 'error.type': 'ER_X' }],
        ['both throw', throwing('errno', throwing('code', new Error('down'))),
            { 'error.type': '_OTHER' }]
    ])('is written when %s', async (_name, error, expected) => {
        await expect(makeCluster([node(1, error)]).query('SELECT 1')).rejects.toBe(error);

        const points = await queryPoints();
        expect(points).toHaveLength(1);
        expect(points[0]).toMatchObject(expected);
        if (!('db.response.status_code' in expected)) {
            expect(points[0]['db.response.status_code']).toBeUndefined();
        }
    });
});
