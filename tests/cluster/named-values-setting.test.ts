import { createPoolCluster } from '../../index';

// No mocks: the cluster the app gets, built by createPoolCluster. Only its pool is replaced, by
// one that records the sql it gets
const SQL = 'SELECT * FROM t WHERE name = :n';
const QUOTE = "x' OR '1'='1";
const ESCAPED = "SELECT * FROM t WHERE name = 'x\\' OR \\'1\\'=\\'1'";

const settings = (extra: object = {}): any => ({
    clusterName: 'test',
    hosts: [{ host: '127.0.0.1' }],
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
    useClusterHashing: false,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...extra
});

describe('named values through createPoolCluster', () => {
    it('are escaped, with no setting', async () => {
        const cluster: any = createPoolCluster(settings());
        const poolQuery = jest.fn().mockResolvedValue([]);
        const pool = { id: 1, status: { isValid: true, loadScore: 0 }, query: poolQuery };
        cluster.pools.splice(0, cluster.pools.length, pool);

        await cluster.query(SQL, { n: QUOTE });

        expect(poolQuery.mock.calls[0][0]).toBe(ESCAPED);
    });

    it('the escapeNamedValues setting of 4.x is refused', () => {
        expect(() => createPoolCluster(settings({ escapeNamedValues: true })))
            .toThrow('Unrecognized key: "escapeNamedValues"');
    });
});
