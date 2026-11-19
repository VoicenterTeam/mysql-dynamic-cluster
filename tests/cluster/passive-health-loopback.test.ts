import dns from 'dns';
import mysql from 'mysql2';
import net, { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import { Timer } from '../../src/utils/Timer';

// The cluster of createPoolCluster and the real mysql2 against mysql2's own server class on
// the loopback interface. It shows what passive health does with the errors mysql2 really
// hands a query of the app: a refused connection, a connection the server dropped under
// the query, a deadlock and a refused login. The second half puts a TCP proxy in front of
// the server and gives the pools ten connections, so a check can meet a pooled connection
// the path forgot: there the errors are a real ECONNRESET and a real connect timeout.
// The last part addresses the nodes by a name, and lets that name resolve to an address
// this host has no route to: a real ENETUNREACH, with no packet that leaves the host,
// for a call of the app and for the check that has to open a connection after it.
// The checks of the timer are ten minutes apart, so a status query that reaches the server
// after the one of connect() is a check passive health started. Passive health acts inside
// the callback that fails the call, so a test reads the node as soon as its call rejected
const COM_CHANGE_USER = 0x11;
const LONG = 600000;
const APP_SQL = 'SELECT 1';

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(20000);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach(close => close()));

// mysql2's server class does not count the packets of a client command and says so on stderr.
// Only that line is dropped
const consoleError = console.error;
beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('got packets out of order')) consoleError(...args);
    });
});
afterAll(() => jest.restoreAllMocks());

const column = (name: string) => ({
    catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: '',
    characterSet: 33, columnLength: 384, columnType: 253, flags: 0, decimals: 0
});
// what the health check of a pool wants to see from a node
const STATUS = [
    { Variable_name: 'wsrep_ready', Value: 'ON' },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '1' },
    { Variable_name: 'Connections', Value: '1' },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0' }
];

// What the server does with a query of the app. It answers the status query in every mode
// but the last
type Mode =
    | 'answers'
    // closes the connection under the query, as a server that is killed does
    | 'hangs up'
    // answers with error 1213, as a node does for a deadlock or a certification failure
    | 'deadlocks'
    // answers the change of user ahead of the query with error 1045
    | 'refuses the change of user'
    // answers every new login with error 1045
    | 'refuses the login'
    // takes what it is sent and answers nothing, to the app and to a check alike
    | 'says nothing'
    // keeps every query of the app until answerHeld(), and answers a check at once
    | 'holds the app';

interface IServer {
    port: number, become: (next: Mode) => void,
    // drop the open connections, and with `forGood` take no new one either
    hangUp: (forGood?: boolean) => void,
    logins: () => number, checks: () => number,
    // how many connections are open at the server right now
    open: () => number,
    // answer the queries of the app that 'holds the app' kept, and answer from now on
    answerHeld: () => void,
    // run this once, right after the answer to the next status query was written
    afterNextCheck: (hook: () => void) => void
}
const listen = async (mode: Mode): Promise<IServer> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    const seen = { logins: 0, checks: 0, open: 0 };
    const held: any[] = [];
    let afterCheck: (() => void) | undefined;
    let listening = true;
    const hangUp = (forGood: boolean = false) => {
        if (forGood && listening) server.close();
        listening = listening && !forGood;
        connections.splice(0).forEach(connection => connection.stream.destroy());
    };
    closers.push(() => hangUp(true));
    const refuse = { message: "Access denied for user 'u'@'127.0.0.1'", code: 1045 };
    const answer = (connection: any) => {
        connection.sequenceId = 1;
        connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
    };
    server.on('connection', (connection: any) => {
        connections.push(connection);
        seen.open++;
        connection.stream.on('close', () => seen.open--);
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null, mysqlError?: object) => void) => {
                seen.logins++;
                done(null, mode === 'refuses the login' ? refuse : undefined);
            }
        });
        // the pool changes the user of a connection before a query of its own
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || code !== COM_CHANGE_USER || mode === 'says nothing') return;
            connection.sequenceId = 1;
            if (mode === 'refuses the change of user') return connection.writeError(refuse);
            connection.writeOk();
        });
        connection.on('query', (sql: string) => {
            if (mode === 'says nothing') return;
            const isCheck = sql !== APP_SQL;
            if (isCheck) seen.checks++;
            if (!isCheck && mode === 'hangs up') return connection.stream.destroy();
            if (!isCheck && mode === 'holds the app') return held.push(connection);
            connection.sequenceId = 1;
            if (!isCheck && mode === 'deadlocks') {
                return connection.writeError({ message: 'Deadlock found', code: 1213 });
            }
            connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
            const hook = isCheck ? afterCheck : undefined;
            if (hook) afterCheck = undefined;
            hook?.();
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        hangUp,
        logins: () => seen.logins,
        checks: () => seen.checks,
        open: () => seen.open,
        answerHeld: () => {
            mode = 'answers';
            held.splice(0).forEach(answer);
        },
        afterNextCheck: (hook: () => void) => { afterCheck = hook; }
    };
};

