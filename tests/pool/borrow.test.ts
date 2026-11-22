import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import Logger from '../../src/utils/Logger';

// The one place a pooled connection is taken and given back (#93, #94), with the cluster of
// createPoolCluster and the real mysql2 against mysql2's own server class on the loopback
// interface. The fake server writes down every command of the pooled connections: a ping, a
// reset, or the text of a query. The check connection of a node with a healthCheck block is
// left out of that list: it is the one connection that changes the user
const COM_CHANGE_USER = 0x11;
const COM_RESET_CONNECTION = 0x1f;
// status flags of an OK header
const IN_TRANSACTION = 1;
const AUTOCOMMIT = 2;
const LONG = 600000;
const APP_SQL = 'SELECT 1';
const BEGIN = 'START TRANSACTION';
// the defaults of probeIdle and probeTimeout
const PROBE_IDLE = 1000;
const PROBE_TIMEOUT = 1000;
// the default resetTimeout
const RESET_TIMEOUT = 1000;

// loopback only: a hang here is a bug, not a slow network
jest.setTimeout(20000);

const closers: (() => void)[] = [];
afterAll(() => closers.forEach(close => close()));

// mysql2 prints the warning of packets out of order on stderr, and the server class of mysql2
// does not count the packets of a client command and says so too. Only that line is dropped.
// Each test sets it again: the spies of a test are restored after it
const consoleError = console.error;
beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('got packets out of order')) consoleError(...args);
    });
});
afterEach(() => jest.restoreAllMocks());

const column = (name: string) => ({
    catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: '',
    characterSet: 33, columnLength: 384, columnType: 253, flags: 0, decimals: 0
});
// What the health check of a pool wants to see from a node. The node that reports fewer
// connections has the lower load score, and a query tries it first
const status = (connections: number) => [
    { Variable_name: 'wsrep_ready', Value: 'ON' },
    { Variable_name: 'wsrep_local_state_comment', Value: 'Synced' },
    { Variable_name: 'Threads_running', Value: '1' },
    { Variable_name: 'Connections', Value: String(connections) },
    { Variable_name: 'wsrep_local_recv_queue_avg', Value: '0' }
];

// The answer to a prepare of the protocol: a statement with no columns and no parameters,
// in the shape writePacket() of mysql2's server class takes
const prepareOk = (statementId: number) => {
    // the header of 4 bytes, then 0, the id, and zeros for columns, parameters and warnings
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(statementId, 5);
    return {
        buffer,
        length: () => buffer.length,
        writeHeader: (sequenceId: number) => {
            buffer.writeUIntLE(buffer.length - 4, 0, 3);
            buffer[3] = sequenceId;
        }
    };
};

