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
import Metrics from '../../src/metrics/Metrics';
import Redis from '../../src/Redis/Redis';

// Where a :name stands in the text (#131). query() reads it as sql-escaper reads it for a ?: a
// :name in code is replaced, one in a comment is text, and one inside quotes or backticks is
// refused when the object has that key, since the quotes of its value would close the literal.
// A cluster with one valid pool that records the sql it gets, built without the config singletons
const makeCluster = () => {
    const poolQuery = jest.fn().mockResolvedValue([]);
    const cluster: GaleraCluster = Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: [{ id: 1, status: { isValid: true, loadScore: 0 }, query: poolQuery }],
        _useRedis: false,
        _errorRetryCount: 1,
        _clusterName: 'c',
        _nullServiceName: 'mdc',
        _clusterHashing: { connected: false }
    });
    const sent = async (sql: string, values?: any): Promise<string> => {
        await cluster.query(sql, values);
        return poolQuery.mock.calls[poolQuery.mock.calls.length - 1][0];
    };
    return { cluster, poolQuery, sent };
};

const V = { n: 'v', m: 'w' };

beforeEach(() => jest.clearAllMocks());

describe('a :name in code is replaced, one in a comment is text', () => {
    it.each([
        ['a = :n', 'SELECT * FROM t WHERE a = :n', "SELECT * FROM t WHERE a = 'v'"],
        ['a -- comment', 'SELECT 1 -- :n\n, :m', "SELECT 1 -- :n\n, 'w'"],
        ['a # comment', 'SELECT 1 # :n\n, :m', "SELECT 1 # :n\n, 'w'"],
        ['a /* */ comment', 'SELECT 1 /* :n */ :m', "SELECT 1 /* :n */ 'w'"],
        ['an unterminated /* comment', 'SELECT :m /* :n', "SELECT 'w' /* :n"],
        // the server runs these comments
        ['/*! */', 'SELECT /*! :n */ 1', "SELECT /*! 'v' */ 1"],
        ['/*+ */', 'SELECT /*+ :n */ 1', "SELECT /*+ 'v' */ 1"],
        ['-- with no space after it, which is code', 'SELECT 1--:n', "SELECT 1--'v'"],
        // the escaped quote does not end the string early
        ["a string with \\'", "SELECT 'it\\'s' = :m", "SELECT 'it\\'s' = 'w'"],
        ['a quote inside a /* */ comment', "SELECT /* it's */ :n", "SELECT /* it's */ 'v'"],
        ['a quote inside a -- comment', "SELECT 1 -- it's\n:n", "SELECT 1 -- it's\n'v'"],
        ['# inside a string', "SELECT '#' = :n", "SELECT '#' = 'v'"],
        ['/* inside a string', "SELECT '/*' = :n", "SELECT '/*' = 'v'"],
        ['a :name in quotes the object does not have', "SELECT ':x', :n", "SELECT ':x', 'v'"],
        ["'10:30' when the object has no key 30", "SELECT * FROM t WHERE t > '10:30' AND a = :n",
            "SELECT * FROM t WHERE t > '10:30' AND a = 'v'"]
    ])('%s', async (_where, sql, expected) => {
        const { sent } = makeCluster();
        expect(await sent(sql, V)).toBe(expected);
    });

    it('does not replace a :name that a value holds', async () => {
        const { sent } = makeCluster();
        expect(await sent('SELECT :n, :m', { n: ':m', m: 'w' })).toBe("SELECT ':m', 'w'");
    });
});

describe('a :name of the object inside quotes or backticks is refused', () => {
    it.each([
        ["a = ':n'", "SELECT * FROM t WHERE a = ':n'", V, 'n'],
        ['a = ":n"', 'SELECT * FROM t WHERE a = ":n"', V, 'n'],
        ['`:n`', 'SELECT `:n` FROM t', V, 'n'],
        ["id = ':id' with a number", "SELECT * FROM t WHERE id = ':id'", { id: 5 }, 'id'],
        ["'10:30' when the object has a key 30", "SELECT * FROM t WHERE t > '10:30'",
            { 30: 'x' }, '30'],
        ["'it''s :n'", "SELECT 'it''s :n'", V, 'n'],
        ['a doubled backtick', 'SELECT `a``:n` FROM t', V, 'n'],
        ['an unterminated string', "SELECT 'abc :n", V, 'n'],
        ['the first in the text', "SELECT ':m', ':n'", V, 'm']
    ])('%s', async (_where, sql, values, key) => {
        const { cluster, poolQuery } = makeCluster();
        const lookup = jest.spyOn(cluster as any, '_getActivePools');

        const error = await cluster.query(sql, values, { redis: true }).catch(thrown => thrown);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe('MDC_QUOTED_PLACEHOLDER');
        expect(error.message).toBe(`query: the placeholder :${key} is inside quotes or ` +
            `backticks. Write it bare, as = :${key}`);
        // before any node, Redis or pool
        expect(lookup).not.toHaveBeenCalled();
        expect(Redis.get).not.toHaveBeenCalled();
        expect(poolQuery).not.toHaveBeenCalled();
        expect(Metrics.recordQuery).toHaveBeenCalledTimes(1);
        const [[, options]] = (Metrics.recordQuery as jest.Mock).mock.calls;
        expect(options.error).toBe(error);
    });
});

describe('values that take no named pass are not checked', () => {
    it('array values', async () => {
        const { sent } = makeCluster();
        expect(await sent("SELECT ':x', ?", [1])).toBe("SELECT ':x', 1");
    });

    it('a string as the values', async () => {
        const { sent } = makeCluster();
        expect(await sent("SELECT ':x', ?", 'a')).toBe("SELECT ':x', 'a'");
    });

    it('execute() sends the text as it is', async () => {
        const { cluster, poolQuery } = makeCluster();
        await cluster.execute("SELECT ':x', ?", [1]);
        expect(poolQuery.mock.calls[0][0]).toBe("SELECT ':x', ?");
    });

    it('execute() with an object fails on its own check', async () => {
        const { cluster } = makeCluster();
        const error = await cluster.query("SELECT ':x'", { x: 1 }, { execute: true })
            .catch(thrown => thrown);
        expect(error).toBeInstanceOf(TypeError);
        expect(error.code).toBeUndefined();
    });
});