// What the path to a server does. 'passes' hands every byte on. 'resets' answers a new
// connection with a reset. 'swallows' takes a new connection and never says a word on it,
// as a path that drops packets does
type Path = 'passes' | 'resets' | 'swallows';
interface IProxy {
    port: number,
    // Forget the open flows without telling either side, as a balancer or a firewall does
    // after its idle timeout. The next bytes of the client on such a flow get a reset, or
    // no answer when the path swallows. New connections go on as the path says
    forget: () => void,
    // change the path, and forget the open flows
    become: (next: Path) => void,
    // change the path for new connections only: the flows that are open go on
    onlyNew: (next: Path) => void,
    // how many connections this proxy reset
    resets: () => number
}
const proxyTo = async (target: number): Promise<IProxy> => {
    let path: Path = 'passes';
    let resets = 0;
    const flows = new Set<{ client: net.Socket, upstream?: net.Socket, forgotten: boolean }>();
    // a reset, not a close: mysql2 drops a pooled connection that was closed, before any use
    const reset = (client: net.Socket) => {
        resets++;
        (client as any).resetAndDestroy();
    };
    const server = net.createServer(client => {
        client.on('error', () => undefined);
        if (path === 'resets') return reset(client);
        const flow = { client, upstream: undefined as net.Socket, forgotten: false };
        flows.add(flow);
        client.on('close', () => {
            flows.delete(flow);
            flow.upstream?.destroy();
        });
        client.on('data', data => {
            if (!flow.forgotten) return flow.upstream?.write(data);
            if (path !== 'swallows') reset(client);
        });
        if (path === 'swallows') return;
        flow.upstream = net.connect(target, '127.0.0.1');
        flow.upstream.on('error', () => undefined);
        flow.upstream.on('data', data => client.write(data));
        flow.upstream.on('close', () => {
            if (!flow.forgotten) client.destroy();
        });
    });
    const forget = () => flows.forEach(flow => {
        flow.forgotten = true;
        flow.upstream?.destroy();
    });
    closers.push(() => {
        server.close();
        flows.forEach(flow => flow.client.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        forget,
        become: (next: Path) => {
            path = next;
            forget();
        },
        onlyNew: (next: Path) => { path = next; },
        resets: () => resets
    };
};

// Poll until `done` says yes. It gives up after 500 turns, about 5 s, and says what it
// waited for and what it saw instead
const until = async (done: () => boolean, what: string, saw: () => unknown): Promise<void> => {
    for (let turn = 0; turn < 500 && !done(); turn++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!done()) throw new Error('gave up waiting for ' + what + ', saw ' + JSON.stringify(saw()));
};

// a test must not leave timers and sockets behind, whether its connect passed or not
const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));

// every wait the check timer of a node was started with, in order
const timerStart = Timer.prototype.start;
let started: jest.SpyInstance;
beforeEach(() => {
    started = jest.spyOn(Timer.prototype, 'start');
});
afterEach(() => started.mockRestore());
const timerWaits = (): number[] => started.mock.calls.map(([ms]) => ms);

// One node on the port, connected, with one connection at most and with flags, so connect()
// logs in once. fall is 3: no count of failed checks takes this node down with one check
const BLOCK = { interval: LONG, fall: 3 };
const connected = async (port: number, block: object = BLOCK): Promise<any> => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port, id: 1, connectionLimit: 1 }],
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], healthCheck: block
        },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    return cluster;
};
const node = (cluster: any) => {
    const { isValid, checkError } = cluster.nodes()[0];
    return { isValid, checkError };
};
const UP = { isValid: true, checkError: undefined as object };
// A query of the app straight to the pool of the node, which rejects with the error of
// mysql2 as it is: its code, its errno when it is one of a server, and its fatal.
// With no timeout: mysql2 3.24.6 keeps the timer of a query whose connection was lost, and
// a worker of jest would wait for the 120 s of the default queryTimeout before it exits
const appQuery = async (cluster: any): Promise<any[]> => {
    const error = await cluster.pools[0].query(APP_SQL, { timeout: 0 })
        .then((): any => undefined, (e: any) => e);
    return error && [error.code, error.errno > 0 ? error.errno : undefined, error.fatal];
};
// the pool holds no open connection any more, so its next request has to open one
const noIdle = async (cluster: any) => {
    const idle = () => cluster.getPoolStats()[0].idle;
    await until(() => idle() === 0, 'the pool to drop its connection', idle);
};
// a server that took the check of connect() and is gone since
const gone = async (block?: object) => {
    const server = await listen('answers');
    const cluster = await connected(server.port, block);
    server.hangUp(true);
    await noIdle(cluster);
    return { server, cluster };
};

describe('a healthCheck node whose server takes no connection any more', () => {
    it('is down as soon as the first query of the app was refused', async () => {
        const { cluster } = await gone();

        const handedOut = await appQuery(cluster);

        expect(handedOut).toEqual(['ECONNREFUSED', undefined, true]);
        expect(node(cluster).isValid).toBe(false);
    });

    it('is checked at once, and that check sets its checkError', async () => {
        const { cluster } = await gone();
        await appQuery(cluster);

        const checkError = () => node(cluster).checkError;
        await until(() => !!checkError(), 'the check that passive health started', checkError);

        expect(checkError().code).toBe('ECONNREFUSED');
        // the interval after the check of connect(), the check at once, then the interval
        expect(timerWaits()).toEqual([LONG, 0, LONG]);
    });

    it('is down with the first cluster.query too, which rejects as before', async () => {
        const { cluster } = await gone();

        await expect(cluster.query(APP_SQL)).rejects.toThrow('ECONNREFUSED');

        expect(node(cluster).isValid).toBe(false);
    });

    it('is down with the first getConnection(), which hands the error out', async () => {
        const { cluster } = await gone();

        const error = await cluster.getConnection().then((): any => undefined, (e: any) => e);

        expect([error.code, error.fatal, error.nodeId]).toEqual(['ECONNREFUSED', true, 1]);
        expect(node(cluster).isValid).toBe(false);
    });

    it('stays up with passive false, until its checks say otherwise', async () => {
        const { cluster } = await gone({ ...BLOCK, passive: false });

        const handedOut = await appQuery(cluster);

        expect(handedOut).toEqual(['ECONNREFUSED', undefined, true]);
        expect([node(cluster), timerWaits()]).toEqual([UP, [LONG]]);
    });
});

