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

import { format } from 'sql-escaper';
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
        // code, as sql-escaper treats a ? there
        ['/*! */', 'SELECT /*! :n */ 1', "SELECT /*! 'v' */ 1"],
        ['/*+ */', 'SELECT /*+ :n */ 1', "SELECT /*+ 'v' */ 1"],
        ['-- with no space after it, which is code', 'SELECT 1--:n', "SELECT 1--'v'"],
        ['-- at the end of the text', 'SELECT :m --', "SELECT 'w' --"],
        ['-- with a tab after it', 'SELECT 1 --\t:n', 'SELECT 1 --\t:n'],
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
        ['an unterminated backtick', 'SELECT `abc :n', V, 'n'],
        ['a backslash inside double quotes', 'SELECT "a\\":n"', V, 'n'],
        ["quotes inside /*! */", "SELECT /*! ':n' */ 1", V, 'n'],
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

// sql-escaper's format() is the reference: a :name stands in code where format() replaces a ?.
// Random texts from a fixed seed, each with a twin that has ?p in place of :p, at the same place
describe('the walker reads the text as sql-escaper reads it for a ?', () => {
    it('over random texts', () => {
        const walk = (GaleraCluster as any)._namedPlaceholders;
        const ALPHABET = ["'", '"', '`', '#', '-', '/', '*', '!', '+', '\\', '\n', '\t', '\r', '\0',
            ' ', 'a', 'b', ':p '];
        // mulberry32: every run walks the same texts
        let seed = 131;
        const random = () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const mismatches: object[] = [];
        const seen = { code: 0, quoted: 0, comment: 0 };
        for (let run = 0; run < 20000; run++) {
            let text = '';
            const length = 1 + Math.floor(random() * 16);
            for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
            const twin = text.split(':p ').join('?p ');
            const count = twin.split('?').length - 1;
            // the k-th marker stands for the k-th ? format() replaced
            const markers = Array.from({ length: count }, (_, k) => ({ toSqlString: () => `@${k}@` }));
            const out: string = format(twin, markers);
            const replaced: number[] = [];
            const marker = /@\d+@/g;
            let shift = 0;
            let match: RegExpExecArray;
            while ((match = marker.exec(out))) {
                replaced.push(match.index - shift);
                shift += match[0].length - 1;
            }
            const found: { start: number, quoted: boolean }[] = walk(text, { p: 1 });
            const code = found.filter(entry => !entry.quoted).map(entry => entry.start);
            const quoted = found.filter(entry => entry.quoted).map(entry => entry.start);
            // the ? twin of a quoted :name was left alone
            const quotedLeft = quoted.every(at => twin[at] === '?' && !replaced.includes(at));
            if (JSON.stringify(code) !== JSON.stringify(replaced) || !quotedLeft) {
                mismatches.push({ text, out, code, quoted, replaced });
            }
            seen.code += code.length;
            seen.quoted += quoted.length;
            seen.comment += count - found.length;
        }
        expect(mismatches.slice(0, 5)).toEqual([]);
        // every context came up
        expect(seen.code).toBeGreaterThan(1000);
        expect(seen.quoted).toBeGreaterThan(1000);
        expect(seen.comment).toBeGreaterThan(1000);
    });

    // #134: each ? and ?? takes the value format() gives it, inside /*+ */ and /*!NNNNN */ too,
    // and the text the check reads for one in such a comment is the text format() wrote there
    it('over random texts: the ? and ?? that take a value, the text of one in a comment', () => {
        const walk = (GaleraCluster as any)._placeholders;
        const commentValues = (GaleraCluster as any)._commentValues;
        const ALPHABET = ["'", '"', '`', '#', '-- ', '/*', '*/', '/*+ ', '/*!1 ', '/*! ', '!', '+',
            '1', '\\', '\n', ' ', 'a', '?', '??', '???'];
        // mulberry32: every run walks the same texts
        let seed = 134;
        const random = () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const mismatches: object[] = [];
        let inComment = 0;
        for (let run = 0; run < 20000; run++) {
            let text = '';
            const length = 1 + Math.floor(random() * 16);
            for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
            // the k-th marker writes @k@ for a ?, `@k@` for a ??
            const count = text.split('?').length - 1;
            const markers = Array.from({ length: count }, (_, k) => ({
                toSqlString: () => `@${k}@`, toString: () => `@${k}@`
            }));
            const out: string = format(text, markers);
            const written = (found: { start: number, end: number }, k: number) =>
                found.end - found.start === 2 ? `\`@${k}@\`` : `@${k}@`;
            // a run of three ? or more takes no value
            const taken: { start: number, end: number, comment: boolean }[] = walk(text, /\?+/g)
                .filter((found: any) => !found.quoted && found.end - found.start <= 2);
            let rebuilt = '';
            let last = 0;
            taken.forEach((found, k) => {
                rebuilt += text.slice(last, found.start) + written(found, k);
                last = found.end;
            });
            rebuilt += text.slice(last);
            const expected = taken.map((found, k) => found.comment ? written(found, k) : null)
                .filter(entry => entry !== null);
            const texts: string[] = commentValues(text, markers);
            if (rebuilt !== out || JSON.stringify(texts) !== JSON.stringify(expected)) {
                mismatches.push({ text, out, rebuilt, texts, expected });
            }
            inComment += expected.length;
        }
        expect(mismatches.slice(0, 5)).toEqual([]);
        // a ? or ?? in such a comment came up
        expect(inComment).toBeGreaterThan(1000);
    });
});
