import { createPoolCluster } from '../../index';

// No mocks: the cluster the app gets, built by createPoolCluster, whose constructor reads the setting.
// Only its pool is replaced, by one that records the sql it gets
const SQL = 'SELECT * FROM t WHERE name = :n';
const QUOTE = "x' OR '1'='1";
const ESCAPED = "SELECT * FROM t WHERE name = 'x\\' OR \\'1\\'=\\'1'";
const AS_TEXT = "SELECT * FROM t WHERE name = x' OR '1'='1";

const sentBy = async (settings: object, options?: any): Promise<string> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1' }],
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        ...settings
    } as any);
    const poolQuery = jest.fn().mockResolvedValue([]);
    cluster.pools.splice(0, cluster.pools.length, { id: 1, status: { isValid: true, loadScore: 0 }, query: poolQuery });
    await cluster.query(SQL, { n: QUOTE }, options);
    return poolQuery.mock.calls[0][0];
};

describe('the escapeNamedValues setting, through createPoolCluster', () => {
    it('on: the cluster escapes named values', async () => {
        expect(await sentBy({ escapeNamedValues: true })).toBe(ESCAPED);
    });

    it('on: a query option still turns it off', async () => {
        expect(await sentBy({ escapeNamedValues: true }, { escapeNamedValues: false })).toBe(AS_TEXT);
    });

    it('left out: the cluster does not escape', async () => {
        expect(await sentBy({})).toBe(AS_TEXT);
    });

    it('left out: a query option turns it on', async () => {
        expect(await sentBy({}, { escapeNamedValues: true })).toBe(ESCAPED);
    });
});