describe('a healthCheck node whose server drops the connection under a query', () => {
    it('stays up, and one check starts at once and passes', async () => {
        const server = await listen('hangs up');
        const cluster = await connected(server.port);

        const handedOut = await appQuery(cluster);
        const atOnce = node(cluster);
        await until(() => server.checks() === 2, 'the check at once', server.checks);
        await until(() => timerWaits().length === 3, 'the end of that check', timerWaits);

        expect(handedOut).toEqual(['PROTOCOL_CONNECTION_LOST', undefined, true]);
        expect([atOnce, node(cluster), timerWaits()]).toEqual([UP, UP, [LONG, 0, LONG]]);
    });

    it('five queries in a row that lose their connection start one check', async () => {
        const server = await listen('hangs up');
        const cluster = await connected(server.port);

        for (let i = 0; i < 5; i++) await appQuery(cluster);
        await until(() => timerWaits().length === 3, 'the end of the check', timerWaits);

        // one login per query after the first, one for the check, and the one of connect()
        expect([server.checks(), timerWaits()]).toEqual([2, [LONG, 0, LONG]]);
        expect(node(cluster)).toEqual(UP);
    });

    it('goes down with that one check when the server is gone for good', async () => {
        const server = await listen('hangs up');
        const cluster = await connected(server.port);
        // The server drops the connection under the query. It stops listening before the
        // check that starts can ask for a connection: no timer runs in between
        const handedOut = await appQuery(cluster);
        server.hangUp(true);

        const isValid = () => node(cluster).isValid;
        await until(() => !isValid(), 'the node to go down', () => node(cluster));

        expect(handedOut).toEqual(['PROTOCOL_CONNECTION_LOST', undefined, true]);
        // fall is 3, and this was the first failed check
        expect(node(cluster).checkError.code).toBe('ECONNREFUSED');
        expect(timerWaits()).toEqual([LONG, 0, LONG]);
    });

    it('with passive false no check starts', async () => {
        const server = await listen('hangs up');
        const cluster = await connected(server.port, { ...BLOCK, passive: false });

        const handedOut = await appQuery(cluster);

        expect(handedOut).toEqual(['PROTOCOL_CONNECTION_LOST', undefined, true]);
        expect([node(cluster), timerWaits(), server.checks()]).toEqual([UP, [LONG], 1]);
    });
});

describe('a healthCheck node whose server answers a query of the app with an error', () => {
    // what mysql2 hands out for each: the code, the errno of the server and fatal
    it.each<[string, Mode, boolean, any[]]>([
        ['a deadlock, errno 1213', 'deadlocks', false, ['ER_LOCK_DEADLOCK', 1213, undefined]],
        ['a login refused on an open connection, fatal for mysql2',
            'refuses the change of user', false, ['ER_ACCESS_DENIED_ERROR', 1045, true]],
        ['a login refused on a new connection',
            'refuses the login', true, ['ER_ACCESS_DENIED_ERROR', 1045, undefined]]
    ])('%s changes nothing', async (_name, mode, fresh, wanted) => {
        const server = await listen('answers');
        const cluster = await connected(server.port);
        server.become(mode);
        if (fresh) {
            server.hangUp();
            await noIdle(cluster);
        }

        const handedOut = await appQuery(cluster);

        expect(handedOut).toEqual(wanted);
        // up, no check started and none reached the server but the one of connect()
        expect([node(cluster), timerWaits(), server.checks()]).toEqual([UP, [LONG], 1]);
    });
});

