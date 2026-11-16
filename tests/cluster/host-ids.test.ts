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
    it.each([
        ['after a higher id', [{ id: 5 }, { id: 0 }], [5, 0]],
        ['as the only host', [{ id: 0 }], [0]],
        ['between two other ids', [{ id: 2 }, { id: 0 }, { id: 7 }], [2, 0, 7]]
    ])('id 0 is kept %s', (_name, hosts, ids) => {
        expect(idsOf(hosts)).toEqual(ids);
    });

    it.each([
        ['before the host with id 0', [{}, { id: 0 }], [1, 0]],
        ['after the host with id 0', [{ id: 0 }, {}], [0, 1]],
        ['when 0 is not the highest id', [{ id: 0 }, { id: 5 }, {}], [0, 5, 6]]
    ])('a host without an id gets an id that is not 0, %s', (_name, hosts, ids) => {
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
