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

// What query() writes into the SQL text with array values (#121): mysql2's format(), from
// sql-escaper. sql-escaper 1.5.x also replaced a `?` inside a "..." string and inside a #
// comment, so every value after it moved by one place. The package requires 1.6 or later.
// The pool records the text it gets: the text the node gets
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
            "SELECT 'X' AS v -- why?\n, 'Y' AS w"]
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

    it('a plain object becomes `key` = value pairs', async () => {
        const { sent } = makeCluster();
        expect(await sent('UPDATE t SET ?', [{ a: 1, b: 'x' }]))
            .toBe("UPDATE t SET `a` = 1, `b` = 'x'");
    });

    it('an object with toSqlString() is written raw, a named value too', async () => {
        const { sent } = makeCluster();
        expect(await sent('SELECT ?', [raw('NOW()')])).toBe('SELECT NOW()');
        expect(await sent('SELECT :n', { n: raw('NOW()') })).toBe('SELECT NOW()');
    });
});