// Two nodes, each behind a proxy of its own, with ten connections per pool as the default
// is. fall is 3 and the checks of the timer are ten minutes apart, so a node that goes down
// here went down by passive health
const POOLED = 10;
const behindProxies = async (block: object = BLOCK) => {
    const proxies: IProxy[] = [];
    for (let i = 0; i < 2; i++) proxies.push(await proxyTo((await listen('answers')).port));
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: proxies.map(({ port }, i) => {
            return { host: '127.0.0.1', port, id: i + 1, connectionLimit: POOLED };
        }),
        defaultPoolSettings: {
            user: 'u', password: 'p', database: 'd', flags: [], healthCheck: block
        },
        useClusterHashing: false,
        logger
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // connect() is over with the first node that passed its check. This waits for both
    await cluster.ready;
    // every check that failed, by node: the code it failed with
    const failedChecks: string[][] = [[], []];
    cluster.on('pool_check_failed', ([error, id]: [any, number]) => {
        failedChecks[id - 1].push(error.code);
    });
    // the reason of every line a node logged about going down
    const downs = (): string[] => logger.warn.mock.calls
        .filter(([, meta]) => meta && meta.reason).map(([, meta]) => meta.reason);
    return { cluster, proxies, failedChecks, downs };
};
// open `count` connections in every pool and hand them back, so they sit idle in the pool
const idle = async (cluster: any, count: number) => {
    for (const pool of cluster.pools) {
        const held = await Promise.all(Array.from({ length: count }, () => pool.getConnection()));
        held.forEach((connection: any) => connection.release());
    }
    expect(cluster.getPoolStats().map((stats: any) => stats.idle)).toEqual([count, count]);
};
// the waits the check timer of one node was started with
const waitsOf = (cluster: any, index: number): number[] => {
    const timer = cluster.pools[index].status._timer;
    return started.mock.calls.filter((_call, i) => started.mock.instances[i] === timer)
        .map(([ms]) => ms);
};
const isUp = (cluster: any): boolean[] => cluster.nodes().map((info: any) => info.isValid);
// `count` queries of the app at once, straight to the pool of one node. What each was
// rejected with, by code, or undefined for a query that passed
const burst = (cluster: any, index: number, count: number): Promise<string[]> => {
    return Promise.all(Array.from({ length: count }, () => {
        return cluster.pools[index].query(APP_SQL, { timeout: 0 })
            .then((): any => undefined, (error: any) => error.code);
    }));
};
// the check timer of a node waits for its interval again: no check is out or about to run
const settled = (cluster: any, index: number) => {
    const waits = () => waitsOf(cluster, index);
    return until(() => waits().length > 1 && waits().slice(-1)[0] === LONG,
        'the checks of node ' + index + ' to settle', waits);
};

describe('two healthy nodes whose idle pooled connections the path forgot', () => {
    // six idle connections per pool, forgotten. Three queries at once take three of them
    const stale = async () => {
        const rig = await behindProxies();
        await idle(rig.cluster, 6);
        rig.proxies.forEach(proxy => proxy.forget());
        return rig;
    };

    it('lose the queries that met such a connection, and no node goes down', async () => {
        const { cluster, downs } = await stale();

        const rejected = [await burst(cluster, 0, 3), await burst(cluster, 1, 3)];
        await settled(cluster, 0);
        await settled(cluster, 1);

        const reset = ['ECONNRESET', 'ECONNRESET', 'ECONNRESET'];
        expect(rejected).toEqual([reset, reset]);
        expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
    });

    it('the check opens a new connection for its own forgotten one, and gets its answer',
        async () => {
            const { cluster, proxies, failedChecks } = await stale();

            await burst(cluster, 0, 3);
            await settled(cluster, 0);

            // three resets for the queries and one for the check connection, which the path
            // forgot as well: the check opened a new one and got its answer there
            expect(failedChecks[0]).toEqual([]);
            expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG]);
            expect([proxies[0].resets(), cluster.nodes()[0].checkError]).toEqual([4, undefined]);
        });

    // The check asks on its own connection, so it uses up none of the pool: what the path
    // forgot there waits for a query of the app
    it('each forgotten connection left in the pool fails one more query, then all pass',
        async () => {
            const { cluster, proxies, downs } = await stale();
            await burst(cluster, 0, 3);
            await settled(cluster, 0);

            const later = await burst(cluster, 0, 2 * POOLED);
            await settled(cluster, 0);
            const last = await burst(cluster, 0, 2 * POOLED);

            // the three that were left met one query each, and then none is left
            expect(later.filter(code => code !== undefined)).toEqual(
                ['ECONNRESET', 'ECONNRESET', 'ECONNRESET']);
            expect(last.filter(code => code !== undefined)).toEqual([]);
            // six of the pool and the check connection were reset, and no node went down
            expect([cluster.getPoolStats()[0].idle, proxies[0].resets()]).toEqual([POOLED, 7]);
            expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
        });

    it('through cluster.query: no node goes down, and one query at most is lost per ' +
        'forgotten connection', async () => {
        const { cluster, downs } = await stale();
        const ask = () => cluster.query(APP_SQL, undefined, { timeout: 0 })
            .then(() => 'passed', () => 'rejected');

        // each of the three meets a forgotten connection, at one node or at both
        const first = await Promise.all([ask(), ask(), ask()]);
        const later: string[] = [];
        for (let i = 0; i < 40; i++) later.push(await ask());
        await settled(cluster, 0);
        await settled(cluster, 1);

        // twelve were forgotten, six in each pool, and the first three queries met three
        const lost = (asked: string[]) => asked.filter(how => how === 'rejected').length;
        expect([lost(first), lost(later) <= 9]).toEqual([3, true]);
        expect(later.slice(-20)).toEqual(Array(20).fill('passed'));
        expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
    });

    it('with passive false no check starts, as before', async () => {
        const rig = await behindProxies({ ...BLOCK, passive: false });
        await idle(rig.cluster, 6);
        rig.proxies.forEach(proxy => proxy.forget());

        const rejected = await burst(rig.cluster, 0, 3);

        expect(rejected).toEqual(['ECONNRESET', 'ECONNRESET', 'ECONNRESET']);
        expect([isUp(rig.cluster), waitsOf(rig.cluster, 0)]).toEqual([[true, true], [LONG]]);
    });
});

