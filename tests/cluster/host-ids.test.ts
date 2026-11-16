import { createPoolCluster } from '../../index';

// No mocks and no connection: the cluster built by createPoolCluster, read before connect()
const idsOf = (hosts: object[]): number[] => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: hosts.map(host => ({ host: '127.0.0.1', ...host })),
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    return cluster.pools.map((pool: any) => pool.id);
};

describe('host ids', () => {
    // id 0 counts as not set, as it always did. Changing that renumbers nodes that an
    // existing hashing database already knows under their old id, see issue #29
    it.each([
        ['after a higher id', [{ id: 5 }, { id: 0 }], [5, 6]],
        ['as the only host', [{ id: 0 }], [0]],
        ['in a list numbered from 0', [{ id: 0 }, { id: 1 }, { id: 2 }], [3, 1, 2]],
        ['before a host without an id', [{ id: 0 }, { id: 5 }, {}], [6, 5, 7]]
    ])('id 0 is treated as no id %s', (_name, hosts, ids) => {
        expect(idsOf(hosts)).toEqual(ids);
    });

    it.each([
        ['no host', [], []],
        ['no host has an id', [{}, {}, {}], [0, 1, 2]],
        ['an id comes first', [{ id: 5 }, {}], [5, 6]],
        ['an id comes last', [{}, { id: 5 }], [6, 5]],
        ['ids and gaps are mixed', [{ id: 3 }, {}, { id: 1 }, {}], [3, 4, 1, 5]],
        ['an id is set to undefined', [{ id: undefined }, { id: 4 }], [5, 4]]
    ])('auto-assigned ids stay as they were when %s', (_name, hosts, ids) => {
        expect(idsOf(hosts)).toEqual(ids);
    });

    it('rejects an id that is not a number, by the path of the host', () => {
        expect(() => idsOf([{ id: '0' }])).toThrow('hosts[0].id');
    });
});
