import mysql from 'mysql2';
import net, { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import { IdleConnectionReaper } from '../../src/pool/IdleConnectionReaper';
import Events from '../../src/utils/Events';
import Metrics from '../../src/metrics/Metrics';

// The ping of the idle pooled connections of a node with a healthCheck block, with the
// cluster of createPoolCluster and the real mysql2 against mysql2's own server class on the
// loopback interface. A TCP proxy stands between the two and plays a path with an idle
// timeout: a balancer, a NAT or a firewall that forgets a flow nobody used for a while and
// tells neither side. The next bytes of the client on such a flow get a reset, or no answer.
// One node, so the query after a pause has no second node to go to.
// flags are set, so connect() logs in once. They are the flags the package picks for the
// version this server announces, so the connections are those of the default settings
const COM_CHANGE_USER = 0x11;
const COM_RESET_CONNECTION = 0x1f;
const LONG = 600000;
const APP_SQL = 'SELECT 1';
// the idle timeout of the path in the rows that have one, and the pause of the app there
const PATH_IDLE = 1500;
const PAUSE = 3000;
// the default probeIdle: a pooled connection idle longer than this answers a ping before a
// statement goes to it
const PROBE_IDLE = 1000;

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

interface IServer {
    port: number,
    logins: () => number,
    // the pings that arrived, each by the number of its connection, in the order of the logins
    pings: () => number[],
    // what arrived on the connections, in order: 'ping', 'user', 'reset' or 'query'
    order: () => string[],
    // how many connections are open at the server right now
    open: () => number,
    // keep the answer to every ping from now on, until answerPings()
    holdPings: () => void,
    answerPings: () => void,
    // how many logouts arrived
    quits: () => number,
    // answer the next ping, then close the connection it came on, as a server does that
    // ends a connection it finds idle for too long
    closeAfterNextPing: () => void
}
const listen = async (): Promise<IServer> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    const seen = { logins: 0, open: 0, quits: 0, pings: [] as number[], order: [] as string[] };
    const heldPings: any[] = [];
    let holding = false;
    let closing = false;
    const ok = (connection: any) => {
        connection.sequenceId = 1;
        connection.writeOk();
    };
    closers.push(() => {
        server.close();
        connections.forEach(connection => connection.stream.destroy());
    });
    server.on('connection', (connection: any) => {
        const id = connections.push(connection);
        seen.open++;
        connection.stream.on('close', () => seen.open--);
        connection.on('error', () => undefined);
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: id,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => {
                seen.logins++;
                done(null);
            }
        });
        // The check connection changes the user before its status query. The pool does not:
        // it resets a connection the app had when the app releases it
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || (code !== COM_CHANGE_USER && code !== COM_RESET_CONNECTION)) return;
            seen.order.push(code === COM_CHANGE_USER ? 'user' : 'reset');
            ok(connection);
        });
        connection.on('ping', () => {
            seen.pings.push(id);
            seen.order.push('ping');
            if (holding) return heldPings.push(connection);
            ok(connection);
            // after the answer is on its way: the client reads it, then the end
            if (closing) connection.stream.end();
            closing = false;
        });
        connection.on('query', () => {
            seen.order.push('query');
            connection.sequenceId = 1;
            connection.writeTextResult(STATUS, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => {
            seen.quits++;
            connection.close();
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server._server.address() as AddressInfo).port,
        logins: () => seen.logins,
        quits: () => seen.quits,
        pings: () => [...seen.pings],
        order: () => [...seen.order],
        open: () => seen.open,
        holdPings: () => { holding = true; },
        answerPings: () => {
            holding = false;
            heldPings.splice(0).forEach(ok);
        },
        closeAfterNextPing: () => { closing = true; }
    };
};

// What the path does with the bytes of a flow it forgot: a reset, or nothing at all
type Forgotten = 'resets' | 'swallows';
interface IProxy {
    port: number,
    // forget every open flow now, without telling either side
    forget: (how: Forgotten) => void,
    // how many connections this proxy reset, and how many flows it forgot
    resets: () => number,
    forgotten: () => number
}
// A path to `target`. With `idleMs` it forgets a flow that carried no byte for that long,
// in either direction, and resets the next bytes of the client on it. It finds out when
// those bytes arrive, as a balancer does: no timer runs here
const proxyTo = async (target: number, idleMs: number = Infinity): Promise<IProxy> => {
    const counts = { resets: 0, forgotten: 0 };
    interface IFlow { client: net.Socket, upstream: net.Socket, last: number, gone?: Forgotten }
    const flows = new Set<IFlow>();
    const forgetFlow = (flow: IFlow, how: Forgotten) => {
        if (flow.gone) return;
        flow.gone = how;
        counts.forgotten++;
        flow.upstream.destroy();
    };
    const server = net.createServer(client => {
        const upstream = net.connect(target, '127.0.0.1');
        const flow: IFlow = { client, upstream, last: Date.now() };
        flows.add(flow);
        client.on('error', () => undefined);
        flow.upstream.on('error', () => undefined);
        client.on('close', () => {
            flows.delete(flow);
            flow.upstream.destroy();
        });
        client.on('data', data => {
            if (Date.now() - flow.last > idleMs) forgetFlow(flow, 'resets');
            if (flow.gone === 'swallows') return;
            if (flow.gone) {
                counts.resets++;
                // a reset, not a close: mysql2 drops a pooled connection that was closed
                return (client as any).resetAndDestroy();
            }
            flow.last = Date.now();
            flow.upstream.write(data);
        });
        flow.upstream.on('data', data => {
            flow.last = Date.now();
            client.write(data);
        });
        flow.upstream.on('close', () => {
            if (!flow.gone) client.destroy();
        });
    });
    closers.push(() => {
        server.close();
        flows.forEach(flow => flow.client.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        forget: (how: Forgotten) => flows.forEach(flow => forgetFlow(flow, how)),
        resets: () => counts.resets,
        forgotten: () => counts.forgotten
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

// every tick of a reaper, of any pool
let ticks: jest.SpyInstance;
// every record of the operation metric
let operations: jest.SpyInstance;
// The events of the cluster about its pooled connections, by name. The events of every
// cluster go through one emitter, so the listeners are added once
const events: string[] = [];
['connection', 'acquire', 'release', 'pool_check_failed'].forEach(name => {
    Events.on(name as any, () => events.push(name));
});
beforeEach(() => {
    ticks = jest.spyOn(IdleConnectionReaper.prototype as any, '_tick');
    operations = jest.spyOn(Metrics, 'recordOperation');
    events.length = 0;
});
afterEach(() => {
    ticks.mockRestore();
    operations.mockRestore();
});

// A node with the block whose checks of the timer are ten minutes apart, so the check
// connection carries nothing after connect(). A ping has 400 ms, and the reaper looks
// every 100 ms
const BLOCK = { healthCheck: { interval: LONG, timeout: 400 }, idleCheckInterval: 100 };
// a node without the block. Its legacy check is ten minutes apart as well
const LEGACY = { timerCheckRange: { start: LONG, end: LONG }, idleCheckInterval: 100 };

// one node behind a path, connected
const behind = async (pool: object, idleMs?: number) => {
    const server = await listen();
    const proxy = await proxyTo(server.port, idleMs);
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port: proxy.port, id: 1, name: 'node-a' }],
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [], ...pool },
        useClusterHashing: false,
        logger,
        logs: { level: 'debug' }
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // the debug lines about a ping that took a connection out: their fields, not their wording
    const removals = () => logger.debug.mock.calls.map(([, meta]) => meta)
        .filter(meta => meta?.idlePing);
    // the lines about a node that went down
    const downs = () => logger.warn.mock.calls.filter(([, meta]) => meta?.reason);
    return { cluster, server, proxy, removals, downs };
};
// One query of the app straight to the pool of the node, which rejects with the error of
// mysql2 as it is: 'answered', or the code it was rejected with.
// With no timeout: mysql2 3.24.6 keeps the timer of a query whose connection was lost, and
// a worker of jest would wait for the 120 s of the default queryTimeout before it exits
const ask = (cluster: any): Promise<string> => {
    return cluster.pools[0].query(APP_SQL, { timeout: 0 })
        .then(() => 'answered', (error: any) => String(error.code));
};
// the same through cluster.query(), whose error has a message and no code
const askCluster = (cluster: any): Promise<string> => {
    return cluster.query(APP_SQL, undefined, { timeout: 0 })
        .then(() => 'answered', () => 'rejected');
};
const pooled = (cluster: any) => {
    const { used, idle, pending } = cluster.getPoolStats()[0];
    return { used, idle, pending };
};
const ONE_IDLE = { used: 0, idle: 1, pending: 0 };
const NONE = { used: 0, idle: 0, pending: 0 };
// a node with the block that answered one query: its pool holds one idle connection, the
// second the server took. The first is the check connection
const quiet = async (pool: object = BLOCK, idleMs?: number) => {
    const rig = await behind(pool, idleMs);
    expect([await ask(rig.cluster), pooled(rig.cluster)]).toEqual(['answered', ONE_IDLE]);
    return rig;
};
// wait for `count` more ticks of the reaper
const moreTicks = (count: number) => {
    const from = ticks.mock.calls.length;
    const passed = () => ticks.mock.calls.length - from;
    return until(() => passed() >= count, count + ' ticks of the reaper', passed);
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// keep the answers to the pings from now on, and wait for one that is out
const heldPing = async (server: IServer) => {
    const from = server.pings().length;
    server.holdPings();
    await until(() => server.pings().length > from, 'a ping that is out', server.pings);
};

describe('a quiet app behind a path that forgets a flow after 1500 ms', () => {
    // The pause is a real one: the idle timeout of a path is a clock, and so is the rule
    // the app has to meet. Every other row of this suite polls
    it('idleCheckInterval 500 and else the defaults: the first query after 3 s is answered ' +
        'on the connection from before', async () => {
        const settings = { healthCheck: {}, idleCheckInterval: 500 };
        const { cluster, server, proxy } = await quiet(settings, PATH_IDLE);
        const logins = server.logins();

        await pause(PAUSE);
        const first = await ask(cluster);

        // no login since: the pool still holds the connection, and the path knows it
        expect([first, server.logins() - logins, proxy.resets()]).toEqual(['answered', 0, 0]);
        expect(server.pings().length).toBeGreaterThanOrEqual(3);
    });

    it('the same through cluster.query(), and the node stays up with no failed check',
        async () => {
            const settings = { healthCheck: {}, idleCheckInterval: 500 };
            const { cluster, downs } = await quiet(settings, PATH_IDLE);

            await pause(PAUSE);
            const first = await askCluster(cluster);

            expect([first, cluster.nodes()[0].isValid, downs()]).toEqual(['answered', true, []]);
            expect(events.includes('pool_check_failed')).toBe(false);
        });
});

describe('an idle pooled connection the path forgot before its ping', () => {
    it('a path that resets: the ping fails, the connection is closed, and the next query ' +
        'is answered on a new one', async () => {
        const { cluster, server, proxy } = await quiet();
        const logins = server.logins();

        proxy.forget('resets');
        await until(() => pooled(cluster).idle === 0, 'the forgotten connection to be closed',
            () => pooled(cluster));
        const next = await ask(cluster);

        // one reset, for the ping. The query logged in again and met none
        expect([next, server.logins() - logins, proxy.resets()]).toEqual(['answered', 1, 1]);
        expect(pooled(cluster)).toEqual(ONE_IDLE);
    });

    it('a path that swallows: the ping gets no answer in time, the connection is closed ' +
        'with its socket, and the next query is answered', async () => {
        const { cluster, server, proxy } = await quiet();
        const [connection] = cluster.pools[0]._pool._allConnections.toArray();
        const logins = server.logins();

        proxy.forget('swallows');
        await until(() => pooled(cluster).idle === 0, 'the silent connection to be closed',
            () => pooled(cluster));
        const closed = connection.stream.destroyed;
        const next = await ask(cluster);

        expect([closed, next, server.logins() - logins, proxy.resets()])
            .toEqual([true, 'answered', 1, 0]);
    });

    it('is one debug line with the pool and the code', async () => {
        const { cluster, proxy, removals } = await quiet();

        proxy.forget('resets');
        await until(() => pooled(cluster).idle === 0, 'the forgotten connection to be closed',
            () => pooled(cluster));
        await moreTicks(2);

        expect(removals()).toEqual([{ pool: 'node-a', idlePing: 'failed', code: 'ECONNRESET' }]);
    });

    it('takes no node down, fails no check and opens no connection in its place', async () => {
        const { cluster, server, proxy, downs } = await quiet();
        const logins = server.logins();

        proxy.forget('resets');
        await until(() => pooled(cluster).idle === 0, 'the forgotten connection to be closed',
            () => pooled(cluster));
        await moreTicks(2);

        expect([cluster.nodes()[0].isValid, cluster.nodes()[0].checkError, downs()])
            .toEqual([true, undefined, []]);
        expect([events.includes('pool_check_failed'), server.logins() - logins, pooled(cluster)])
            .toEqual([false, 0, NONE]);
    });
});

describe('a ping is no query of the app', () => {
    it('while it is out and after it was answered: the counts, no event, no metric record',
        async () => {
            const { cluster, server } = await quiet();
            await heldPing(server);
            events.length = 0;
            operations.mockClear();
            const during = pooled(cluster);
            const from = server.pings().length;

            server.answerPings();
            await until(() => server.pings().length >= from + 3, 'three more pings', server.pings);

            expect([during, pooled(cluster)]).toEqual([ONE_IDLE, ONE_IDLE]);
            expect([events, operations.mock.calls.length]).toEqual([[], 0]);
        });

    it('only the idle connection gets one: the one the app holds and the check connection ' +
        'get none', async () => {
        const { cluster, server } = await quiet();
        // the second pooled connection, the third the server took, stays with the app
        const [held, idle] = await Promise.all([cluster.getConnection(), cluster.getConnection()]);
        idle.connection.release();
        const from = server.pings().length;

        await moreTicks(3);
        const pinged = [...new Set(server.pings().slice(from))];
        const counts = pooled(cluster);
        held.connection.release();

        expect([pinged, counts]).toEqual([[3], { used: 1, idle: 1, pending: 0 }]);
    });
});

describe('the app draws a connection whose ping is out', () => {
    it('its query waits for the answer to the ping and is answered then, on that connection',
        async () => {
            const { cluster, server, proxy } = await quiet();
            const logins = server.logins();
            await heldPing(server);
            const sent = server.order().length;
            const drawn = { used: 1, idle: 0, pending: 0 };

            const asked = ask(cluster);
            await until(() => pooled(cluster).used === 1, 'the app to draw it',
                () => pooled(cluster));
            // six ticks are 600 ms: the limit of the ping passes while the app holds it
            await moreTicks(6);
            const waiting = [server.order().slice(sent), pooled(cluster)];
            server.answerPings();

            // nothing of the app reached the server before the ping was answered
            expect([waiting, await asked]).toEqual([[[], drawn], 'answered']);
            // the query alone: the pool sends no change of user ahead of it
            expect([server.order().slice(sent), server.logins() - logins, proxy.resets()])
                .toEqual([['query'], 0, 0]);
        });
});

describe('a node without a healthCheck block behind the same path', () => {
    it('sends no ping to its idle pooled connection', async () => {
        // the legacy check went through the pool and left its connection idle there
        const { cluster, server } = await behind(LEGACY);
        expect(pooled(cluster)).toEqual(ONE_IDLE);

        await moreTicks(5);

        expect([server.pings(), pooled(cluster)]).toEqual([[], ONE_IDLE]);
    });

    // No ping of the reaper finds it. The probe of the query that draws it does, once the
    // connection was idle longer than probeIdle (#93): the query is answered on a new one
    it('keeps a connection the path forgot, and the query that draws it after probeIdle is ' +
        'answered on a new one', async () => {
        const { cluster, server, proxy, removals } = await behind(LEGACY);
        const logins = server.logins();

        proxy.forget('resets');
        await pause(PROBE_IDLE + 100);
        const kept = pooled(cluster);

        expect([kept, await ask(cluster), removals()]).toEqual([ONE_IDLE, 'answered', []]);
        expect([proxy.resets(), server.logins() - logins]).toEqual([1, 1]);
    });
});

describe('one cluster with the block on one host only', () => {
    // two nodes, no path in between. The first has the block, the second the legacy check
    const mixed = async () => {
        const servers = [await listen(), await listen()];
        const cluster: any = createPoolCluster({
            clusterName: 'test',
            hosts: servers.map(({ port }, i) => {
                return { host: '127.0.0.1', port, id: i + 1, ...(i === 0 ? BLOCK : {}) };
            }),
            defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [], ...LEGACY },
            useClusterHashing: false,
            logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        } as any);
        clusters.push(cluster);
        await cluster.connect();
        await cluster.ready;
        return { cluster, servers };
    };

    it('the node with the block is pinged, the node without it is not', async () => {
        const { cluster, servers } = await mixed();
        // the legacy check left one idle in the second pool. A query leaves one in the first
        await ask(cluster);
        const idle = cluster.getPoolStats().map((stats: any) => stats.idle);

        await until(() => servers[0].pings().length >= 3, 'three pings', servers[0].pings);
        await moreTicks(2);

        expect([idle, servers[1].pings()]).toEqual([[1, 1], []]);
    });
});

// Node runs a timer whose wait is below 1 ms or above 2147483647 after 1 ms, and the
// settings take such an idleCheckInterval. 300 ticks of the reaper are 300 ms or more
describe('an idleCheckInterval that makes the reaper look every millisecond', () => {
    // Node says once per process that it took 1 ms for such a wait. Not this suite's line
    let warned: jest.SpyInstance;
    beforeEach(() => {
        warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    });
    afterEach(() => warned.mockRestore());
    // the pings one idle pooled connection got in 300 ticks, and how long those took
    const inTicks = async (pool: object) => {
        const { cluster, server } = await behind(pool);
        if (pooled(cluster).idle === 0) await ask(cluster);
        const from = server.pings().length;
        const began = Date.now();
        await moreTicks(300);
        return { pings: server.pings().length - from, ms: Date.now() - began };
    };

    it.each([
        ['0', 0], ['a negative number', -5], ['a fraction below 1', 0.4]
    ])('%s on a node with the block: a ping every 100 ms, not at every tick', async (_n, odd) => {
        const { pings, ms } = await inTicks({ ...BLOCK, idleCheckInterval: odd });

        expect(pings).toBeGreaterThanOrEqual(1);
        expect(pings).toBeLessThanOrEqual(Math.floor(ms / 100) + 1);
    });

    it('2147483648 on a node with the block: no ping in those 300 ticks', async () => {
        expect((await inTicks({ ...BLOCK, idleCheckInterval: 2147483648 })).pings).toBe(0);
    });

    it.each([
        ['0', 0], ['a negative number', -5], ['a fraction below 1', 0.4],
        ['2147483648', 2147483648]
    ])('%s on a node without the block: no ping, as before', async (_name, odd) => {
        expect((await inTicks({ ...LEGACY, idleCheckInterval: odd })).pings).toBe(0);
    });
});

describe('the ping and the life of a cluster', () => {
    // mysql2 queues the logout behind the ping. The server answers a logout and never
    // this ping, as behind a path that died for the open flows
    it('disconnect() while a ping has no answer: every connection is closed, and nothing ' +
        'is logged about that ping', async () => {
        const { cluster, server, removals } = await quiet();
        await heldPing(server);

        cluster.disconnect();
        await until(() => server.open() === 0, 'no connection after a disconnect', server.open);

        expect(removals()).toEqual([]);
    });

    it('disconnect() with no ping out logs out of the pooled connection, as before',
        async () => {
            const { cluster, server } = await quiet({ ...BLOCK, idleCheckInterval: LONG });

            cluster.disconnect();
            await until(() => server.open() === 0, 'no connection after a disconnect',
                server.open);

            // the check connection and the pooled one
            expect(server.quits()).toBe(2);
        });

    it('connect, disconnect, connect: the connection of the new pool is pinged', async () => {
        const { cluster, server } = await quiet();
        cluster.disconnect();
        await until(() => server.open() === 0, 'no connection after a disconnect', server.open);
        const before = server.pings().length;

        await cluster.connect();
        await ask(cluster);
        await until(() => server.pings().length > before, 'a ping after the second connect',
            server.pings);

        // open at the server: the check connection and the pooled one of the second connect()
        expect([server.open(), pooled(cluster)]).toEqual([2, ONE_IDLE]);
    });

    // mysql2 takes such a connection out of its pool by itself. The reaper still knows it,
    // and its next ping fails before a byte is sent
    it('a pooled connection the server closed while it was idle: forgotten with one line ' +
        'that has no code', async () => {
        const { cluster, server, removals } = await quiet();
        const before = server.pings().length;

        server.closeAfterNextPing();
        await until(() => pooled(cluster).idle === 0, 'mysql2 to drop it', () => pooled(cluster));
        await moreTicks(3);

        expect(removals()).toEqual([{ pool: 'node-a', idlePing: 'failed' }]);
        expect([removals()[0].code, server.pings().length - before]).toEqual([undefined, 1]);
    });
});