describe('a node that is dead for real behind its proxy', () => {
    it('resets every connection: down after one check that decides',
        async () => {
            const { cluster, proxies, failedChecks, downs } = await behindProxies();
            await idle(cluster, 6);
            proxies[0].become('resets');

            const rejected = await burst(cluster, 0, 1);
            await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));

            // One check, at once: the connection it held was reset, and so was the one
            // it opened then
            expect(rejected).toEqual(['ECONNRESET']);
            expect(failedChecks[0]).toEqual(['ECONNRESET']);
            expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG]);
            expect(proxies[0].resets()).toBe(3);
            expect([isUp(cluster), downs()]).toEqual([[false, true], ['passive_lost']]);
        });
});

// mysql2 gives a new connection 10 s for its login. 300 ms here, set where the pool is made
const CONNECT_TIMEOUT = 300;

describe('a connect timeout of a call of the app', () => {
    let createPool: jest.SpyInstance;
    beforeEach(() => {
        const real = mysql.createPool.bind(mysql);
        createPool = jest.spyOn(mysql, 'createPool').mockImplementation(((options: any) => {
            return real({ ...options, connectTimeout: CONNECT_TIMEOUT });
        }) as any);
    });
    afterEach(() => createPool.mockRestore());

    it('a path that swallows every packet: down when the check at once times out', async () => {
        const { cluster, proxies, downs } = await behindProxies({ ...BLOCK, timeout: 200 });
        // the call holds the one connection of the pool, so the next one has to open its own
        const held = await cluster.pools[0].getConnection();
        proxies[0].become('swallows');

        const error = await cluster.pools[0].getConnection()
            .then((): any => undefined, (e: any) => e);
        const atOnce = isUp(cluster)[0];
        await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));
        held.destroy();

        expect([error.code, error.fatal, atOnce]).toEqual(['ETIMEDOUT', true, true]);
        // one check, which got no connection within its 200 ms. fall is 3
        expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG]);
        expect([isUp(cluster), downs()]).toEqual([[false, true], ['passive_timeout']]);
    });

    // The path takes new connections and says nothing on them, and the flows that are open
    // go on: the check connection of the node still gets its answer. A check that asked
    // there would pass while no call of the app that needs a connection gets one
    it('a path that swallows new connections only: the check opens one too, and the node ' +
        'is down', async () => {
        const block = { ...BLOCK, timeout: 200 };
        const { cluster, proxies, failedChecks, downs } = await behindProxies(block);
        proxies[0].onlyNew('swallows');
        // a check with nothing to decide asks on the connection the node holds, and passes
        await cluster.pools[0].status.checkStatus();
        const before = [isUp(cluster)[0], failedChecks[0].length];

        const error = await cluster.pools[0].getConnection()
            .then((): any => undefined, (e: any) => e);
        await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));

        expect(before).toEqual([true, 0]);
        expect([error.code, error.fatal]).toEqual(['ETIMEDOUT', true]);
        // one check, which got no connection within its 200 ms. fall is 3
        expect(cluster.nodes()[0].checkError).toEqual({});
        expect([isUp(cluster), downs()]).toEqual([[false, true], ['passive_timeout']]);
    });

    it('a process that stalls past the timer while a login is out: no node goes down',
        async () => {
            const { cluster, downs } = await behindProxies();
            await idle(cluster, 1);
            // Two queries per node: the second has to open a connection. Then this thread
            // sleeps past the connect timer, which is due before the answer is read
            const calls = [0, 0, 1, 1].map(index => burst(cluster, index, 1));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONNECT_TIMEOUT + 100);
            const rejected = (await Promise.all(calls)).map(([code]) => code);
            await settled(cluster, 0);
            await settled(cluster, 1);

            expect(rejected).toEqual([undefined, 'ETIMEDOUT', undefined, 'ETIMEDOUT']);
            // one check at once per node, which passed
            expect([waitsOf(cluster, 0), waitsOf(cluster, 1)]).toEqual(
                [[LONG, 0, LONG], [LONG, 0, LONG]]);
            expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
        });
});