interface IServer {
    port: number,
    // what the pooled connections sent, in order: 'ping', 'reset', or the text of a query
    order: () => string[],
    logins: () => number,
    // pooled connections open at the server right now
    open: () => number,
    // keep the answer to every ping from now on, until answerPings()
    holdPings: () => void,
    answerPings: () => void,
    // close the connection a ping comes on, with no answer
    hangUpOnPing: () => void,
    // answer the next query or execute with a reply whose first packet has the wrong
    // sequence number, and never finish that reply: mysql2 then waits for the rest until the
    // query's timeout
    outOfOrder: () => void,
    // answer every reset with the wrong sequence number from now on
    resetOutOfOrder: () => void,
    // close every new connection before its login from now on
    hangUpOnLogin: () => void,
    // answer no status query of a health check from now on
    ignoreChecks: () => void
}
const listen = async (connections = 1): Promise<IServer> => {
    const server: any = (mysql as any).createServer();
    const opened: any[] = [];
    // the connections that changed the user: the check connection
    const checks = new Set<any>();
    const seen: { what: string, connection: any }[] = [];
    const held: any[] = [];
    const modes = {
        holding: false, hangUp: false, outOfOrder: false, hangUpOnLogin: false,
        resetOutOfOrder: false, ignoreChecks: false
    };
    let statements = 0;
    const ok = (connection: any, serverStatus = AUTOCOMMIT) => {
        connection.sequenceId = 1;
        connection.writeOk({ serverStatus });
    };
    closers.push(() => {
        server.close();
        opened.forEach(connection => connection.stream.destroy());
    });
    server.on('connection', (connection: any) => {
        opened.push(connection);
        connection.on('error', () => undefined);
        if (modes.hangUpOnLogin) return connection.stream.destroy();
        const note = (what: string) => seen.push({ what, connection });
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: opened.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null) => void) => done(null)
        });
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known) return;
            if (code === COM_CHANGE_USER) checks.add(connection);
            if (code === COM_RESET_CONNECTION) note('reset');
            if (code === COM_RESET_CONNECTION && modes.resetOutOfOrder) {
                connection.sequenceId = 5;
                return connection.writeOk({ serverStatus: AUTOCOMMIT });
            }
            if (code === COM_CHANGE_USER || code === COM_RESET_CONNECTION) ok(connection);
        });
        connection.on('ping', () => {
            note('ping');
            if (modes.hangUp) return connection.stream.destroy();
            if (modes.holding) return held.push(connection);
            ok(connection);
        });
        // the client counts 1 for the first packet of a reply
        const answerOutOfOrder = () => {
            modes.outOfOrder = false;
            connection.sequenceId = 5;
            connection.writeColumns([column('a')]);
        };
        connection.on('stmt_prepare', (sql: string) => {
            note('prepare ' + sql);
            connection.sequenceId = 1;
            connection.writePacket(prepareOk(++statements));
        });
        connection.on('stmt_execute', () => {
            note('execute');
            if (modes.outOfOrder) return answerOutOfOrder();
            ok(connection);
        });
        connection.on('query', (sql: string) => {
            note(sql);
            if (modes.outOfOrder) return answerOutOfOrder();
            if (sql === BEGIN) return ok(connection, IN_TRANSACTION | AUTOCOMMIT);
            if (sql !== 'SHOW GLOBAL STATUS;') return ok(connection);
            if (modes.ignoreChecks) return;
            connection.sequenceId = 1;
            const rows = status(connections);
            connection.writeTextResult(rows, [column('Variable_name'), column('Value')]);
        });
        connection.on('quit', () => connection.close());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const pooled = (connection: any) => !checks.has(connection);
    return {
        port: (server._server.address() as AddressInfo).port,
        order: () => seen.filter(entry => pooled(entry.connection)).map(entry => entry.what),
        logins: () => opened.filter(pooled).length,
        open: () => opened.filter(c => pooled(c) && !c.stream.destroyed).length,
        holdPings: () => { modes.holding = true; },
        answerPings: () => {
            modes.holding = false;
            held.splice(0).forEach(connection => ok(connection));
        },
        hangUpOnPing: () => { modes.hangUp = true; },
        outOfOrder: () => { modes.outOfOrder = true; },
        resetOutOfOrder: () => { modes.resetOutOfOrder = true; },
        hangUpOnLogin: () => { modes.hangUpOnLogin = true; },
        ignoreChecks: () => { modes.ignoreChecks = true; }
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
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// a test must not leave timers and sockets behind, whether its connect passed or not
const clusters: any[] = [];
afterEach(() => clusters.splice(0).forEach(cluster => cluster.disconnect()));

// A node with the block whose checks are ten minutes apart, on a connection of their own: the
// pool carries only what a test sends. The reaper pings no idle connection either
const QUIET = { healthCheck: { interval: LONG }, idleCheckInterval: LONG };
// a node without the block. Its legacy check goes through the pool, ten minutes apart
const LEGACY = { timerCheckRange: { start: LONG, end: LONG }, idleCheckInterval: LONG };

// one node per server, connected
const connectCluster = async (servers: IServer[], pool: object = QUIET) => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: servers.map(({ port }, i) => ({ host: '127.0.0.1', port, id: i + 1 })),
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [], ...pool },
        useClusterHashing: false,
        logger
    } as any);
    clusters.push(cluster);
    await cluster.connect();
    // every node has a load score by now
    await cluster.ready;
    return cluster;
};
// one node, and a pool that holds one idle connection: the one the first query opened
const idleNode = async (pool: object = QUIET) => {
    const server = await listen();
    const cluster = await connectCluster([server], pool);
    expect(await ask(cluster)).toBe('answered');
    await until(() => stats(cluster).idle === 1, 'the connection to be idle', () => stats(cluster));
    return { server, cluster, pool: cluster.pools[0] };
};
// One query straight to the pool of the first node: 'answered', or the code it was
// rejected with. With no timeout: mysql2 keeps the timer of a query whose connection was lost
const ask = (cluster: any, options: object = {}): Promise<string> => {
    return cluster.pools[0].query(APP_SQL, { timeout: 0, ...options })
        .then(() => 'answered', (error: any) => String(error.code));
};
const stats = (cluster: any, node = 0) => {
    const { used, idle, pending } = cluster.getPoolStats()[node];
    return { used, idle, pending };
};
// the commands the server got since `from` of them
const since = (server: IServer, from: number) => server.order().slice(from);
// the pooled connections of mysql2, in use or idle
const connectionsOf = (pool: any): any[] => {
    const all = pool._pool._allConnections;
    return Array.from({ length: all.length }, (_, i) => all.get(i));
};

