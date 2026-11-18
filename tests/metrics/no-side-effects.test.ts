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

// Goes in front of loadPackage. Counts every timer started from then on, also one that is
// unref'd: such a timer does not keep the process alive and is not among the active resources.
// process.getActiveResourcesInfo is in every Node version that runs this jest
const watchTimers = `
const startedTimers = [];
for (const name of ['setTimeout', 'setInterval']) {
    const original = global[name];
    const watched = function (...args) {
        startedTimers.push(name);
        return original.apply(this, args);
    };
    global[name] = watched;
    require('timers')[name] = watched;
}
const activeTimers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout');
const timers = () => ({ started: startedTimers.slice(), active: activeTimers() });
`;

// Hands Metrics a pool, as a cluster does on connect()
const registerPool = `
const stats = () => ({ used: 0, idle: 0, pending: 0 });
const pool = { name: 'node1', host: 'db1.example', port: 3306, connectionLimit: 1, stats };
require('./src/metrics/Metrics.ts').default.registerPools([pool]);
`;

const run = (script: string, before: string = '') => {
    return spawnSync(process.execPath, ['-e', before + loadPackage + script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000
    });
};

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

    it('starts no timer, when it loads and when pools are registered', () => {
        const res = run(`
            const atLoad = timers();
            ${registerPool}
            console.log(JSON.stringify({ atLoad, registered: timers() }));
            process.exit(0);
        `, watchTimers);

        const out = JSON.parse(res.stdout);
        expect(out.atLoad).toEqual({ started: [], active: [] });
        expect(out.registered).toEqual({ started: [], active: [] });
    });

    it('starts no timer when a health check is recorded', () => {
        const res = run(`
            ${registerPool}
            const check = { poolName: 'node1', host: 'db1.example', port: 3306, result: 'valid' };
            require('./src/metrics/Metrics.ts').default.recordHealthCheck(0.01, check);
            console.log(JSON.stringify(timers()));
            process.exit(0);
        `, watchTimers);

        expect(JSON.parse(res.stdout)).toEqual({ started: [], active: [] });
    });

    it('lets the process end on its own, with pools registered and no process.exit', () => {
        const res = run(registerPool + `console.log('registered');`);

        expect(res.stdout).toContain('registered');
        // a timer that is still running leaves the child to the timeout, which ends it by signal
        expect(res.signal).toBeNull();
        expect(res.status).toBe(0);
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
