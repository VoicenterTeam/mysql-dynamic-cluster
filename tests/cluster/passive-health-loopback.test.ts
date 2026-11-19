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
    | 'says nothing';

interface IServer {
    port: number, become: (next: Mode) => void,
    // drop the open connections, and with `forGood` take no new one either
    hangUp: (forGood?: boolean) => void,
    logins: () => number, checks: () => number
}
const listen = async (mode: Mode): Promise<IServer> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    const seen = { logins: 0, checks: 0 };
    let listening = true;
    const hangUp = (forGood: boolean = false) => {
        if (forGood && listening) server.close();
        listening = listening && !forGood;
        connections.splice(0).forEach(connection => connection.stream.destroy());
    };
    closers.push(() => hangUp(true));
    const refuse = { message: "Access denied for user 'u'@'127.0.0.1'", code: 1045 };
    server.on('connection', (connection: any) => {
        connections.push(connection);
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
            connection.sequenceId = 1;
            if (!isCheck && mode === 'deadlocks') {
                return connection.writeError({ message: 'Deadlock found', code: 1213 });
            }
            connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        become: (next: Mode) => { mode = next; },
        hangUp,
        logins: () => seen.logins,
        checks: () => seen.checks
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

    it('the check runs again for each one that is left, then gets its answer', async () => {
        const { cluster, proxies, failedChecks } = await stale();

        await burst(cluster, 0, 3);
        await settled(cluster, 0);

        // three for the queries. The check at once met the other three, one per run, and
        // its fourth run opened a new connection
        expect(failedChecks[0]).toEqual(['ECONNRESET', 'ECONNRESET', 'ECONNRESET']);
        expect(waitsOf(cluster, 0)).toEqual([LONG, 0, 0, 0, 0, LONG]);
        expect([proxies[0].resets(), cluster.nodes()[0].checkError]).toEqual([6, undefined]);
    });

    it('every broken connection left the pool: the queries after it all pass', async () => {
        const { cluster, proxies } = await stale();
        await burst(cluster, 0, 3);
        await settled(cluster, 0);

        const later = await burst(cluster, 0, 2 * POOLED);

        expect(later.filter(code => code !== undefined)).toEqual([]);
        // the pool holds what those queries opened, and no flow was reset since
        expect([cluster.getPoolStats()[0].idle, proxies[0].resets()]).toEqual([POOLED, 6]);
    });

    it('through cluster.query: no node goes down, and the queries after it pass', async () => {
        const { cluster, downs } = await stale();
        const ask = () => cluster.query(APP_SQL, undefined, { timeout: 0 })
            .then(() => 'passed', () => 'rejected');

        // each of the three meets a forgotten connection, at one node or at both
        await Promise.all([ask(), ask(), ask()]);
        await settled(cluster, 0);
        await settled(cluster, 1);
        const later: string[] = [];
        for (let i = 0; i < 20; i++) later.push(await ask());

        expect(later).toEqual(Array(20).fill('passed'));
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
    it('resets every connection: down after one run per connection the pool may hold',
        async () => {
            const { cluster, proxies, failedChecks, downs } = await behindProxies();
            await idle(cluster, 6);
            proxies[0].become('resets');

            const rejected = await burst(cluster, 0, 1);
            await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));

            // The check and ten more runs, no wait between them: five met the idle
            // connections that were left, six a new connection that was reset
            expect(rejected).toEqual(['ECONNRESET']);
            expect(failedChecks[0]).toEqual(Array(POOLED + 1).fill('ECONNRESET'));
            expect(waitsOf(cluster, 0)).toEqual([LONG, ...Array(POOLED + 1).fill(0), LONG]);
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

    it('a process that stalls past the timer while a login is out: no node goes down',
        async () => {
            const { cluster, downs } = await behindProxies();
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

    const byName = async (block: object = BLOCK) => {
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
        // Before the timer of the check that starts: the check draws this connection, which
        // works, or it has to open one of its own
        if (giveBack) held.release();
        else closers.push(() => held.destroy());
        return [error.code, error.errno < 0, error.fatal, isUp(cluster)[index]];
    };

    it('a call that finds no route leaves both nodes up: the check at once passes', async () => {
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

    // A node that is gone together with its route: no route for a new connection, and no
    // answer on the pooled one, which the check draws. It runs into its timeout of 200 ms
    it('no route for the call and no answer for its check: down, and says why', async () => {
        const { cluster, downs, servers } = await byName({ ...BLOCK, timeout: 200 });

        const seen = await openWithNoRoute(cluster, 0, true);
        servers[0].become('says nothing');
        await until(() => !isUp(cluster)[0], 'node 0 to go down', () => waitsOf(cluster, 0));

        expect(seen).toEqual(['ENETUNREACH', true, true, true]);
        // one check, which the package ended. fall is 3
        expect(waitsOf(cluster, 0)).toEqual([LONG, 0, LONG]);
        expect(cluster.nodes()[0].checkError).toEqual({});
        expect([isUp(cluster), downs()]).toEqual([[false, true], ['passive_unreachable']]);
    });

    it('with passive false no check starts', async () => {
        const { cluster } = await byName({ ...BLOCK, passive: false });

        const seen = await openWithNoRoute(cluster, 0, false);

        expect(seen).toEqual(['ENETUNREACH', true, true, true]);
        expect([isUp(cluster), waitsOf(cluster, 0)]).toEqual([[true, true], [LONG]]);
    });
});
