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

import mysql from 'mysql2';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GaleraCluster } from '../../src/cluster/GaleraCluster';

// What query() writes into the SQL text with array values (#121): the format() of sql-escaper,
// which mysql2 exports too. sql-escaper 1.5.x also replaced a `?` inside a "..." string and
// inside a # comment, so every value after it moved by one place. The package depends on 1.6 or
// later and calls it itself. The pool records the text it gets: the text the node gets
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
    return { sent };
};

describe('array values: a ? that is no placeholder is left alone', () => {
    it.each([
        ['in a "..." string', 'SELECT "q?" AS s, ? AS v', `SELECT "q?" AS s, 'X' AS v`],
        ['in a # comment', 'SELECT ? AS v # why?\n, ? AS w', "SELECT 'X' AS v # why?\n, 'Y' AS w"],
        ["in a '...' string", "SELECT 'q?' AS s, ? AS v", "SELECT 'q?' AS s, 'X' AS v"],
        ['in backticks', 'SELECT ? AS `q?`, ? AS v', "SELECT 'X' AS `q?`, 'Y' AS v"],
        ['in a /* */ comment', 'SELECT ? /* why? */ AS v', "SELECT 'X' /* why? */ AS v"],
        ['in a -- comment', 'SELECT ? AS v -- why?\n, ? AS w',
            "SELECT 'X' AS v -- why?\n, 'Y' AS w"],
        // the server runs these comments, so a ? in one is a placeholder
        ['in a /*! */ comment', 'SELECT /*! ? */ 1, ?', "SELECT /*! 'X' */ 1, 'Y'"],
        ['in a /*+ */ comment', 'SELECT /*+ ? */ 1, ?', "SELECT /*+ 'X' */ 1, 'Y'"]
    ])('%s', async (_where, sql, expected) => {
        const { sent } = makeCluster();
        expect(await sent(sql, ['X', 'Y'])).toBe(expected);
    });
});

// The features of mysql2's format that docs/subsystems/cluster.md names
describe('array values: what else the text gets', () => {
    const raw = (sql: string) => ({ toSqlString: () => sql });

    it('?? is an identifier', async () => {
        const { sent } = makeCluster();
        expect(await sent('SELECT ?? , ?', ['X', 'Y'])).toBe("SELECT `X` , 'Y'");
    });

    it('a plain object becomes `key` = value pairs after SET, a string elsewhere', async () => {
        const { sent } = makeCluster();
        expect(await sent('UPDATE t SET ?', [{ a: 1, b: 'x' }]))
            .toBe("UPDATE t SET `a` = 1, `b` = 'x'");
        expect(await sent('SELECT ?', [{ a: 1 }])).toBe("SELECT '[object Object]'");
    });

    it('a Map or plain object becomes pairs after ON DUPLICATE KEY UPDATE, a Map after SET', async () => {
        const { sent } = makeCluster();
        expect(await sent('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE ?', [{ a: 1 }]))
            .toBe('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE `a` = 1');
        expect(await sent('UPDATE t SET ?', [new Map([['a', 1]])])).toBe('UPDATE t SET `a` = 1');
        expect(await sent('SELECT ?', [new Map([['a', 1]])])).toBe("SELECT '[object Map]'");
    });

    it('a Set is a list, a Uint8Array is hex', async () => {
        const { sent } = makeCluster();
        expect(await sent('SELECT ?', [new Set([1, 2])])).toBe('SELECT 1, 2');
        expect(await sent('SELECT ?', [new Uint8Array([1, 39, 92])])).toBe("SELECT X'01275c'");
    });

    it('an object with toSqlString() is written raw, a named value too', async () => {
        const { sent } = makeCluster();
        expect(await sent('SELECT ?', [raw('NOW()')])).toBe('SELECT NOW()');
        expect(await sent('SELECT :n', { n: raw('NOW()') })).toBe('SELECT NOW()');
    });

    it('a named value is a string after SET, unless it is an expand() value', async () => {
        const { sent } = makeCluster();
        const { expand } = require('sql-escaper');
        expect(await sent('UPDATE t SET :n', { n: { a: 1 } })).toBe("UPDATE t SET '[object Object]'");
        expect(await sent('UPDATE t SET :n', { n: expand({ a: 1 }) })).toBe('UPDATE t SET `a` = 1');
    });
});

// query() calls sql-escaper itself, not through mysql2, with the arguments mysql2's format() and
// escape() get: the text is the one mysql2 writes, here where both resolve the same copy
describe('the text is the one of mysql2', () => {
    // the comparisons below assume mysql2 re-exports the function the package calls
    it('mysql2 exports the same format()', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(require('sql-escaper').format).toBe(mysql.format);
    });

    it('the package requires sql-escaper 1.6.0 or later', () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
        const range: string = pkg.dependencies['sql-escaper'];
        const [major, minor] = range.replace(/^[^\d]*/, '').split('.').map(Number);
        expect(major > 1 || (major === 1 && minor >= 6)).toBe(true);
    });

    const formatSQL = (sql: string, values: any): string =>
        (GaleraCluster.prototype as any)._formatSQL(sql, values);
    // the text, or the message of what was thrown
    const outcome = (write: () => string) => {
        try {
            return { text: write() };
        } catch (thrown) {
            return { thrown: (thrown as Error).message };
        }
    };
    const VALUES: [string, any][] = [
        ['a string with quotes', `it's "q"`],
        ['a string with backslashes', 'a\\b\\'],
        ['a string with NUL and control characters', 'a\0b\n\r\t\x1a\b'],
        ['a number', 42],
        ['a negative fraction', -1.5],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['a bigint', BigInt('12345678901234567890')],
        ['null', null],
        ['undefined', undefined],
        ['true', true],
        ['false', false],
        ['a Date', new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6))],
        ['an invalid Date', new Date(NaN)],
        ['a Buffer', Buffer.from([0, 1, 0x27, 0x5c, 255])],
        ['an array', [1, 'a', null]],
        ['a nested array', [[1, 'a'], [2, null]]],
        ['a plain object', { a: 1, b: "x'y", c: null }],
        ['an object with toSqlString()', { toSqlString: () => 'NOW()' }]
    ];

    it.each(VALUES)('array values: %s', (_name, value) => {
        // after SET a plain object becomes `key` = value pairs, elsewhere a string
        for (const sql of ['SELECT ? AS v, ? AS w', 'UPDATE t SET ? WHERE w = ?']) {
            expect(outcome(() => formatSQL(sql, [value, 'w'])))
                .toEqual(outcome(() => mysql.format(sql, [value, 'w'])));
        }
    });

    it.each(VALUES)('a named value, escape(value, true): %s', (_name, value) => {
        expect(outcome(() => formatSQL('SELECT :n AS v', { n: value })))
            .toEqual(outcome(() => 'SELECT ' + mysql.escape(value, true) + ' AS v'));
    });

    it.each([
        ['a name', 'SELECT ?? FROM ??', ['col', 't']],
        ['a qualified name', 'SELECT ?? FROM ??', ['t.col', 'db.t']],
        ['a backtick in a name', 'SELECT ?? FROM t', ['a`b']],
        ['a list of names', 'SELECT ?? FROM t', [['a', 'b']]]
    ])('?? identifiers: %s', (_name, sql, values) => {
        expect(formatSQL(sql, values)).toBe(mysql.format(sql, values));
    });

    it('a string as the values', () => {
        expect(formatSQL('SELECT ?', "it's")).toBe(mysql.format('SELECT ?', "it's"));
    });
});
