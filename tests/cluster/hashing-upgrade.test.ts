jest.mock('../../src/utils/Logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { ClusterHashing } from '../../src/cluster/ClusterHashing';
import Logger from '../../src/utils/Logger';

const sql = (file: string) =>
    readFileSync(join(__dirname, '../../assets/sql/create_hashing_database', file)).toString();

// hashing built without the config singletons; the schema is already at the current version
const makeHashing = (query: jest.Mock): ClusterHashing => {
    const hashing = new ClusterHashing({
        pools: [{ id: 1, name: 'a', host: 'h1', port: 3306 }, { id: 2, name: 'b', host: 'h2', port: 33061 }],
        query
    } as any, 'c', { nextCheckTime: 5000, dbName: 'mdc' } as any);
    (hashing as any)._isDatabaseVersionEquals = jest.fn().mockResolvedValue(true);
    return hashing;
};

describe('hashing schema upgrade', () => {
    beforeEach(() => jest.clearAllMocks());

    it('schema version is 2, so schemas built by 3.2.1 are rebuilt with the fixed function', () => {
        expect((makeHashing(jest.fn()) as any)._databaseVersion).toBe(2);
    });

    it('port columns take any TCP port (33061 > signed smallint max 32767)', () => {
        expect(sql('tables/node.sql')).toMatch(/port\s+smallint unsigned/i);
        expect(sql('routines/SP_NodeInsert.sql')).toMatch(/_Port\s+smallint unsigned/i);
    });

    it('node inserts are awaited and a failed insert is logged, not left unhandled', async () => {
        const query = jest.fn().mockRejectedValue(new Error("Out of range value for column '_Port'"));
        await (makeHashing(query) as any)._insertNodes();
        expect(query).toHaveBeenCalledTimes(2);
        expect((Logger.error as jest.Mock).mock.calls.map(c => c[0])).toContain("Out of range value for column '_Port'");
    });

    it('connected is false when the first hashing check fails', async () => {
        const query = jest.fn(async (q: string) => {
            if (q.includes('FN_GetServiceNodeMapping')) throw new Error('FUNCTION FN_GetServiceNodeMapping does not exist');
            return [];
        });
        const hashing = makeHashing(query);
        await hashing.connect();
        expect(hashing.connected).toBe(false);
        hashing.stop();
    });

    it('connected is true after a successful hashing check', async () => {
        const query = jest.fn(async (q: string) =>
            q.includes('FN_GetServiceNodeMapping') ? [{ Result: [{ ServiceID: 5, NodeID: 1 }] }] : []);
        const hashing = makeHashing(query);
        await hashing.connect();
        expect(hashing.connected).toBe(true);
        expect(hashing.getNodeByService(5)).toBe(1);
        hashing.stop();
    });
});