// Two healthy nodes that the app addresses by name. The name resolves to the loopback
// address, or to the limited broadcast address once `noRoute` is set: the kernel refuses a
// TCP connection there with ENETUNREACH before any packet leaves, on Linux. The connections
// a pool holds are not touched by that, as when a route is gone for a moment
describe('nodes addressed by a name that this host has no route for', () => {
    const NAMES = ['db-a.test', 'db-b.test'];
    const NO_ROUTE = '255.255.255.255';
    let noRoute: boolean;
    let lookup: jest.SpyInstance;
    beforeEach(() => {
        noRoute = false;
        const real = dns.lookup.bind(dns);
        lookup = jest.spyOn(dns, 'lookup').mockImplementation(((name: string, ...rest: any[]) => {
            return real(NAMES.includes(name) ? (noRoute ? NO_ROUTE : '127.0.0.1') : name, ...rest);
        }) as any);
    });
    afterEach(() => lookup.mockRestore());

    const byName = async (block: object = BLOCK, pooled: number = 1) => {
        const servers: IServer[] = [];
        for (const _name of NAMES) servers.push(await listen('answers'));
        const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: NAMES.map((host, i) => {
                return { host, port: servers[i].port, id: i + 1, connectionLimit: POOLED };
            }),
            defaultPoolSettings: {
                user: 'u', password: 'p', database: 'd', flags: [], healthCheck: block
            },
            useClusterHashing: false,
            logger
        } as any);
        clusters.push(cluster);
        await cluster.connect();
        await cluster.ready;
        // one idle connection in each pool, as a pool has that a query went through
        if (pooled) await idle(cluster, pooled);
        // every check that failed, by node: the code it failed with
        const failedChecks: string[][] = [[], []];
        cluster.on('pool_check_failed', ([error, id]: [any, number]) => {
            failedChecks[id - 1].push(error.code);
        });
        const downs = (): string[] => logger.warn.mock.calls
            .filter(([, meta]) => meta && meta.reason).map(([, meta]) => meta.reason);
        return { cluster, downs, failedChecks, servers };
    };
    // The next `count` waits of ten minutes that a check timer is started with are over at
    // once, so a test gets that many checks of the timer without a clock. The spy records
    // the wait as it was asked for. Every wait after them is ten minutes again
    const timerDue = (count: number) => {
        let left = count;
        started.mockImplementation(function (this: Timer, ms: number) {
            return timerStart.call(this, ms === LONG && left-- > 0 ? 0 : ms);
        });
    };
    // A call of the app that has to open a connection while there is no route: the one
    // connection of the pool is held meanwhile. What the call was rejected with
    const openWithNoRoute = async (cluster: any, index: number, giveBack: boolean) => {
        const held = await cluster.pools[index].getConnection();
        noRoute = true;
        const error = await cluster.pools[index].getConnection()
            .then((): any => undefined, (e: any) => e);
        // Either way the check that starts opens a connection of its own: after a call
        // that found no route it asks neither the pool nor the connection the node held
        if (giveBack) held.release();
        else closers.push(() => held.destroy());
        return [error.code, error.errno < 0, error.fatal, isUp(cluster)[index]];
    };

    it('a call that finds no route leaves both nodes up: the check at once finds none ' +
        'either', async () => {
        const { cluster, downs } = await byName();

        const seen = [await openWithNoRoute(cluster, 0, true),
            await openWithNoRoute(cluster, 1, true)];
        await settled(cluster, 0);
        await settled(cluster, 1);

        // the code, an errno of the socket, fatal, and the node right after the call
        const call = ['ENETUNREACH', true, true, true];
        expect(seen).toEqual([call, call]);
        expect([waitsOf(cluster, 0), waitsOf(cluster, 1)]).toEqual(
            [[LONG, 0, LONG], [LONG, 0, LONG]]);
        expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
    });

    // The outage this rule is for. Each pool has no idle connection, so the check that
    // starts has to open one, as the call did: no route for it either, at both nodes
    it('a route that is gone for a moment: no check finds one, and both nodes stay up',
        async () => {
            const { cluster, downs, failedChecks } = await byName();

            const seen = [await openWithNoRoute(cluster, 0, false),
                await openWithNoRoute(cluster, 1, false)];
            await settled(cluster, 0);
            await settled(cluster, 1);

            const call = ['ENETUNREACH', true, true, true];
            expect(seen).toEqual([call, call]);
            // one check per node, the first of fall 3, then the wait of the timer
            expect(failedChecks).toEqual([['ENETUNREACH'], ['ENETUNREACH']]);
            expect([waitsOf(cluster, 0), waitsOf(cluster, 1)]).toEqual(
                [[LONG, 0, LONG], [LONG, 0, LONG]]);
            expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
        });

    it('once the route is back the queries pass, at both nodes', async () => {
        const { cluster } = await byName();
        await openWithNoRoute(cluster, 0, false);
        await openWithNoRoute(cluster, 1, false);
        await settled(cluster, 0);
        await settled(cluster, 1);

        noRoute = false;
        const later = [await burst(cluster, 0, 3), await burst(cluster, 1, 3)];

        const passed: string[] = [undefined, undefined, undefined];
        expect([later, isUp(cluster)]).toEqual([[passed, passed], [true, true]]);
    });

    it('a route that stays gone: down by fall, with the third check that finds none',
        async () => {
            const { cluster, downs, failedChecks } = await byName();
            // the two checks of the timer after the one passive health starts
            timerDue(2);

            const seen = await openWithNoRoute(cluster, 0, false);
            await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));

            expect(seen).toEqual(['ENETUNREACH', true, true, true]);
            expect(failedChecks[0]).toEqual(['ENETUNREACH', 'ENETUNREACH', 'ENETUNREACH']);
            expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG, LONG, LONG]);
            expect([isUp(cluster), downs()]).toEqual([[false, true], ['fall']]);
        });

    // A node that is gone when its route is back: no route for the call, and no answer on
    // the connection the check opens after it. It runs into its timeout of 200 ms
    it('no route for the call and no answer for its check: down, and says why', async () => {
        const { cluster, downs, servers } = await byName({ ...BLOCK, timeout: 200 });

        const seen = await openWithNoRoute(cluster, 0, true);
        noRoute = false;
        servers[0].become('says nothing');
        await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));

        expect(seen).toEqual(['ENETUNREACH', true, true, true]);
        // one check, which the package ended. fall is 3
        expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG]);
        expect(cluster.nodes()[0].checkError).toEqual({});
        expect([isUp(cluster), downs()]).toEqual([[false, true], ['passive_unreachable']]);
    });

    // The outage of a route that is gone for new connections only, with pools that hold
    // no connection: every call has to open one and finds no route. The connection the
    // node held for its checks goes on answering, and a check that asked there would keep
    // the node up for as long as the route is gone. fall is 2, as the default
    const emptyPools = () => byName({ ...BLOCK, fall: 2 }, 0);
    const openNone = async (cluster: any, index: number): Promise<string> => {
        noRoute = true;
        const error = await cluster.pools[index].getConnection()
            .then((): any => undefined, (e: any) => e);
        return error.code;
    };

    it('empty pools and a route that stays gone for new connections: down by fall',
        async () => {
            const { cluster, downs, failedChecks, servers } = await emptyPools();
            // the check of the timer after the one passive health starts
            timerDue(1);

            const code = await openNone(cluster, 0);
            await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));
            await until(() => servers[0].open() === 0, 'the held one to close', servers[0].open);

            // both checks had to open a connection, and the one the node held is logged out of
            expect(code).toBe('ENETUNREACH');
            expect(failedChecks[0]).toEqual(['ENETUNREACH', 'ENETUNREACH']);
            expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG, LONG]);
            expect([isUp(cluster), downs()]).toEqual([[false, true], ['fall']]);
        });

    it('empty pools and a route that is back for the next check: the node stays up, with ' +
        'one connection', async () => {
        const { cluster, downs, failedChecks, servers } = await emptyPools();

        const code = await openNone(cluster, 0);
        await settled(cluster, 0);
        noRoute = false;
        // the check of the timer, by hand
        await cluster.pools[0].status.checkStatus();
        await until(() => servers[0].open() === 1, 'one open connection', servers[0].open);

        // the first of fall 2, then a pass on the connection the second check opened
        expect([code, failedChecks[0]]).toEqual(['ENETUNREACH', ['ENETUNREACH']]);
        expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
        expect([servers[0].logins(), cluster.nodes()[0].checkError]).toEqual([2, undefined]);
    });

    it('a route that is back when the check starts: it passes on a new connection, and ' +
        'the node holds that one alone', async () => {
        const { cluster, downs, failedChecks, servers } = await emptyPools();

        const code = await openNone(cluster, 0);
        noRoute = false;
        await settled(cluster, 0);
        await until(() => servers[0].open() === 1, 'one open connection', servers[0].open);

        // the login of connect() and the one of this check, whose connection is kept
        expect([code, failedChecks[0], servers[0].logins()]).toEqual(['ENETUNREACH', [], 2]);
        expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG]);
        expect([isUp(cluster), downs()]).toEqual([[true, true], []]);
    });

    it('with passive false no check starts', async () => {
        const { cluster } = await byName({ ...BLOCK, passive: false });

        const seen = await openWithNoRoute(cluster, 0, false);

        expect(seen).toEqual(['ENETUNREACH', true, true, true]);
        expect([isUp(cluster), waitsOf(cluster, 0)]).toEqual([[true, true], [LONG]]);
    });
});

