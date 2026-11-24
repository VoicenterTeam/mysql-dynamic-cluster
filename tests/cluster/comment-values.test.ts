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

// Values in a statement with a comment a server can skip (#134): /*+ */, and /*! or MariaDB's
// /*M! with a version, or with a placeholder that can write one. Such a server ends the comment
// at a */ a value adds, and may nest a /* a value adds in it, so the rest of the value runs as
// SQL. Text of the app inside such a comment, such as a quote, a -- or a #, can hide where a
// value stands. So query() refuses a value that adds a /* or a */ to a statement with such a
// comment anywhere, and any value written into a statement where a string, identifier or
// comment opens inside such a comment and runs past its end. /*! */ alone is code to the
// server: no check.
// A cluster with pools that record the sql they get, built without the config singletons
const makeCluster = (valid = true, useRedis = false) => {
    const poolQuery = jest.fn().mockResolvedValue([]);
    const cluster: GaleraCluster = Object.assign(Object.create(GaleraCluster.prototype), {
        _pools: [{ id: 1, status: { isValid: valid, loadScore: 0 }, query: poolQuery }],
        _useRedis: useRedis,
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

// the value of the rig, whose */ ends the comment
const CLOSE = '*/ , 1 AS injected -- ';
const MESSAGE = 'query: a value holds /* or */ in a statement with a /*+ */ or /*!NNNNN */ ' +
    'comment, which the server can read as the end of that comment';
const DESYNC = 'query: the text inside a /*+ */ or /*!NNNNN */ comment reads differently to the ' +
    'server and to the escaper, so values cannot be written into this statement. Use execute()';
// a value written as the SQL it returns
const raw = (sql: string) => ({ toSqlString: () => sql });

beforeEach(() => jest.clearAllMocks());

describe('a value that adds /* or */ to a statement with a skipped comment is refused', () => {
    it.each([
        // the inputs of the review: a /* value that opens a comment in a skipped one
        ['a /* in /*!99999 */, then a */ outside it',
            'SELECT 1 AS a /*!99999 ? */ FROM t WHERE name = ?', ['/*', CLOSE]],
        ['the same with :name', 'SELECT 1 AS a /*!99999 :x */ FROM t WHERE name = :y',
            { x: '/*', y: CLOSE }],
        // the cases of the rig
        ['/*+ */ after a select item', 'SELECT 1 AS a /*+ ? */', [CLOSE]],
        ['/*+ */ in a hint position', 'SELECT /*+ QB_NAME(?) */ 2 AS a', ['*/ 1 AS injected, /*']],
        ['/*!99999 */', 'SELECT 2 AS a /*!99999 ? */', [CLOSE]],
        ['/*!80000 */', 'SELECT 2 AS a /*!80000 , ? AS b */', [CLOSE]],
        ['/*! with one digit', 'SELECT 2 AS a /*!1 , ? AS b */', [CLOSE]],
        [':name in a hint', 'SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1', { ms: CLOSE }],
        ['a value with /* only', 'SELECT 1 AS a /*+ ? */', ['/*']],
        // anywhere in the statement, also after the comment
        ['a */ after the hint', 'SELECT /*+ BKA(t) */ * FROM t WHERE body LIKE ?', ['%*/%']],
        ['values as a string', 'SELECT 1 AS a /*+ ? */', CLOSE],
        ['?? (an identifier)', 'SELECT /*+ BKA(??) */ * FROM t', ['*/ x']],
        ['a plain object after SET, as pairs', 'UPDATE t /*+ BKA(t) */ SET ?', [{ a: CLOSE }]],
        ['the key of a plain object after SET', 'UPDATE t /*+ BKA(t) */ SET ?', [{ '*/x': 1 }]],
        // a */ made of the value and the text around it
        ['a raw value next to the text', 'SELECT 1 /*+ ?/ */', [raw('*')]],
        // MariaDB's versioned comment
        ['a */ after /*M!999999 */', 'SELECT 1 AS a /*M!999999 x */ FROM t WHERE name = ?',
            [CLOSE]],
        // a value that writes the version
        ['the version from a ?', 'SELECT 2 AS a /*!? , ? AS b */', [99999, CLOSE]],
        ['the version from a :name', 'SELECT 2 AS a /*!:ver , :v AS b */',
            { ver: 99999, v: CLOSE }],
        ['the version from a ?, a /* in the comment, a */ after it',
            'SELECT 1 AS a /*!? ? */ FROM t WHERE name = ?', [99999, '/*', CLOSE]]
    ])('%s', async (_where, sql, values) => {
        const { cluster, poolQuery } = makeCluster();
        const lookup = jest.spyOn(cluster as any, '_getActivePools');

        const error = await cluster.query(sql, values as any, { redis: true })
            .catch(thrown => thrown);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
        expect(error.message).toBe(MESSAGE);
        // before any node, Redis or pool
        expect(lookup).not.toHaveBeenCalled();
        expect(Redis.get).not.toHaveBeenCalled();
        expect(poolQuery).not.toHaveBeenCalled();
        expect(Metrics.recordQuery).toHaveBeenCalledTimes(1);
        const [[, options]] = (Metrics.recordQuery as jest.Mock).mock.calls;
        expect(options.error).toBe(error);
    });

    it('MDC_QUOTED_PLACEHOLDER comes first when a :name is in quotes too', async () => {
        const { cluster } = makeCluster();

        const error = await cluster.query("SELECT ':q' /*+ :v */", { q: 1, v: CLOSE })
            .catch(thrown => thrown);

        expect(error.code).toBe('MDC_QUOTED_PLACEHOLDER');
    });

    it('an aborted signal comes first, before a value that throws as it is written', async () => {
        const { cluster } = makeCluster();
        const reason = new Error('gave up');
        const controller = new AbortController();
        controller.abort(reason);
        const throwing = { toSqlString: () => { throw new Error('toSqlString failed'); } };

        const error = await cluster.query('SELECT 1 /*+ ? */', [throwing],
            { signal: controller.signal }).catch(thrown => thrown);

        expect(error).toBe(reason);
        expect(Metrics.recordQuery).toHaveBeenCalledTimes(1);
    });
});

// A string, identifier or comment that sql-escaper reads as opening inside a skipped comment
// and that runs past the server's end of it: a value can stand in a string for one and outside
// it for the other, with no /* or */ in it
describe('a value written where a skipped comment reads differently is refused', () => {
    it.each([
        ['an apostrophe in /*!99999 */',
            "SELECT 1 /*!99999 it's */ AS a, 'why?' AS q FROM t WHERE id = ?", [' OR 1=1 -- ']],
        ['an apostrophe in a hint', "SELECT /*+ BKA(') */ a FROM t WHERE b = ' AND c = ?",
            [' OR 1=1 -- ']],
        ['the same with a :name', "SELECT /*+ BKA(') */ a FROM t WHERE b = ' AND c = :v",
            { v: ' OR 1=1 -- ' }],
        ['a quote in /*M!999999 */', "SELECT 1 /*M!999999 it's */ AS a FROM t WHERE id = ?", [1]],
        ['a quote that never ends, a value before it', "SELECT ?, /*+ BKA(') */ 1", [1]],
        ['a quote that never ends in an unterminated hint', "SELECT ? /*+ BKA(')", [1]],
        ['a */ inside a string in a hint', "SELECT /*+ QB_NAME('a*/b') */ 1, ?", [1]],
        // the inputs of the earlier review: text in a hint that hides the next comment
        ['a quote in a hint', "SELECT /*+ X(') */ 1 /*+ ') ? */", [CLOSE]],
        ['a -- in a hint', 'SELECT /*+ BKA(t) -- x */ 1 /*+\n ? */', [CLOSE]],
        ['a # in a hint', 'SELECT /*+ BKA(t) # x */ 1 /*+\n ? */', [CLOSE]],
        ['a -- in a hint, a value with no */', 'SELECT /*+ BKA(t) -- x */ 1\n, ?', [1]],
        // a /* in a skipped comment opens a nested one: the comment ends at a later */
        ['a */ after a comment nested in /*!99999 */',
            'SELECT 2 AS a /*!99999 /* note */ , ? AS b */', [CLOSE]],
        ['the same with a :name', 'SELECT 2 AS a /*!99999 /* note */ , :v AS b */', { v: CLOSE }],
        ['a */ after a comment nested in /*M!999999 */',
            'SELECT 2 AS a /*M!999999 /* note */ , ? AS b */', [CLOSE]],
        ['the same with a :name', 'SELECT 2 AS a /*M!999999 /* note */ , :v AS b */',
            { v: CLOSE }],
        ['a comment nested in /*!99999 */, a value with no */',
            'SELECT 2 AS a /*!99999 /* n */ , ? AS b */', [1]],
        ['/*!99999 */ nested in /*!99999 */',
            'SELECT 2 AS a /*!99999 /*!99999 n */ , ? AS b */', [1]],
        ['a comment nested in a hint', 'SELECT /*+ BKA(t) /* x */ 1, ?', [1]],
        ['/*/ in /*!99999 */', 'SELECT ? AS a /*!99999 /*/ x */ */', [1]],
        // the /* in a string of the comment, the */ that ends it in a string of the app after it
        ['a /* in a string in /*!99999 */',
            "SELECT 'x' /*!99999 '/*' */ AS a, 'y */' AS b, ? AS c", [' , 2 AS INJ -- ']],
        ['the same with a :name', "SELECT 'x' /*!99999 '/*' */ AS a, 'y */' AS b, :v AS c",
            { v: ' , 2 AS INJ -- ' }],
        ['the same with the */ in backticks, a value with a backtick',
            "SELECT 'x' /*!99999 '/*' */ AS a, 1 AS `y */`, ? AS c", ['` , 2 AS INJ -- ']],
        ['a /* in a string in /*M!999999 */',
            "SELECT 'x' /*M!999999 '/*' */ AS a, 'y */' AS b, ? AS c", [' , 2 AS INJ -- ']],
        ['the same with a :name', "SELECT 'x' /*M!999999 '/*' */ AS a, 'y */' AS b, :v AS c",
            { v: ' , 2 AS INJ -- ' }],
        // MariaDB runs a bare /*M! as code, sql-escaper reads it as a comment
        ['a quote in a bare /*M!', "SELECT /*M! 'a */ , ? AS b, ' */ 'c'", [' , 2 AS INJ, ']],
        // an opener inside a string with no */ after it
        ['/*+ inside a LIKE pattern', "SELECT * FROM t WHERE a LIKE '%/*+%' AND id = ?", [1]],
        // the text is searched as it is: a /*+ inside a string counts too
        ['/*+ inside a string', "SELECT '/*+', ?", [CLOSE]]
    ])('%s', async (_where, sql, values) => {
        const { cluster, poolQuery } = makeCluster();
        const lookup = jest.spyOn(cluster as any, '_getActivePools');

        const error = await cluster.query(sql, values as any, { redis: true })
            .catch(thrown => thrown);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe('MDC_UNSAFE_COMMENT_VALUE');
        expect(error.message).toBe(DESYNC);
        expect(lookup).not.toHaveBeenCalled();
        expect(Redis.get).not.toHaveBeenCalled();
        expect(poolQuery).not.toHaveBeenCalled();
        expect(Metrics.recordQuery).toHaveBeenCalledTimes(1);
        const [[, options]] = (Metrics.recordQuery as jest.Mock).mock.calls;
        expect(options.error).toBe(error);
    });

    // balanced quotes end inside the comment: both read the rest of the text the same way
    it.each([
        ['SET_VAR with a quoted value and :ms',
            "SELECT /*+ SET_VAR(sql_mode = 'ANSI') MAX_EXECUTION_TIME(:ms) */ 1", { ms: 1000 },
            "SELECT /*+ SET_VAR(sql_mode = 'ANSI') MAX_EXECUTION_TIME(1000) */ 1"],
        ['BKA with a backtick and ?', 'SELECT /*+ BKA(`t`) */ a FROM t WHERE b = ?', [1],
            'SELECT /*+ BKA(`t`) */ a FROM t WHERE b = 1'],
        ['QB_NAME with a double quote and ?', 'SELECT /*+ QB_NAME("q") */ a FROM t WHERE b = ?',
            [1], 'SELECT /*+ QB_NAME("q") */ a FROM t WHERE b = 1'],
        ['an apostrophe in /*!99999 */ closed in it',
            "SELECT 1 /*!99999 'it''s' */ AS a FROM t WHERE id = ?", [1],
            "SELECT 1 /*!99999 'it''s' */ AS a FROM t WHERE id = 1"],
        ['a bare /*M! with balanced quotes', "SELECT /*M! 'a' */ 1, ?", [1],
            "SELECT /*M! 'a' */ 1, 1"],
        ['a quote after the end of the hint', "SELECT /*+ BKA(t) */ 'x', ?", [1],
            "SELECT /*+ BKA(t) */ 'x', 1"]
    ])('%s is written', async (_where, sql, values, expected) => {
        const { sent } = makeCluster();
        expect(await sent(sql, values)).toBe(expected);
    });

    it.each([
        ['no values', "SELECT /*+ BKA(') */ 1", undefined],
        ['values that write nothing', "SELECT /*+ BKA(') */ 1", []],
        ['a :name the object does not have', "SELECT /*+ BKA(') */ :x", { y: 1 }]
    ])('an apostrophe in a hint with %s is sent as it is', async (_where, sql, values) => {
        const { sent } = makeCluster();
        expect(await sent(sql, values)).toBe(sql);
    });

    it('an apostrophe in a hint with execute() is sent as it is', async () => {
        const { cluster, poolQuery } = makeCluster();
        await cluster.execute("SELECT /*+ BKA(') */ ?", [1]);
        expect(poolQuery.mock.calls[0][0]).toBe("SELECT /*+ BKA(') */ ?");
    });
});

describe('everything else is written as before', () => {
    it.each([
        ['MAX_EXECUTION_TIME(:ms) with a number', 'SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1',
            { ms: 1000 }, 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'],
        ['MAX_EXECUTION_TIME(?) with a number', 'SELECT /*+ MAX_EXECUTION_TIME(?) */ 1', [1000],
            'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'],
        ['values as a string', 'SELECT /*+ QB_NAME(?) */ 1', 'qb', "SELECT /*+ QB_NAME('qb') */ 1"],
        ['??', 'SELECT /*+ BKA(??) */ * FROM t', ['t'], 'SELECT /*+ BKA(`t`) */ * FROM t'],
        ['a plain object after SET', 'UPDATE t /*+ BKA(t) */ SET ?', [{ a: 1, b: 'x' }],
            "UPDATE t /*+ BKA(t) */ SET `a` = 1, `b` = 'x'"],
        ['a value with * and / apart', 'SELECT /*+ QB_NAME(?) */ 1', ['a*b/c'],
            "SELECT /*+ QB_NAME('a*b/c') */ 1"],
        // no /*+ and no /*! with a version in the statement
        ['a */ in a statement with no comment', 'SELECT ? AS a', [CLOSE],
            "SELECT '*/ , 1 AS injected -- ' AS a"],
        ['a :name with */ in a statement with no comment', 'SELECT :v AS a', { v: CLOSE },
            "SELECT '*/ , 1 AS injected -- ' AS a"],
        ['a */ in a statement with a plain /* */ comment', 'SELECT /* note */ ? AS a', [CLOSE],
            "SELECT /* note */ '*/ , 1 AS injected -- ' AS a"],
        // the server runs /*! */: the quotes of the value hold
        ['a */ in /*! */', 'SELECT 2 AS a /*! , ? AS b */', [CLOSE],
            "SELECT 2 AS a /*! , '*/ , 1 AS injected -- ' AS b */"],
        ['a :name with */ in /*! */', 'SELECT 2 AS a /*! , :v AS b */', { v: CLOSE },
            "SELECT 2 AS a /*! , '*/ , 1 AS injected -- ' AS b */"],
        // /*! with a space before the digits is run as code too
        ['a */ in /*! 99999 */', 'SELECT 2 AS a /*! 99999 , ? AS b */', [CLOSE],
            "SELECT 2 AS a /*! 99999 , '*/ , 1 AS injected -- ' AS b */"],
        // a /*+ inside a value is a string to the server
        ['a value holding /*+', 'SELECT ? AS a', ['/*+ x */'], "SELECT '/*+ x */' AS a"],
        // sql-escaper reads /*M! as a plain comment: a ? in it stays text
        ['a ? inside /*M! */', 'SELECT 2 AS a /*M!? */', [999999], 'SELECT 2 AS a /*M!? */']
    ])('%s', async (_where, sql, values, expected) => {
        const { sent } = makeCluster();
        expect(await sent(sql, values)).toBe(expected);
    });

    it('execute() sends the text as it is', async () => {
        const { cluster, poolQuery } = makeCluster();
        await cluster.execute('SELECT 1 AS a /*+ ? */', [CLOSE]);
        expect(poolQuery.mock.calls[0][0]).toBe('SELECT 1 AS a /*+ ? */');
    });
});

// The values go into the text once, before the call waits for anything: the text checked is the
// text the node gets and the key of Redis
describe('the values are written into the text once', () => {
    it.each([
        ['a ?', 'SELECT 1 /*+ ? */', (value: object) => [value]],
        ['a :name', 'SELECT 1 /*+ :v */', (value: object) => ({ v: value })],
        ['a ? in a statement with no comment', 'SELECT ?', (value: object) => [value]]
    ])('one toSqlString() call for %s', async (_where, sql, valuesOf) => {
        const { sent } = makeCluster();
        let calls = 0;
        // safe the first time, a */ after it
        const value = { toSqlString: () => (calls++ === 0 ? "'safe'" : `'${CLOSE}'`) };

        const text = await sent(sql, valuesOf(value));

        expect(calls).toBe(1);
        expect(text).toContain("'safe'");
    });

    it('a change to an array of values after the call does not reach the text', async () => {
        const { cluster, poolQuery } = makeCluster();
        const values = ['safe'];

        const call = cluster.query('SELECT 1 AS a /*+ ? */', values);
        values[0] = CLOSE;
        await call;

        expect(poolQuery.mock.calls[0][0]).toBe("SELECT 1 AS a /*+ 'safe' */");
    });

    it('a change to an object of values after the call does not reach the text', async () => {
        const { cluster, poolQuery } = makeCluster();
        const values = { v: 'safe' };

        const call = cluster.query('SELECT 1 AS a /*+ :v */', values);
        values.v = CLOSE;
        await call;

        expect(poolQuery.mock.calls[0][0]).toBe("SELECT 1 AS a /*+ 'safe' */");
    });

    it('the stale data of Redis is read with the same text, no node being valid', async () => {
        const { cluster } = makeCluster(false, true);
        (Redis.get as jest.Mock).mockResolvedValueOnce(null);
        let calls = 0;
        const value = { toSqlString: () => (calls++ === 0 ? "'safe'" : `'${CLOSE}'`) };

        const error = await cluster.query('SELECT 1 AS a /*+ ? */', [value])
            .catch(thrown => thrown);

        expect(error.code).toBe('MDC_NO_NODE_AVAILABLE');
        expect(Redis.get).toHaveBeenCalledWith("SELECT 1 AS a /*+ 'safe' */");
        expect(calls).toBe(1);
    });
});