describe('the probe of an idle connection', () => {
    it('idle 900 ms: lent with no ping', async () => {
        const { server, cluster } = await idleNode();
        const from = server.order().length;

        await pause(PROBE_IDLE - 100);

        expect([await ask(cluster), since(server, from)]).toEqual(['answered', [APP_SQL]]);
    });

    it('idle 1100 ms: one ping, then the statement on the same connection', async () => {
        const { server, cluster } = await idleNode();
        const [from, logins] = [server.order().length, server.logins()];

        await pause(PROBE_IDLE + 100);

        expect([await ask(cluster), since(server, from)]).toEqual(['answered', ['ping', APP_SQL]]);
        expect(server.logins()).toBe(logins);
    });

    it('a new connection is lent with no ping', async () => {
        const server = await listen();
        const cluster = await connectCluster([server]);

        expect([await ask(cluster), server.order()]).toEqual(['answered', [APP_SQL]]);
    });

    it('a ping that never answers: within probeTimeout the connection is destroyed and the ' +
        'next one is lent', async () => {
        const { server, cluster } = await idleNode();
        const [from, logins] = [server.order().length, server.logins()];
        server.holdPings();
        await pause(PROBE_IDLE + 100);

        const started = Date.now();
        const answer = await ask(cluster);
        const took = Date.now() - started;

        // the ping on the old connection, the statement on a new one that needed no ping
        expect([answer, since(server, from), server.logins() - logins])
            .toEqual(['answered', ['ping', APP_SQL], 1]);
        expect(took).toBeGreaterThanOrEqual(PROBE_TIMEOUT - 10);
        expect(took).toBeLessThan(PROBE_TIMEOUT + 400);
        await until(() => server.open() === 1, 'the old connection to close', server.open);
        expect(stats(cluster)).toEqual({ used: 0, idle: 1, pending: 0 });
    });

    it('a clean release sends nothing', async () => {
        const { server, cluster } = await idleNode();
        const from = server.order().length;

        expect(await ask(cluster)).toBe('answered');
        await pause(50);

        expect([since(server, from), stats(cluster)])
            .toEqual([[APP_SQL], { used: 0, idle: 1, pending: 0 }]);
    });

    it('probeIdle and probeTimeout of the settings', async () => {
        const { server, cluster } = await idleNode({ ...QUIET, probeIdle: 200, probeTimeout: 300 });
        const from = server.order().length;
        await pause(300);
        expect(await ask(cluster)).toBe('answered');
        server.holdPings();
        await pause(300);

        const started = Date.now();
        expect(await ask(cluster)).toBe('answered');
        const took = Date.now() - started;

        expect(since(server, from)).toEqual(['ping', APP_SQL, 'ping', APP_SQL]);
        expect([took >= 290, took < 700]).toEqual([true, true]);
    });
});

