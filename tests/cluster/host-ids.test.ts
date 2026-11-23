import { createPoolCluster } from '../../index';

// No mocks and no connection: the cluster built by createPoolCluster, read before connect()
const build = (hosts: object[], useClusterHashing = false) => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: hosts.map(host => ({ host: '127.0.0.1', ...host })),
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
        useClusterHashing,
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
    ])('which id a host without an id gets when %s', (_name, hosts, ids) => {
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

// The warnings about host ids, every one the app's logger got: one per host at most (#71)
const idWarnings = (hosts: object[], useClusterHashing = false): string[] =>
    build(hosts, useClusterHashing).logger.warn.mock.calls.map(call => String(call[0]));
const uses = (host: string, id: number, which: string) =>
    `Host ${host} uses the id ${id}, which ${which}`;
// an id the cluster gave, to a host without one or to one whose id 0 it replaced
const got = (host: string, id: number, which: string) =>
    `Host ${host} got the id ${id}, which ${which}`;
const zeroGot = (host: string, id: number, which?: string) =>
    `Host ${host} has id 0, which counts as not set: the node got the id ${id}`
    + (which ? `, which ${which}` : '');
const NEGATIVE = 'is negative';
const FRACTION = 'is not an integer';
const SHARED = 'is the id of another host too';
const ABOVE = 'is above 127, the highest id cluster hashing takes';

describe('host ids that are kept, with a warning', () => {
    it.each([
        ['a negative id', [{ id: -1 }, { id: 0 }], [-1, 0],
            [uses('127.0.0.1:3306', -1, NEGATIVE)]],
        ['an id that is not an integer', [{ id: 1.5 }, { id: 3 }], [1.5, 3],
            [uses('127.0.0.1:3306', 1.5, FRACTION)]],
        ['an id that two hosts have', [{ host: 'a', id: 2 }, { host: 'b', id: 2 }, { id: 0 }],
            [2, 2, 3],
            [uses('a:3306', 2, SHARED), uses('b:3306', 2, SHARED), zeroGot('127.0.0.1:3306', 3)]],
        // the id 0 got the next id after -3, which is negative too: one line for that host
        ['an id 0 replaced by a negative one', [{ id: -3 }, { id: 0 }], [-3, -2],
            [uses('127.0.0.1:3306', -3, NEGATIVE), zeroGot('127.0.0.1:3306', -2, NEGATIVE)]],
        ['an id given after one that is not an integer', [{ id: 1.5 }, {}], [1.5, 2.5],
            [uses('127.0.0.1:3306', 1.5, FRACTION), got('127.0.0.1:3306', 2.5, FRACTION)]],
        ['an id that breaks several rules, in one line', [{ id: -1.5 }, { id: -1.5, port: 3307 }],
            [-1.5, -1.5], [
                uses('127.0.0.1:3306', -1.5, `${NEGATIVE} and ${FRACTION} and ${SHARED}`),
                uses('127.0.0.1:3307', -1.5, `${NEGATIVE} and ${FRACTION} and ${SHARED}`)
            ]]
    ])('warns once per host for %s, and keeps the ids', (_name, hosts, ids, warnings) => {
        expect(idsOf(hosts)).toEqual(ids);
        expect(idWarnings(hosts)).toEqual(warnings);
    });

    it.each([
        ['an id above 127', [{ id: 128 }], [uses('127.0.0.1:3306', 128, ABOVE)]],
        ['an id given after 127', [{ id: 127 }, {}], [got('127.0.0.1:3306', 128, ABOVE)]],
        ['an id 0 replaced by one above 127', [{ id: 127 }, { id: 0 }],
            [zeroGot('127.0.0.1:3306', 128, ABOVE)]],
        ['no id above 127', [{ id: 1 }, { id: 126 }, {}], []]
    ])('with cluster hashing on, warns for %s', (_name, hosts, warnings) => {
        expect(idWarnings(hosts, true)).toEqual(warnings);
    });

    it('does not warn for an id above 127 with cluster hashing off', () => {
        expect(idsOf([{ id: 128 }, {}])).toEqual([128, 129]);
        expect(idWarnings([{ id: 128 }, {}])).toEqual([]);
    });

    it.each([
        ['no host has an id', [{}, {}, {}]],
        ['every host has an id of its own', [{ id: 1 }, { id: 2 }, { id: 3 }]],
        ['ids and hosts without an id are mixed', [{ id: 3 }, {}, { id: 1 }, {}]],
        ['the id 0 is kept', [{ id: 0 }, {}]],
        ['no host', []]
    ])('does not warn when %s', (_name, hosts) => {
        expect(idWarnings(hosts)).toEqual([]);
        expect(idWarnings(hosts, true)).toEqual([]);
    });
});
