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

import { raw } from 'mysql2';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';
import { parseSettings } from '../../src/configs/schema';
import Logger from '../../src/utils/Logger';
import Redis from '../../src/Redis/Redis';

// a cluster with one valid pool that records the sql it gets, built without the config singletons
const makeCluster = (escapeNamedValues?: boolean) => {
    const poolQuery = jest.fn().mockResolvedValue([]);
    const cluster: GaleraCluster = Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: [{ id: 1, status: { isValid: true, loadScore: 0 }, query: poolQuery }],
        _useRedis: false,
        _errorRetryCount: 1,
        _escapeNamedValues: escapeNamedValues,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });
    const sent = async (sql: string, values?: any, options?: any): Promise<string> => {
        await cluster.query(sql, values, options);
        return poolQuery.mock.calls[poolQuery.mock.calls.length - 1][0];
    };
    return { cluster, sent };
};

const SQL = 'SELECT * FROM t WHERE name = :n';
const QUOTE = "x' OR '1'='1";
const namedValuesWarnings = () => (Logger.warn as jest.Mock).mock.calls
    .filter(call => String(call[0]).includes('escapeNamedValues'));

describe('named query values', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('with escapeNamedValues on', () => {
        it('quotes a string and escapes the quotes in it', async () => {
            const { sent } = makeCluster(true);
            expect(await sent(SQL, { n: QUOTE })).toBe("SELECT * FROM t WHERE name = 'x\\' OR \\'1\\'=\\'1'");
        });

        it('escapes a backslash before a quote', async () => {
            const { sent } = makeCluster(true);
            expect(await sent(SQL, { n: "\\' OR 1=1 -- " })).toBe("SELECT * FROM t WHERE name = '\\\\\\' OR 1=1 -- '");
        });

        it.each([
            ['a number', 5, '5'],
            ['null', null, 'NULL'],
            ['undefined', undefined, 'NULL'],
            ['a boolean', true, 'true'],
            ['an array', [1, 'a'], "1, 'a'"],
            // not `a` = 1: an object parsed from a request must not turn into a condition
            ['a plain object', { a: 1 }, "'[object Object]'"],
            ['raw sql from mysql2', raw('NOW()'), 'NOW()']
        ])('writes %s the way mysql2 does', async (_name, value, expected) => {
            const { sent } = makeCluster(true);
            expect(await sent('SELECT :n', { n: value })).toBe('SELECT ' + expected);
        });

        it('leaves a placeholder without a value as it is', async () => {
            const { sent } = makeCluster(true);
            expect(await sent('SELECT :a, :b', { a: 1 })).toBe('SELECT 1, :b');
        });

        it('does not take a value from the prototype of the object', async () => {
            const { sent } = makeCluster(true);
            expect(await sent('SELECT :toString, :a', { a: 1 })).toBe('SELECT :toString, 1');
        });

        it('takes values from an object without a prototype', async () => {
            const { sent } = makeCluster(true);
            const values = Object.assign(Object.create(null), { n: 'a' });
            expect(await sent(SQL, values)).toBe("SELECT * FROM t WHERE name = 'a'");
        });

        it('does not replace a placeholder that arrives inside a value', async () => {
            const { sent } = makeCluster(true);
            expect(await sent('SELECT :a, :b', { a: ':b', b: 'secret' })).toBe("SELECT ':b', 'secret'");
        });

        it('does not warn', async () => {
            const { sent } = makeCluster(true);
            await sent(SQL, { n: 'a' });
            expect(namedValuesWarnings()).toHaveLength(0);
        });

        it.each([undefined, null])('stays on when the query option is %s', async option => {
            const { sent } = makeCluster(true);
            expect(await sent(SQL, { n: QUOTE }, { escapeNamedValues: option })).toBe("SELECT * FROM t WHERE name = 'x\\' OR \\'1\\'=\\'1'");
        });

        it('can be turned off for one query', async () => {
            const { sent } = makeCluster(true);
            expect(await sent(SQL, { n: 'NOW()' }, { escapeNamedValues: false })).toBe('SELECT * FROM t WHERE name = NOW()');
        });
    });

    describe('with escapeNamedValues off', () => {
        it('puts the value into the sql as text, as before', async () => {
            const { sent } = makeCluster(false);
            expect(await sent(SQL, { n: QUOTE })).toBe("SELECT * FROM t WHERE name = x' OR '1'='1");
            expect(await sent("SELECT ':n'", { n: 'a' })).toBe("SELECT 'a'");
        });

        it('can be turned on for one query', async () => {
            const { sent } = makeCluster(false);
            expect(await sent(SQL, { n: QUOTE }, { escapeNamedValues: true })).toBe("SELECT * FROM t WHERE name = 'x\\' OR \\'1\\'=\\'1'");
            expect(namedValuesWarnings()).toHaveLength(0);
        });

        it('warns once per cluster, without the sql and the values', async () => {
            const { sent } = makeCluster(false);
            await sent(SQL, { n: 'secret-value' });
            await sent(SQL, { n: 'secret-value' });
            const warnings = namedValuesWarnings();
            expect(warnings).toHaveLength(1);
            expect(JSON.stringify(warnings[0])).not.toContain('secret-value');
            expect(JSON.stringify(warnings[0])).not.toContain('SELECT');
        });

        it('warns again in another cluster', async () => {
            await makeCluster(false).sent(SQL, { n: 1 });
            await makeCluster(false).sent(SQL, { n: 1 });
            expect(namedValuesWarnings()).toHaveLength(2);
        });

        it('keeps the warning for the first value that goes in as text', async () => {
            const { sent } = makeCluster(false);
            await sent('SELECT 1', {});
            await sent('SELECT :a', { b: 1 });
            expect(namedValuesWarnings()).toHaveLength(0);
            await sent('SELECT :a', { a: 1 });
            expect(namedValuesWarnings()).toHaveLength(1);
        });

        it('does not warn for array, string or missing values', async () => {
            const { sent } = makeCluster(false);
            expect(await sent('SELECT ?', [QUOTE])).toBe("SELECT 'x\\' OR \\'1\\'=\\'1'");
            expect(await sent('SELECT ?', 'a')).toBe("SELECT 'a'");
            expect(await sent('SELECT 1')).toBe('SELECT 1');
            expect(namedValuesWarnings()).toHaveLength(0);
        });
    });

    it('escapes the cache key of the fallback when no pool is valid', async () => {
        const { cluster } = makeCluster(true);
        (cluster as any)._pools[0].status.isValid = false;
        (cluster as any)._useRedis = true;
        (Redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ data: [], expired: 0 }));
        await cluster.query(SQL, { n: "a'b" });
        expect(Redis.get).toHaveBeenCalledWith("SELECT * FROM t WHERE name = 'a\\'b'");
    });

    describe('setting', () => {
        it('is off by default', () => {
            expect(parseSettings({}).escapeNamedValues).toBe(false);
        });

        it('takes a boolean only', () => {
            expect(parseSettings({ escapeNamedValues: true }).escapeNamedValues).toBe(true);
            expect(() => parseSettings({ escapeNamedValues: 'yes' })).toThrow('escapeNamedValues');
        });
    });
});