describe('a failed probe', () => {
    it('reaches passive health once, and the query is answered on a new connection',
        async () => {
            const { server, cluster, pool } = await idleNode();
            const heard = jest.spyOn(pool.status, 'probeFailed');
            const told = jest.spyOn(pool.status, 'realFailure');
            server.hangUpOnPing();
            await pause(PROBE_IDLE + 100);

            const answer = await ask(cluster);

            expect([answer, heard.mock.calls.length, told.mock.calls.length])
                .toEqual(['answered', 1, 0]);
            expect(cluster.nodes()[0].isValid).toBe(true);
        });

    it('every connection fails, the new one at its login: rejected with sent false, and ' +
        'cluster.query asks the next node', async () => {
        // node 1 is tried first: it reports fewer connections
        const servers = [await listen(1), await listen(5)];
        const cluster = await connectCluster(servers);
        expect(await cluster.query(APP_SQL, undefined, { timeout: 0 })).toBeTruthy();
        const first = servers.map(server => server.order().length);
        servers[0].hangUpOnPing();
        servers[0].hangUpOnLogin();
        await pause(PROBE_IDLE + 100);

        const outcome: any = {};
        const failure = await cluster.pools[0].query(APP_SQL, { timeout: 0 }, outcome)
            .catch((e: any) => e);
        const answered = await cluster.query(APP_SQL, undefined, { timeout: 0 });

        expect([failure.fatal, failure.sent, outcome.sent]).toEqual([true, false, false]);
        expect(answered).toBeTruthy();
        expect(since(servers[0], first[0])).toEqual(['ping']);
        expect(since(servers[1], first[1])).toEqual([APP_SQL]);
    });

    it('an abort during the probe drops the connection and rejects with the reason, and ' +
        'passive health is not told', async () => {
        const { server, cluster, pool } = await idleNode();
        const heard = jest.spyOn(pool.status, 'probeFailed');
        const logins = server.logins();
        server.holdPings();
        await pause(PROBE_IDLE + 100);
        const controller = new AbortController();
        const reason = new Error('the app gave up');

        const outcome: any = {};
        const asked = pool.query(APP_SQL, { timeout: 0, signal: controller.signal }, outcome)
            .catch((e: any) => e);
        await until(() => server.order().includes('ping'), 'the ping', server.order);
        controller.abort(reason);

        expect([await asked, outcome.aborted, outcome.sent]).toEqual([reason, true, false]);
        await until(() => server.open() === 0, 'the connection to close', server.open);
        expect([server.logins() - logins, heard.mock.calls.length, stats(cluster)])
            .toEqual([0, 0, { used: 0, idle: 0, pending: 0 }]);
    });
});

describe('a node health gives up while the borrow probes it', () => {
    // Two nodes, node 1 asked first, each with up to 3 connections. Node 1 holds 3 idle ones,
    // idle past probeIdle, then answers no ping and no check: it is cut off
    const cutOff = async (healthCheck: object) => {
        const servers = [await listen(1), await listen(5)];
        const settings = { ...QUIET, healthCheck, connectionLimit: 3 };
        const cluster = await connectCluster(servers, settings);
        const asks = [0, 1, 2].map(() => ask(cluster));
        expect(await Promise.all(asks)).toEqual(['answered', 'answered', 'answered']);
        await until(() => stats(cluster).idle === 3, 'three idle connections',
            () => stats(cluster));
        await pause(PROBE_IDLE + 100);
        const [from, logins] = [servers.map(s => s.order().length), servers[0].logins()];
        servers[0].holdPings();
        servers[0].ignoreChecks();
        return { cluster, servers, from, logins };
    };

    it('given up during the first probe: one probeTimeout, not three, then the next node',
        async () => {
            // a check every 200 ms, and one failed check takes the node down
            const { cluster, servers, from, logins } =
                await cutOff({ interval: 200, timeout: 100, fall: 1 });

            const started = Date.now();
            const answer = await cluster.query(APP_SQL, undefined, { timeout: 0 });
            const took = Date.now() - started;

            expect(answer).toBeTruthy();
            expect(since(servers[0], from[0])).toEqual(['ping']);
            expect(since(servers[1], from[1])).toEqual([APP_SQL]);
            expect(servers[0].logins()).toBe(logins);
            expect([took >= PROBE_TIMEOUT - 10, took < PROBE_TIMEOUT + 400]).toEqual([true, true]);
        });

    it('by passive health: the probe after the check that the lost connection started',
        async () => {
            // no check of the timer: only the one passive health starts, which gets no answer
            const { cluster, servers, from, logins } =
                await cutOff({ interval: LONG, timeout: 300 });

            const started = Date.now();
            const answer = await cluster.query(APP_SQL, undefined, { timeout: 0 });
            const took = Date.now() - started;

            expect(answer).toBeTruthy();
            expect(cluster.nodes()[0].isValid).toBe(false);
            expect(since(servers[0], from[0])).toEqual(['ping', 'ping']);
            expect(since(servers[1], from[1])).toEqual([APP_SQL]);
            expect(servers[0].logins()).toBe(logins);
            expect([took >= 2 * PROBE_TIMEOUT - 10, took < 2 * PROBE_TIMEOUT + 400])
                .toEqual([true, true]);
        });
});