// The check of a node with a healthCheck block runs on a connection of its own, next to the
// pool of the app. One node, no proxy unless a test says so. The pool takes `limit`
// connections, and the logger is kept: a node that went down logged a warn with a reason
describe('the check connection of a healthCheck node', () => {
    // The code of every check that failed, undefined for a failure the package made. The
    // events of every cluster go through one emitter, so the first cluster adds the listener
    let failedChecks: (string | undefined)[];
    let listening = false;
    beforeEach(() => {
        failedChecks = [];
    });
    const apart = async (port: number, block: object, limit: number = 1) => {
        const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: [{ host: '127.0.0.1', port, id: 1, connectionLimit: limit }],
            defaultPoolSettings: {
                user: 'u', password: 'p', database: 'd', flags: [], healthCheck: block
            },
            useClusterHashing: false,
            logger
        } as any);
        clusters.push(cluster);
        if (!listening) {
            cluster.on('pool_check_failed', ([error]: [any]) => failedChecks.push(error.code));
        }
        listening = true;
        await cluster.connect();
        const downs = (): string[] => logger.warn.mock.calls
            .filter(([, meta]) => meta && meta.reason).map(([, meta]) => meta.reason);
        return { cluster, downs };
    };
    // the connections of the pool of the app, by what they do
    const pooled = (cluster: any) => {
        const { used, idle, pending } = cluster.getPoolStats()[0];
        return { used, idle, pending };
    };
    // run one check of the node by hand, as its timer would
    const check = (cluster: any): Promise<void> => cluster.pools[0].status.checkStatus();
    // this thread sleeps, and with it the event loop: no busy loop
    const stall = (ms: number) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };

    // The outage of a pool at its limit. Two connections, both held by a query the server
    // keeps, three more queries in the queue of mysql2. The checks of the timer come every
    // 100 ms and give up after 200 ms, and the queries are held until three checks got
    // their answer, so for longer than a check waits
    it('a saturated pool: the check still passes and the node stays up', async () => {
        const server = await listen('answers');
        const { cluster, downs } = await apart(server.port, { interval: 100, timeout: 200 }, 2);
        server.become('holds the app');
        const calls = Array.from({ length: 5 }, () => appQuery(cluster));
        const full = { used: 2, idle: 0, pending: 3 };
        await until(() => pooled(cluster).pending === 3, 'a full pool', () => pooled(cluster));
        const before = server.checks();

        // every state of the node between here and the third answered check
        const states: boolean[] = [];
        await until(() => {
            states.push(node(cluster).isValid);
            return server.checks() >= before + 3 || !node(cluster).isValid;
        }, 'three checks of a full pool', () => [server.checks() - before, failedChecks]);

        expect([pooled(cluster), states.includes(false)]).toEqual([full, false]);
        expect([node(cluster), failedChecks, downs()]).toEqual([UP, [], []]);
        server.answerHeld();
        expect(await Promise.all(calls)).toEqual(Array(5).fill(undefined));
    });

    it('is the one connection a connected node holds, and the pool holds none', async () => {
        const server = await listen('answers');
        const { cluster } = await apart(server.port, BLOCK);

        // the check of connect() passed on it. The pool opens its first with a query
        expect([server.open(), server.logins(), server.checks()]).toEqual([1, 1, 1]);
        expect(pooled(cluster)).toEqual({ used: 0, idle: 0, pending: 0 });
    });

    it('connect, disconnect, connect leaves exactly one check connection open, and ' +
        'disconnect leaves none', async () => {
        const server = await listen('answers');
        const { cluster } = await apart(server.port, BLOCK);
        // the connections open at the server, and those of them the pool of the app holds
        const open = () => [server.open(), pooled(cluster).idle];
        const connected: number[][] = [open()];

        cluster.disconnect();
        await until(() => server.open() === 0, 'no connection after a disconnect', server.open);
        await cluster.connect();
        connected.push(open());
        cluster.disconnect();
        await until(() => server.open() === 0, 'no connection after a disconnect', server.open);

        // one login per connect()
        expect([connected, server.logins()]).toEqual([[[1, 0], [1, 0]], 2]);
    });

    it('two connect() calls of a node at once leave one check connection open', async () => {
        const server = await listen('answers');
        const { cluster } = await apart(server.port, BLOCK);
        const pool = cluster.pools[0];

        await Promise.all([pool.connect(), pool.connect()]);
        await until(() => server.open() === 1, 'one open connection', server.open);

        // The one of the cluster, and one per call: the first two were closed again. The
        // check of the first call asked on the connection of the second
        expect([server.logins(), server.open(), failedChecks]).toEqual([3, 1, []]);
    });

    it('a check connection the server closed while it was idle ends no process: the next ' +
        'check logs in again and passes', async () => {
        const server = await listen('answers');
        const { cluster } = await apart(server.port, BLOCK);

        server.hangUp();
        await until(() => !cluster.pools[0].holdsCheckConnection,
            'the node to drop its check connection', server.open);
        await check(cluster);

        expect([node(cluster), failedChecks, server.logins()]).toEqual([UP, [], 2]);
    });

    // open item 4 of the passive health task: no call of the app failed before this check
    it('a check of the timer that meets a connection the path forgot opens a new one and ' +
        'passes', async () => {
        const server = await listen('answers');
        const proxy = await proxyTo(server.port);
        const { cluster } = await apart(proxy.port, BLOCK);
        proxy.forget();

        await check(cluster);

        // one reset, of the check connection, and the login of the one after it
        expect([node(cluster), failedChecks]).toEqual([UP, []]);
        expect([proxy.resets(), server.logins(), server.checks()]).toEqual([1, 2, 2]);
    });

    it('a path that resets every connection: only a check that held one asks twice', async () => {
        const server = await listen('answers');
        const proxy = await proxyTo(server.port);
        const { cluster } = await apart(proxy.port, BLOCK);
        proxy.become('resets');

        await check(cluster);
        const first = proxy.resets();
        await check(cluster);

        // The first check lost the connection it held and the one it opened then. The
        // second held none: the reset of the one it opened is its result. fall is 3
        const lost = ['ECONNRESET', 'ECONNRESET'];
        expect([first, proxy.resets(), failedChecks]).toEqual([2, 3, lost]);
        const reset = { code: 'ECONNRESET', errno: -104 };
        expect(node(cluster)).toEqual({ isValid: true, checkError: reset });
    });

    it('a check that got no answer in time drops its connection: the next one logs in ' +
        'again', async () => {
        const server = await listen('answers');
        const { cluster } = await apart(server.port, { ...BLOCK, timeout: 200 });
        server.become('says nothing');

        await check(cluster);
        const afterTimeout = node(cluster);
        await until(() => server.open() === 0, 'the check connection to close', server.open);
        server.become('answers');
        await check(cluster);

        // the timeout is a failure the package made: no code. fall is 3
        expect(afterTimeout).toEqual({ isValid: true, checkError: {} });
        expect([node(cluster), failedChecks, server.logins()]).toEqual([UP, [undefined], 2]);
    });

    // The server wrote its answer, and then this thread sleeps for longer than the check
    // waits. The timer of the check is due before the socket is read
    it('a process that stalls past the check timer with the answer in the socket: the ' +
        'check passes', async () => {
        const server = await listen('answers');
        const { cluster } = await apart(server.port, { ...BLOCK, timeout: 200 });
        server.afterNextCheck(() => stall(300));

        await check(cluster);

        expect([node(cluster), failedChecks, server.checks()]).toEqual([UP, [], 2]);
    });
});
