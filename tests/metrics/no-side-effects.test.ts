import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '../..');

// Loads the package entry point from the sources in a clean Node process, outside jest's module registry
const loadPackage = `
const ts = require('typescript');
const fs = require('fs');
require.extensions['.ts'] = (module, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2015 },
        fileName: filename
    });
    module._compile(out.outputText, filename);
};
const count = () => ['unhandledRejection', 'uncaughtException'].map(event => process.listenerCount(event));
const before = count();
const lib = require('./index.ts');
`;

const run = (script: string) => spawnSync(process.execPath, ['-e', loadPackage + script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
});

describe('requiring the package', () => {
    it('adds no process listeners and loads neither @pm2/io, a log transport nor an OpenTelemetry SDK', () => {
        const res = run(`
            const loaded = Object.keys(require.cache);
            console.log(JSON.stringify({
                exported: typeof lib.createPoolCluster,
                before,
                after: count(),
                pm2: loaded.filter(file => file.includes('@pm2')),
                transports: loaded.filter(file => /node_modules[\\\\/](winston|@voicenter-team[\\\\/]failover-amqp-pool)[\\\\/]/.test(file)),
                sdk: loaded.filter(file => /@opentelemetry[\\\\/]sdk-/.test(file)),
                api: loaded.some(file => /@opentelemetry[\\\\/]api/.test(file))
            }));
            process.exit(0);
        `);

        const out = JSON.parse(res.stdout);
        expect(out.exported).toBe('function');
        expect(out.after).toEqual(out.before);
        expect(out.after).toEqual([0, 0]);
        expect(out.pm2).toEqual([]);
        expect(out.transports).toEqual([]);
        expect(out.sdk).toEqual([]);
        expect(out.api).toBe(true);
    });

    it('leaves Node crashing on an unhandled rejection', () => {
        const res = run(`
            Promise.reject(new Error('boom'));
            setTimeout(() => { console.log('still alive'); process.exit(0); }, 300);
        `);

        expect(res.stdout).not.toContain('still alive');
        // Node exits 1 on an unhandled rejection
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('boom');
    });
});