describe('the probe and the ping of the reaper', () => {
    it('an answered ping of the reaper counts as seen alive: no probe', async () => {
        // the reaper pings the idle connection every 300 ms
        const { server, cluster } = await idleNode({ ...QUIET, idleCheckInterval: 300 });
        await pause(PROBE_IDLE + 300);
        const pings = server.order().filter(what => what === 'ping').length;

        expect(await ask(cluster)).toBe('answered');

        // the reaper pings no connection in use, so a ping here would be the probe's
        expect(pings).toBeGreaterThanOrEqual(3);
        expect(server.order().filter(what => what === 'ping').length).toBe(pings);
    });

    it('a borrow that meets the ping of the reaper still out sends no second ping',
        async () => {
            // the first ping of the reaper goes out 1200 ms after connect, past probeIdle
            const { server, cluster } = await idleNode({ ...QUIET, idleCheckInterval: 1200 });
            const from = server.order().length;
            server.holdPings();
            await until(() => since(server, from).includes('ping'), 'the ping', server.order);

            const asked = ask(cluster);
            await pause(200);
            const waiting = since(server, from);
            server.answerPings();

            expect([waiting, await asked, since(server, from)])
                .toEqual([['ping'], 'answered', ['ping', APP_SQL]]);
        });

    // The reaper pings every idle connection, also one used within probeIdle. A borrow that
    // meets such a ping still out waits for it, within probeTimeout
    it('a ping of the reaper still out on a connection used within probeIdle: bounded by ' +
        'probeTimeout, the query is answered on a new connection', async () => {
        const { server, cluster } = await idleNode({ ...QUIET, idleCheckInterval: 300 });
        const [from, logins] = [server.order().length, server.logins()];
        server.holdPings();
        await until(() => since(server, from).includes('ping'), 'the ping', server.order);

        const started = Date.now();
        const answer = await Promise.race([ask(cluster), pause(3000).then(() => 'waiting')]);
        const took = Date.now() - started;

        expect([answer, since(server, from), server.logins() - logins])
            .toEqual(['answered', ['ping', APP_SQL], 1]);
        expect([took >= PROBE_TIMEOUT - 10, took < PROBE_TIMEOUT + 400]).toEqual([true, true]);
    });

    it('the ping of the reaper that never answers: the next connection after probeTimeout',
        async () => {
            const { server, cluster } = await idleNode({ ...QUIET, idleCheckInterval: 1200 });
            const [from, logins] = [server.order().length, server.logins()];
            server.holdPings();
            await until(() => since(server, from).includes('ping'), 'the ping', server.order);

            const started = Date.now();
            const answer = await ask(cluster);
            const took = Date.now() - started;

            expect([answer, since(server, from), server.logins() - logins])
                .toEqual(['answered', ['ping', APP_SQL], 1]);
            expect([took >= PROBE_TIMEOUT - 10, took < PROBE_TIMEOUT + 400]).toEqual([true, true]);
        });
});

describe('the health check of a node without a block', () => {
    it('is never probed', async () => {
        const server = await listen();
        // the check of the timer after 1500 ms draws the connection the check of connect()
        // left idle
        const settings = { ...LEGACY, timerCheckRange: { start: 1500, end: 1500 } };
        await connectCluster([server], settings);
        const checks = () => server.order().filter(what => what === 'SHOW GLOBAL STATUS;');

        await until(() => checks().length === 2, 'the check of the timer', server.order);

        expect(server.order()).toEqual(['SHOW GLOBAL STATUS;', 'SHOW GLOBAL STATUS;']);
    });
});

