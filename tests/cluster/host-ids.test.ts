import { createPoolCluster } from '../../index';

// No mocks and no connection: the cluster built by createPoolCluster, read before connect()
const build = (hosts: object[]) => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: hosts.map(host => ({ host: '127.0.0.1', ...host })),
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
        useClusterHashing: false,
        logger
    } as any);
    return { ids: cluster.pools.map((pool: any) => pool.id) as number[], logger };
};
const idsOf = (hosts: object[]): number[] => build(hosts).ids;
// the warnings about a replaced id 0, as the app's logger got them
const zeroWarnings = (hosts: object[]): string[] => build(hosts).logger.warn.mock.calls
    .map(call => String(call[0]))
    .filter(message => message.includes('has id 0'));

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

    const warning = (host: string, id: number) =>
        `Host ${host} has id 0, which counts as not set: the node got the id ${id}`;

    it.each([
        ['beside ids that are not 0', [{ host: 'db-zero.example', id: 0 }, { id: 1 }, { id: 2 }],
            [warning('db-zero.example:3306', 3)]],
        ['with its own port in the line', [{ id: 5 }, { id: 0, port: 3307 }],
            [warning('127.0.0.1:3307', 6)]],
        ['once per host', [{ id: 0 }, { id: 5 }, { id: 0 }],
            [warning('127.0.0.1:3306', 6), warning('127.0.0.1:3306', 7)]],
        // no host wrote another id, and the 0 still moves: the first host took 0
        ['after a host without an id', [{}, { id: 0 }], [warning('127.0.0.1:3306', 1)]],
        ['after another id 0', [{ id: 0 }, { id: 0 }], [warning('127.0.0.1:3306', 1)]]
    ])('warns when an id 0 is replaced %s', (_name, hosts, warnings) => {
        expect(zeroWarnings(hosts)).toEqual(warnings);
    });

    it.each([
        ['the id 0 is kept', [{ id: 0 }, {}]],
        ['the id 0 is the only host', [{ id: 0 }]],
        ['no host wrote an id', [{}, {}]],
        ['an id is set to undefined beside another id', [{ id: undefined }, { id: 4 }]]
    ])('does not warn when %s', (_name, hosts) => {
        expect(zeroWarnings(hosts)).toEqual([]);
    });

    it('rejects an id that is not a number, by the path of the host', () => {
        expect(() => idsOf([{ id: '0' }])).toThrow('hosts[0].id');
    });
});
