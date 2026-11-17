import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '../..');

// A clean Node process, outside jest: there an unhandled rejection ends the process with exit 1.
// The cluster is built by createPoolCluster and every pool fails to connect, without a socket
const setup = `
const ts = require('typescript');
const fs = require('fs');
require.extensions['.ts'] = (module, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2015
        },
        fileName: filename
    });
    module._compile(out.outputText, filename);
};
const lib = require('./index.ts');
const quiet = () => undefined;
const cluster = lib.createPoolCluster({
    clusterName: 'test',
    hosts: [{ host: '127.0.0.1', id: 1 }, { host: '127.0.0.1', id: 2 }],
    defaultPoolSettings: { user: 'u', password: 'p', database: 'd' },
    useClusterHashing: false,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet }
});
cluster.pools.forEach(pool => {
    pool.connect = () => Promise.reject(new Error('refused by node ' + pool.id));
});
// an unhandled rejection is reported after the microtasks of a turn, so three turns show it
const afterTurns = (count, done) => {
    return count ? setImmediate(() => afterTurns(count - 1, done)) : done();
};
const finish = () => afterTurns(3, () => { console.log('alive'); process.exit(0); });
`;

const run = (script: string) => spawnSync(process.execPath, ['-e', setup + script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
});

describe('a cluster whose pools all fail to connect', () => {
    it('leaves no unhandled rejection when the app never reads ready', () => {
        const res = run(`
            cluster.connect().catch(quiet);
            finish();
        `);

        expect(res.stderr).toBe('');
        expect(res.stdout).toBe('alive\n');
        expect(res.status).toBe(0);
    });

    it('leaves none when the app reads ready and never handles a rejection of it', () => {
        const res = run(`
            cluster.connect().catch(quiet);
            cluster.ready.then(results => {
                console.log(JSON.stringify(results.map(r => [r.nodeId, r.ok, r.error.message])));
                finish();
            });
        `);

        expect(res.stderr).toBe('');
        expect(res.stdout).toBe(
            '[[1,false,"refused by node 1"],[2,false,"refused by node 2"]]\nalive\n'
        );
        expect(res.status).toBe(0);
    });

    // the control: this harness sees an unhandled rejection. connect() rejects as it always did
    it('still ends the process when the app does not handle the rejection of connect()', () => {
        const res = run(`
            cluster.connect();
            finish();
        `);

        expect(res.stdout).not.toContain('alive');
        expect(res.stderr).toContain('refused by node 1');
        expect(res.status).toBe(1);
    });
});