describe('resetAfterStatements', () => {
    it('3: one reset after the third statement, and the count starts over', async () => {
        const server = await listen();
        // one connection: the fourth statement waits for the reset of the third
        const settings = { ...QUIET, connectionLimit: 1, resetAfterStatements: 3 };
        const cluster = await connectCluster([server], settings);

        for (let i = 0; i < 4; i++) expect(await ask(cluster)).toBe('answered');
        await pause(50);

        expect(server.order()).toEqual([APP_SQL, APP_SQL, APP_SQL, 'reset', APP_SQL]);
        expect(server.logins()).toBe(1);
    });

    it('defaults to 1000', async () => {
        const server = await listen();
        const cluster = await connectCluster([server]);

        for (let i = 0; i < 10; i++) expect(await ask(cluster)).toBe('answered');

        expect(server.order()).toEqual(Array(10).fill(APP_SQL));
        expect(cluster.pools[0]._session._resetAfterStatements).toBe(1000);
    });
});

describe('packets out of order', () => {
    const TIMEOUT = 3000;

    it('the call rejects with MDC_PACKETS_OUT_OF_ORDER well before its timeout, and the ' +
        'connection is destroyed', async () => {
        const { server, cluster, pool } = await idleNode();
        server.outOfOrder();

        const started = Date.now();
        const outcome: any = {};
        const failure = await pool.query(APP_SQL, { timeout: TIMEOUT }, outcome)
            .catch((e: any) => e);
        const took = Date.now() - started;

        expect([failure.code, failure.expected, failure.received, failure.nodeId])
            .toEqual(['MDC_PACKETS_OUT_OF_ORDER', 1, 5, 1]);
        expect([failure.sent, outcome.sent, took < 500]).toEqual([true, true, true]);
        await until(() => server.open() === 0, 'the connection to close', server.open);
        expect(stats(cluster)).toEqual({ used: 0, idle: 0, pending: 0 });
    });

    it('cluster.query asks no other node', async () => {
        // node 1 is tried first: it reports fewer connections
        const servers = [await listen(1), await listen(5)];
        const cluster = await connectCluster(servers);
        const second = jest.spyOn(cluster.pools[1], 'query');
        servers[0].outOfOrder();

        const failure = await cluster.query(APP_SQL, undefined, { timeout: TIMEOUT })
            .catch((e: any) => e);

        expect([failure.code, failure.sent, failure.nodeId])
            .toEqual(['MDC_PACKETS_OUT_OF_ORDER', true, 1]);
        expect(second).not.toHaveBeenCalled();
    });

    it('the same for execute(): rejected well before its timeout, no other node asked',
        async () => {
            const servers = [await listen(1), await listen(5)];
            const cluster = await connectCluster(servers);
            const second = jest.spyOn(cluster.pools[1], 'query');
            servers[0].outOfOrder();

            const started = Date.now();
            const failure = await cluster.execute(APP_SQL, [1], { timeout: TIMEOUT })
                .catch((e: any) => e);
            const took = Date.now() - started;

            expect([failure.code, failure.sent, failure.nodeId, failure.expected])
                .toEqual(['MDC_PACKETS_OUT_OF_ORDER', true, 1, 1]);
            expect([took < 500, servers[0].order()])
                .toEqual([true, ['prepare ' + APP_SQL, 'execute']]);
            await until(() => servers[0].open() === 0, 'the connection to close', servers[0].open);
            expect(second).not.toHaveBeenCalled();
        });

    it('a connection that answered in order has no warn listener left', async () => {
        const { cluster, pool } = await idleNode();
        expect(await ask(cluster)).toBe('answered');
        const lent = await cluster.getConnection();
        lent.connection.release();
        await until(() => stats(cluster).idle === 1, 'the release', () => stats(cluster));

        const connections = connectionsOf(pool);
        expect(connections.map(connection => connection.listenerCount('warn'))).toEqual([0]);
    });

    it('on a lent connection: destroyed, and the pending command fails with the error of ' +
        'mysql2', async () => {
        const { server, cluster } = await idleNode();
        const { connection } = await cluster.getConnection();
        const from = server.order().length;
        server.outOfOrder();

        const failure = await new Promise<any>(resolve => {
            connection.query({ sql: APP_SQL, timeout: TIMEOUT }, (error: any) => resolve(error));
        });
        await until(() => server.open() === 0, 'the connection to close', server.open);
        connection.release();
        await pause(50);

        expect([failure.expected, failure.received, failure.fatal]).toEqual([1, 5, true]);
        expect(since(server, from)).toEqual([APP_SQL]);
        expect(stats(cluster)).toEqual({ used: 0, idle: 0, pending: 0 });
    });
});

