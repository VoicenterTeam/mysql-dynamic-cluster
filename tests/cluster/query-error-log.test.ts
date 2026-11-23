jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../src/metrics/Metrics', () => ({
    __esModule: true,
    default: { recordOperation: jest.fn(), recordQuery: jest.fn(), recordCacheLookup: jest.fn() }
}));
jest.mock('../../src/Redis/Redis', () => ({
    __esModule: true,
    default: { set: jest.fn(), get: jest.fn() }
}));

import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import Logger from '../../src/utils/Logger';
import Metrics from '../../src/metrics/Metrics';

// The log line of each failed attempt, and errors whose members cannot be read (#106).
// Every node fails before its statement went out, so query() tries the next one
const node = (id: number, rejection: unknown): any => ({
    id, name: 'node' + id, host: 'host' + id,
    status: { isValid: true, loadScore: id },
    query: jest.fn((_sql: string, _options: object, outcome: any) => {
        outcome.sent = false;
        return Promise.reject(rejection);
    })
});

// a cluster over these pools, built without the config singletons
const makeCluster = (pools: any[]): any =>
    Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: pools,
        _useRedis: false,
        _errorRetryCount: pools.length,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });

const rejectionOf = (cluster: any): Promise<any> =>
    cluster.query('SELECT 1').then(
        () => { throw new Error('the query passed'); },
        (error: unknown) => error
    );
const failedLines = (): string[] => (Logger.error as jest.Mock).mock.calls
    .map(call => String(call[0]))
    .filter(line => line.startsWith('Query failed in pool '));

// what Node rejects with when every address of a host name refuses the connection
const refused = () => Object.assign(
    new (globalThis as any).AggregateError(
        [new Error('::1 refused'), new Error('127.0.0.1 refused')], ''
    ),
    { code: 'ECONNREFUSED' }
);
// an error whose member `name` throws when it is read
const throwing = (name: string, base: object = new Error('down')) =>
    Object.defineProperty(base, name, {
        get() { throw new Error(name + ' cannot be read'); }
    });

beforeEach(() => jest.clearAllMocks());

describe('the log line of a failed attempt', () => {
    it.each([
        ['the code and the errno of a server error',
            Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 }),
            'Query failed in pool node1: Deadlock found (code ER_LOCK_DEADLOCK, errno 1213)'],
        ['the code and the negative errno of a socket error',
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'),
                { code: 'ECONNREFUSED', errno: -111 }),
            'Query failed in pool node1: connect ECONNREFUSED 127.0.0.1:3306 ' +
                '(code ECONNREFUSED, errno -111)'],
        ['the code alone when there is no errno',
            Object.assign(new Error('Pool is closed.'), { code: 'POOL_CLOSED' }),
            'Query failed in pool node1: Pool is closed. (code POOL_CLOSED)'],
        ['the message alone when there is neither', new Error('down'),
            'Query failed in pool node1: down'],
        ['the name of an AggregateError, whose message is empty', refused(),
            'Query failed in pool node1: AggregateError (code ECONNREFUSED)'],
        ['the text of a rejection that is no error', 'refused',
            'Query failed in pool node1: refused']
    ])('has %s', async (_name, rejection, line) => {
        await rejectionOf(makeCluster([node(1, rejection)]));

        expect(failedLines()).toEqual([line]);
    });

    it('is written for each node tried', async () => {
        const cluster = makeCluster([
            node(1, Object.assign(new Error('one'), { code: 'A', errno: 1 })),
            node(2, new Error('two'))
        ]);
        await rejectionOf(cluster);

        expect(failedLines()).toEqual([
            'Query failed in pool node1: one (code A, errno 1)',
            'Query failed in pool node2: two'
        ]);
    });

    it('does not change the error the call rejects with when the message cannot be read',
        async () => {
            const error = throwing('message', Object.assign(new Error(), { code: 'X' }));
            const rejection = await rejectionOf(makeCluster([node(1, error)]));

            expect(rejection).toBe(error);
            expect(rejection.nodeId).toBe(1);
            expect(failedLines()).toEqual(['Query failed in pool node1: (code X)']);
        });

    it.each([
        ['a getter that throws', throwing('code')],
        ['a value that cannot be made text', Object.assign(new Error('down'), {
            code: Symbol('code'), errno: Object.create(null)
        })],
        ['a Proxy whose every read throws', new Proxy({}, {
            get() { throw new Error('no read'); }
        })]
    ])('is made without a throw from %s', (_name, error) => {
        expect(() => (GaleraCluster as any)._failureText(error)).not.toThrow();
    });
});

describe('an error whose errors cannot be read', () => {
    it('rejects the call with the error of the node tried last', async () => {
        const last = throwing('errors');
        const rejection = await rejectionOf(
            makeCluster([node(1, new Error('first')), node(2, last)])
        );

        expect(rejection).toBe(last);
        expect(rejection.nodeId).toBe(2);
    });

    it('is listed when a node tried before failed with it', async () => {
        const first = throwing('errors');
        const last = new Error('last');
        const rejection = await rejectionOf(makeCluster([node(1, first), node(2, last)]));

        expect(rejection).toBe(last);
        expect(rejection.errors).toEqual([{ nodeId: 1, error: first }]);
    });

    it('rejects the call with a Proxy whose trap throws for errors', async () => {
        const last = new Proxy(new Error('last'), {
            get(target, key) {
                if (key === 'errors') throw new Error('trap');
                return Reflect.get(target, key);
            }
        });
        const rejection = await rejectionOf(
            makeCluster([node(1, new Error('first')), node(2, last)])
        );

        expect(rejection).toBe(last);
    });

    it('is listed when it is a Proxy whose trap throws for errors', async () => {
        const first = new Proxy(new Error('first'), {
            get(target, key) {
                if (key === 'errors') throw new Error('trap');
                return Reflect.get(target, key);
            }
        });
        const last = new Error('last');
        const rejection = await rejectionOf(makeCluster([node(1, first), node(2, last)]));

        expect(rejection).toBe(last);
        expect(rejection.errors).toHaveLength(1);
        expect(rejection.errors[0].error).toBe(first);
    });
});

// mayTryNextNode reads the code and the errno of the error to decide on the next node
describe('an error whose code or errno cannot be read', () => {
    it.each(['code', 'errno'])('rejects the call with that error when its %s throws',
        async name => {
            const error = throwing(name);
            const rejection = await rejectionOf(makeCluster([node(1, error)]));

            expect(rejection).toBe(error);
            expect(rejection.nodeId).toBe(1);
        });

    it.each(['code', 'errno'])('is recorded as a failed query when its %s throws', async name => {
        const error = throwing(name);
        await rejectionOf(makeCluster([node(1, error)]));

        const records = (Metrics.recordQuery as jest.Mock).mock.calls.map(call => call[1]);
        expect(records).toHaveLength(1);
        expect(records[0].error).toBe(error);
    });

    it('lets the next node take the statement, which was not sent', async () => {
        const last = new Error('last');
        const rejection = await rejectionOf(
            makeCluster([node(1, throwing('errno')), node(2, last)])
        );

        expect(rejection).toBe(last);
        expect(rejection.errors.map((entry: any) => entry.nodeId)).toEqual([1]);
    });
});
