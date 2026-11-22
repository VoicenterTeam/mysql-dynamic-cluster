import fs from 'fs';
import mysql from 'mysql2/promise';

// What the suites in tests/galera share. They run on the three-node rig of tests/rig/galera.sh
// and are skipped unless MDC_TEST_GALERA is set. See docs/testing.md

// The env file the rig writes: MDC_RIG_ENV, else the default path of galera.sh
const envFile = (): string => process.env.MDC_RIG_ENV || (process.env.MDC_RIG_STATE ||
    `${process.env.TMPDIR || '/tmp'}/${process.env.MDC_RIG_NAME || 'mdc-rig'}-state`) + '/rig.env';

export const readEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(envFile(), 'utf8').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    return env;
};

export const logger = () => ({
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()
});

// A connection of root to node n, apart from the cluster under test: to create tables and
// routines, to isolate a node, to count rows and to be the other session of a scenario
export const rootTo = (env: Record<string, string>, n: number): Promise<mysql.Connection> =>
    mysql.createConnection({
        host: env.MDC_GALERA_HOST,
        port: Number(env['MDC_GALERA_PORT' + n]),
        user: 'root',
        password: env.MDC_GALERA_ROOT_PASSWORD,
        database: env.MDC_GALERA_DATABASE
    });

// Poll until `done` says yes, every 20 ms, for `ms` at most
export const until = async (
    done: () => boolean | Promise<boolean>, what: string, ms: number
): Promise<void> => {
    for (const end = Date.now() + ms; !(await done());) {
        if (Date.now() > end) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

// Wait until each node answers `sql`, as root, with a first column above 0: what one node
// created has reached them all
export const untilEveryNode = async (
    env: Record<string, string>, sql: string, what: string
): Promise<void> => {
    for (const n of [1, 2, 3]) {
        const root = await rootTo(env, n);
        try {
            await until(async () => {
                const [rows] = await root.query(sql) as any;
                return Number(Object.values(rows[0])[0]) > 0;
            }, `${what} on node ${n}`, 10000);
        } finally {
            await root.end();
        }
    }
};

// One suite at a time on the rig: jest runs the files side by side, and a suite that takes a
// node out of the cluster would break one that counts the nodes. describeRig takes a lock
// before the hooks of its block and gives it back after them. The lock is a directory next
// to the env file. A lock whose process is gone is taken over
const lock = (): string => envFile() + '.lock';

// The pid in the lock. Undefined when the lock was just made and the pid is not written yet,
// or just removed
const holder = (): number | undefined => {
    try {
        return Number(fs.readFileSync(lock() + '/pid', 'utf8')) || undefined;
    } catch {
        return undefined;
    }
};

const gone = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
};

// Remove the lock of a process that is gone. Under a second lock, and only when the lock still
// names that process: a waiter that read the pid, then waited, would otherwise remove the lock
// another waiter took in between
const takeOver = (pid: number): void => {
    const guard = lock() + '.takeover';
    try {
        fs.mkdirSync(guard);
    } catch (error) {
        if (error.code === 'EEXIST') return;
        throw error;
    }
    try {
        if (holder() === pid && gone(pid)) fs.rmSync(lock(), { recursive: true, force: true });
    } finally {
        fs.rmSync(guard, { recursive: true, force: true });
    }
};

const take = (): boolean => {
    try {
        fs.mkdirSync(lock());
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = holder();
        if (pid !== undefined && gone(pid)) takeOver(pid);
        return false;
    }
    fs.writeFileSync(lock() + '/pid', String(process.pid));
    return true;
};

// Run every step of a cleanup in order, also after one that failed, then fail with the first
// error: an afterAll that stops half way leaves tables, routines and open handles behind
export const cleanUp = async (...steps: (() => unknown)[]): Promise<void> => {
    const errors: unknown[] = [];
    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) throw errors[0];
};

export const describeRig = (name: string, suite: () => void): void => {
    if (!process.env.MDC_TEST_GALERA) return describe.skip(name, suite);
    describe(name, () => {
        let held = false;
        beforeAll(async () => {
            try {
                await until(() => (held = take()), 'the other suites on the rig', 280000);
            } catch (error) {
                throw new Error(`${error.message}: the lock ${lock()} is held by pid ` +
                    `${holder() ?? 'unknown'}. Once no suite runs, remove it, and ` +
                    `${lock()}.takeover if that is there`);
            }
        }, 290000);
        suite();
        // never the lock of another suite, when this one gave up waiting
        afterAll(() => {
            if (held) fs.rmSync(lock(), { recursive: true, force: true });
            held = false;
        });
    });
};