describe('getConnection()', () => {
    it('a transaction left open, then release(): rolled back before the next caller gets ' +
        'the connection', async () => {
        const server = await listen();
        const cluster = await connectCluster([server], { ...QUIET, connectionLimit: 1 });
        const { connection } = await cluster.getConnection();
        await new Promise(resolve => connection.query(BEGIN, resolve));

        connection.release();
        const next = await cluster.getConnection();
        const order = server.order();
        next.connection.release();

        expect(next.connection).toBe(connection);
        expect(order).toEqual([BEGIN, 'reset']);
    });

    it('the reset of a lent connection comes before the next query of the cluster on it',
        async () => {
            const server = await listen();
            const cluster = await connectCluster([server], { ...QUIET, connectionLimit: 1 });
            const { connection } = await cluster.getConnection();

            connection.release();
            expect(await ask(cluster)).toBe('answered');

            // a lent connection is reset whether the app left anything on it or not
            expect(server.order()).toEqual(['reset', 'USE `d`', APP_SQL]);
        });

    it('an abort during the probe on the way out: rejected with the reason, the connection ' +
        'destroyed, no login', async () => {
        const { server, cluster } = await idleNode();
        const logins = server.logins();
        server.holdPings();
        await pause(PROBE_IDLE + 100);
        const controller = new AbortController();
        const reason = new Error('the app gave up');

        const asked = cluster.getConnection({ signal: controller.signal }).catch((e: any) => e);
        await until(() => server.order().includes('ping'), 'the ping', server.order);
        controller.abort(reason);

        const failure = await asked;
        await until(() => server.open() === 0, 'the connection to close', server.open);
        expect([failure, failure.nodeId, server.logins() - logins])
            .toEqual([reason, undefined, 0]);
        expect(stats(cluster)).toEqual({ used: 0, idle: 0, pending: 0 });
    });

    // mysql2 still runs the reset on the packet it warned of, and reports it answered. The
    // release counts it as failed all the same: the connection is gone, never put back
    it('a reset at release() answered out of order: the connection is dropped at once',
        async () => {
            const server = await listen();
            const cluster = await connectCluster([server], { ...QUIET, connectionLimit: 1 });
            const { connection } = await cluster.getConnection();
            server.resetOutOfOrder();
            const warned = jest.spyOn(Logger, 'warn');

            const started = Date.now();
            connection.release();
            await until(() => server.open() === 0, 'the connection to close', server.open);
            const took = Date.now() - started;

            expect([server.order(), took < RESET_TIMEOUT / 2]).toEqual([['reset'], true]);
            expect(stats(cluster)).toEqual({ used: 0, idle: 0, pending: 0 });
            const failed = warned.mock.calls.filter(([message]) => /reset .* failed/.test(message));
            expect(failed).toHaveLength(1);
            // the next caller gets a new connection
            const next = await cluster.getConnection();
            expect([next.connection === connection, server.logins()]).toEqual([false, 2]);
            next.connection.release();
        });

    it('is probed on the way out after idle', async () => {
        const { server, cluster } = await idleNode();
        const from = server.order().length;
        await pause(PROBE_IDLE + 100);

        const { connection } = await cluster.getConnection();

        expect(since(server, from)).toEqual(['ping']);
        connection.release();
    });

    it('a second release() is a no-op: one reset, the connection goes back once', async () => {
        const server = await listen();
        const cluster = await connectCluster([server], { ...QUIET, connectionLimit: 1 });
        const { connection } = await cluster.getConnection();

        connection.release();
        connection.release();
        await until(() => stats(cluster).idle === 1, 'the release', () => stats(cluster));
        connection.release();
        await pause(50);

        expect([server.order(), stats(cluster)])
            .toEqual([['reset'], { used: 0, idle: 1, pending: 0 }]);
    });
});
