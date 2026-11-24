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

// A value written inside /*+ */ or /*!NNNNN */ (#134). A server that reads such a comment as a
// plain one ends it at the first */, also one inside the quotes of a value, and runs the rest of
// the value as SQL. MySQL 8.0.42 does so for /*+ */ in any position and for /*!99999 */. So
// query() refuses a value whose text holds */ there. /*! */ is code to the server: not checked.
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

// the value of the rig, whose */ ends the comment
const CLOSE = '*/ , 1 AS injected -- ';
const MESSAGE = 'query: a value inside a /*+ */ or /*!NNNNN */ comment holds */, which ends the ' +
    'comment early on the server. Keep values out of comments';

beforeEach(() => jest.clearAllMocks());

describe('a value whose text holds */ inside /*+ */ or /*!NNNNN */ is refused', () => {
    it.each([
        [':name in the hint position', 'SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1', { ms: CLOSE }],
        [':name after a select item', 'SELECT 1 AS a /*+ :v */', { v: CLOSE }],
        ['? in the hint position', 'SELECT /*+ QB_NAME(?) */ 1', [CLOSE]],
        ['? after a select item', 'SELECT 1 AS a /*+ ? */', [CLOSE]],
        ['?? (an identifier)', 'SELECT 1 AS a /*+ ?? */', ['*/ x']],
        [':name in /*!99999 */', 'SELECT 2 AS a /*!99999 :v */', { v: CLOSE }],
        ['? in /*!99999 */', 'SELECT 2 AS a /*!99999 ? */', [CLOSE]],
        [':name in /*!80000 */', 'SELECT 2 AS a /*!80000 , :v AS b */', { v: CLOSE }],
        ['? in /*!80000 */', 'SELECT 2 AS a /*!80000 , ? AS b */', [CLOSE]],
        ['/*! with one digit', 'SELECT 2 AS a /*!1 , ? AS b */', [CLOSE]],
        ['values as a string', 'SELECT 1 AS a /*+ ? */', CLOSE],
        ['the ? in the comment, after a ? before it', 'SELECT ? AS a /*+ ? */', ['x', CLOSE]],
        ['the ? in the comment, after a ? in quotes', "SELECT '?' AS a /*+ ? */", [CLOSE]],
        ['the ? in the comment, after a ??? that takes no value', 'SELECT 1 ??? /*+ ? */', [CLOSE]],
        ['a plain object after SET inside the comment, as pairs', 'SELECT 1 /*+ SET ? */',
            [{ a: CLOSE }]],
        ['a list of strings for a :name', 'SELECT 1 /*+ :v */', { v: ['x', CLOSE] }],
        ['an unterminated /*+', 'SELECT 1 AS a /*+ ?', [CLOSE]],
        ['only */', 'SELECT 1 AS a /*+ ? */', ['*/']]
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
});

describe('everything else is written as before', () => {
    it.each([
        ['MAX_EXECUTION_TIME(:ms)', 'SELECT /*+ MAX_EXECUTION_TIME(:ms) */ 1', { ms: 1000 },
            'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'],
        ['a ? without */ in /*+ */', 'SELECT /*+ QB_NAME(?) */ 1', ['qb'],
            "SELECT /*+ QB_NAME('qb') */ 1"],
        ['a :name without */ in /*!99999 */', 'SELECT 2 AS a /*!99999 :v */', { v: 'x' },
            "SELECT 2 AS a /*!99999 'x' */"],
        // the server runs /*! */: the quotes of the value hold
        ['a ? with */ in /*! */', 'SELECT 2 AS a /*! , ? AS b */', [CLOSE],
            "SELECT 2 AS a /*! , '*/ , 1 AS injected -- ' AS b */"],
        ['a :name with */ in /*! */', 'SELECT 2 AS a /*! , :v AS b */', { v: CLOSE },
            "SELECT 2 AS a /*! , '*/ , 1 AS injected -- ' AS b */"],
        ['a ? with */ outside any comment', 'SELECT ? AS a', [CLOSE],
            "SELECT '*/ , 1 AS injected -- ' AS a"],
        ['a :name with */ outside any comment', 'SELECT :v AS a', { v: CLOSE },
            "SELECT '*/ , 1 AS injected -- ' AS a"],
        ['a ? with */ after the comment', 'SELECT /*+ BKA(t) */ ? AS a', [CLOSE],
            "SELECT /*+ BKA(t) */ '*/ , 1 AS injected -- ' AS a"],
        // the first value goes to the ? before the comment
        ['a ? with */ before the comment, one without in it', 'SELECT ? AS a /*+ QB_NAME(?) */',
            [CLOSE, 'qb'], "SELECT '*/ , 1 AS injected -- ' AS a /*+ QB_NAME('qb') */"],
        ['a ? in a plain /* */ comment stays text', 'SELECT 1 /* ? */, ?', [CLOSE],
            "SELECT 1 /* ? */, '*/ , 1 AS injected -- '"],
        ['/*+ inside a string', "SELECT '/*+', ?", [CLOSE],
            "SELECT '/*+', '*/ , 1 AS injected -- '"],
        ['/*+ inside a plain comment', 'SELECT /* /*+ */ ?', [CLOSE],
            "SELECT /* /*+ */ '*/ , 1 AS injected -- '"],
        ['/*+ inside a -- comment', 'SELECT 1 -- /*+\n, ?', [CLOSE],
            "SELECT 1 -- /*+\n, '*/ , 1 AS injected -- '"],
        // format() writes a plain object outside an assignment as the string '[object Object]'
        ['a plain object for a ? outside SET', 'SELECT 1 /*+ ? */', [{ a: CLOSE }],
            "SELECT 1 /*+ '[object Object]' */"],
        ['a plain object for a :name', 'SELECT 1 /*+ :v */', { v: { a: CLOSE } },
            "SELECT 1 /*+ '[object Object]' */"],
        ['a ? in the comment that gets no value', 'SELECT ? AS a /*+ ? */', [1],
            'SELECT 1 AS a /*+ ? */'],
        ['a :name in the comment the object does not have', 'SELECT :v /*+ :w */', { v: 1 },
            'SELECT 1 /*+ :w */']
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
