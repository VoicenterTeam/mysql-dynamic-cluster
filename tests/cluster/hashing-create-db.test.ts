jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { ClusterHashing } from '../../src/cluster/ClusterHashing';

// Hashing starts after the first pool that connects, which need not be the first pool of the
// settings. _createDB runs its statements on the first valid pool (#43)
const pool = (id: number, isValid: boolean): any => ({
    id, name: 'node' + id, host: 'host' + id, port: 3306,
    status: { isValid, loadScore: id },
    multiStatementQuery: jest.fn().mockResolvedValue(undefined)
});

// hashing built without the config singletons. The asset path is dist-relative
// (known-issues #7), so the SQL files are handed in directly
const makeHashing = (pools: any[]): any => {
    const hashing: any = new ClusterHashing(
        { pools, query: jest.fn().mockResolvedValue([]) } as any,
        'c', { nextCheckTime: 5000, dbName: 'x' }
    );
    hashing._readFilesInDir = jest.fn(() => ({
        fileNames: ['SP_NodeInsert'], fileContents: ['create procedure SP_NodeInsert() ...']
    }));
    return hashing;
};
const calls = (pools: any[]) => pools.map(candidate => candidate.multiStatementQuery.mock.calls.length);

describe('ClusterHashing._createDB', () => {
    it.each([
        ['the first pool is valid', [true, true, true], [3, 0, 0]],
        ['the first pool is not valid', [false, true, true], [0, 3, 0]],
        ['only the last pool is valid', [false, false, true], [0, 0, 3]]
    ])('runs every statement on the first valid pool when %s', async (_name, valid, expected) => {
        const pools = valid.map((isValid, index) => pool(index + 1, isValid));
        await makeHashing(pools)._createDB();

        expect(calls(pools)).toEqual(expected);
    });

    it('runs nothing on a pool when no pool is valid, and rejects', async () => {
        const pools = [pool(1, false), pool(2, false)];
        const hashing = makeHashing(pools);

        await expect(hashing._createDB()).rejects.toThrow('No valid node');
        expect(calls(pools)).toEqual([0, 0]);
        expect(hashing._cluster.query).toHaveBeenCalledTimes(1);
    });
});
