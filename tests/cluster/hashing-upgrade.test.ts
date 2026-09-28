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

// what information_schema reports for an existing hashing schema
type Existing = { portType?: string, fnAccess?: string | null, spPortType?: string };
const SCHEMA_BUILT_BY_321: Existing = { portType: 'smallint', fnAccess: null, spPortType: 'smallint' };
const SCHEMA_CURRENT: Existing = { portType: 'smallint unsigned', fnAccess: 'READS SQL DATA', spPortType: 'smallint unsigned' };

const makeQuery = (existing: Existing, fail: (q: string) => Error | undefined = () => undefined) =>
    jest.fn(async (q: string) => {
        const err = fail(q);
        if (err) throw err;
        if (q.includes('information_schema.COLUMNS')) return existing.portType ? [{ type: existing.portType }] : [];
        if (q.includes('information_schema.ROUTINES')) return existing.fnAccess ? [{ access: existing.fnAccess }] : [];
        if (q.includes('information_schema.PARAMETERS')) return existing.spPortType ? [{ type: existing.spPortType }] : [];
        if (q.includes('FN_GetServiceNodeMapping() AS Result')) return [{ Result: [{ ServiceID: 5, NodeID: 1 }] }];
        return [];
    });

// hashing built without the config singletons; the schema already exists at the current version
const makeHashing = (query: jest.Mock): ClusterHashing => {
    const hashing = new ClusterHashing({
        pools: [{ id: 1, name: 'a', host: 'h1', port: 3306 }, { id: 2, name: 'b', host: 'h2', port: 33061 }],
        query
    } as any, 'c', { nextCheckTime: 5000, dbName: 'mdc' } as any);
    (hashing as any)._isDatabaseVersionEquals = jest.fn().mockResolvedValue(true);
    // the asset path is dist-relative (known-issues #7), so hand the routine files in directly
    (hashing as any)._readFilesInDir = jest.fn(() => ({
        fileNames: ['FN_GetServiceNodeMapping', 'SP_NodeInsert', 'SP_RemoveNode'],
        fileContents: ['create function FN_GetServiceNodeMapping() ...', 'create procedure SP_NodeInsert(...) ...', 'create procedure SP_RemoveNode(...) ...']
    }));
    return hashing;
};

const sent = (query: jest.Mock) => query.mock.calls.map(c => c[0] as string);

describe('hashing schema: backward compatible upgrade', () => {
    beforeEach(() => jest.clearAllMocks());

    it('schema version stays 1, so 3.2.1 instances sharing the schema never drop it', () => {
        expect((makeHashing(jest.fn()) as any)._databaseVersion).toBe(1);
    });

    it('new schemas get unsigned port columns and READS SQL DATA', () => {
        expect(sql('tables/node.sql')).toMatch(/port\s+smallint unsigned/i);
        expect(sql('routines/SP_NodeInsert.sql')).toMatch(/_Port\s+smallint unsigned/i);
        expect(sql('routines/FN_GetServiceNodeMapping.sql')).toMatch(/READS SQL DATA/i);
    });

    it('upgrades a schema built by 3.2.1 in place: widens the port, recreates only the outdated routines, drops nothing else', async () => {
        const query = makeQuery(SCHEMA_BUILT_BY_321);
        const hashing = makeHashing(query);
        await hashing.connect();
        const q = sent(query);
        expect(q).toContain('ALTER TABLE node MODIFY port smallint unsigned default 3306 null;');
        expect(q).toContain('DROP FUNCTION IF EXISTS FN_GetServiceNodeMapping;');
        expect(q).toContain('create function FN_GetServiceNodeMapping() ...');
        expect(q).toContain('DROP PROCEDURE IF EXISTS SP_NodeInsert;');
        expect(q).toContain('create procedure SP_NodeInsert(...) ...');
        expect(q.some(s => /DROP (SCHEMA|TABLE)|SP_RemoveNode/i.test(s))).toBe(false);
        hashing.stop();
    });

    it('leaves a current schema alone', async () => {
        const query = makeQuery(SCHEMA_CURRENT);
        const hashing = makeHashing(query);
        await hashing.connect();
        expect(sent(query).some(s => /ALTER|DROP|create /i.test(s))).toBe(false);
        hashing.stop();
    });

    it('a failed upgrade step is logged and does not stop hashing from connecting', async () => {
        const query = makeQuery(SCHEMA_BUILT_BY_321, q => q.startsWith('ALTER') ? new Error('ALTER denied') : undefined);
        const hashing = makeHashing(query);
        await expect(hashing.connect()).resolves.toBeUndefined();
        expect((Logger.error as jest.Mock).mock.calls.map(c => c[0]).join('\n')).toContain('ALTER denied');
        expect(hashing.connected).toBe(true);
        hashing.stop();
    });

    it('node inserts are awaited and a failed insert is logged, not left unhandled', async () => {
        const query = jest.fn().mockRejectedValue(new Error("Out of range value for column '_Port'"));
        await (makeHashing(query) as any)._insertNodes();
        expect(query).toHaveBeenCalledTimes(2);
        expect((Logger.error as jest.Mock).mock.calls.map(c => c[0])).toContain("Out of range value for column '_Port'");
    });

    it('connected is false when the first hashing check fails', async () => {
        const query = makeQuery(SCHEMA_CURRENT, q => q.includes('AS Result') ? new Error('FUNCTION FN_GetServiceNodeMapping does not exist') : undefined);
        const hashing = makeHashing(query);
        await hashing.connect();
        expect(hashing.connected).toBe(false);
        hashing.stop();
    });

    it('connected is true after a successful hashing check', async () => {
        const hashing = makeHashing(makeQuery(SCHEMA_CURRENT));
        await hashing.connect();
        expect(hashing.connected).toBe(true);
        expect(hashing.getNodeByService(5)).toBe(1);
        hashing.stop();
    });
});
