import mysql from 'mysql2';
import { AddressInfo } from 'net';
import { createPoolCluster } from '../../index';
import { Timer } from '../../src/utils/Timer';

// The cluster of createPoolCluster and the real mysql2 against mysql2's own server class on
// the loopback interface. It shows what a node with a healthCheck block does with a login
// the server really refuses, in both shapes mysql2 hands such an error out: on a new
// connection, where it is not fatal, and at the change of user on an open connection, where
// mysql2 marks it fatal.
// A test runs the check of a node by hand, so nothing here waits for a clock. The wait a
// test wants to see pass is 300 ms and the other one ten minutes: the next login only
// reaches the server when the node took the right one
const COM_CHANGE_USER = 0x11;
const DENIED = { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' };
const NOT_VALID = 'pool in host 127.0.0.1 is not valid';
const SHORT = 300;
const LONG = 600000;

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

type Mode =
    | 'accepts'
    // answers every login with error 1045, as a server does for a wrong password
    | 'refuses the login'
    // takes the login, and answers the change of user with error 1045, as a server does
    // when the password changed while the connection was open
    | 'refuses the change of user'
    // takes the login and the change of user, and closes the connection on the query
    | 'hangs up on the query'
    // answers every login with error 1045 after LATE ms, as a server does that delays the
    // answer to a wrong password
    | 'refuses the login late';
const LATE = 1000;

// A server that behaves as its mode says. The mode can change while it runs. It counts the
// logins, the changes of user and the queries that reached it, and the late answers it sent
interface IServer {
    port: number, become: (next: Mode) => void, hangUp: () => void,
    logins: () => number, changes: () => number, queries: () => number, late: () => number
}
const listen = async (mode: Mode): Promise<IServer> => {
    const server: any = (mysql as any).createServer();
    const connections: any[] = [];
    const seen = { logins: 0, changes: 0, queries: 0, late: 0 };
    const pending: NodeJS.Timeout[] = [];
    const hangUp = () => connections.splice(0).forEach(connection => connection.stream.destroy());
    closers.push(() => {
        pending.forEach(clearTimeout);
        hangUp();
        server.close();
    });
    const refuse = { message: "Access denied for user 'u'@'127.0.0.1'", code: 1045 };
    server.on('connection', (connection: any) => {
        connections.push(connection);
        connection.on('error', () => undefined);
        // the server class sends no SQL state with an error. A real server sends 28000 with 1045
        const writePacket = connection.writePacket.bind(connection);
        connection.writePacket = (packet: any) => {
            if (packet._name === 'Error') packet.buffer.write('28000', 8, 'latin1');
            writePacket(packet);
        };
        connection.serverHandshake({
            protocolVersion: 10,
            serverVersion: '8.0.36',
            connectionId: connections.length,
            statusFlags: 2,
            characterSet: 8,
            capabilityFlags: 0x00ffffff,
            authCallback: (_params: object, done: (err: null, mysqlError?: object) => void) => {
                seen.logins++;
                if (mode === 'refuses the login') return done(null, refuse);
                if (mode !== 'refuses the login late') return done(null);
                pending.push(setTimeout(() => {
                    seen.late++;
                    done(null, refuse);
                }, LATE));
            }
        });
        // the pool changes the user of a connection before a query of its own
        connection.on('packet', (_packet: object, known: boolean, code: number) => {
            if (known || code !== COM_CHANGE_USER) return;
            seen.changes++;
            connection.sequenceId = 1;
            if (mode === 'refuses the change of user') return connection.writeError(refuse);
            connection.writeOk();
        });
        connection.on('query', () => {
            seen.queries++;
            if (mode === 'hangs up on the query') return connection.stream.destroy();
            connection.sequenceId = 1;
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
        changes: () => seen.changes,
        queries: () => seen.queries,
        late: () => seen.late
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

// The errors the checks of a test failed with, as pool_check_failed hands them out. The events
// of every cluster go through one emitter, so the first cluster of the file adds the listener
let failed: any[];
let listening = false;
// every wait the check timer of a node was started with, in order
let started: jest.SpyInstance;
beforeEach(() => {
    failed = [];
    started = jest.spyOn(Timer.prototype, 'start');
});
afterEach(() => started.mockRestore());
const timerWaits = (): number[] => started.mock.calls.map(([ms]) => ms);

// One node on the port, with one connection at most unless `limit` says more, and with
// flags, so connect() logs in once. `pool` goes into defaultPoolSettings: the healthCheck
// block, or the legacy range
const makeCluster = (port: number, pool: object, limit: number = 1): any => {
    const cluster: any = createPoolCluster({
        clusterName: 'test',
        hosts: [{ host: '127.0.0.1', port, id: 1, connectionLimit: limit }],
        defaultPoolSettings: { user: 'u', password: 'p', database: 'd', flags: [], ...pool },
        useClusterHashing: false,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    } as any);
    clusters.push(cluster);
    if (!listening) cluster.on('pool_check_failed', ([error]: any[]) => failed.push(error));
    listening = true;
    return cluster;
};
const connectOf = async (cluster: any): Promise<string | undefined> => {
    return cluster.connect().then(() => undefined, (reason: string) => reason);
};
// run one check of the node by hand, as its timer would
const check = (cluster: any): Promise<void> => cluster.pools[0].status.checkStatus();
const node = (cluster: any) => {
    const { isValid, checkError } = cluster.nodes()[0];
    return { isValid, checkError };
};
// what mysql2 handed the checks of this test: the errno and whether it was fatal
const handedOut = () => failed.map(error => [error.errno, error.fatal]);

// fall is 3 everywhere: no count of failed checks takes a node down with one check
const SLOW_RETRY = { healthCheck: { interval: LONG, authRetryInterval: SHORT, fall: 3 } };

describe('a node with a healthCheck block whose login the server refuses', () => {
    it('on an open connection: down with that check, fatal for mysql2', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster(server.port, SLOW_RETRY);
        expect(await connectOf(cluster)).toBeUndefined();
        server.become('refuses the change of user');

        await check(cluster);

        expect(node(cluster)).toStrictEqual({ isValid: false, checkError: DENIED });
        expect(handedOut()).toEqual([[1045, true]]);
    });

    it('on an open connection: the next check comes after authRetryInterval', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster(server.port, SLOW_RETRY);
        await connectOf(cluster);
        server.become('refuses the change of user');
        await check(cluster);
        const before = server.changes();

        // the timer of the node sends it: nothing here runs a check
        await until(() => server.changes() > before, 'the next change of user', server.changes);

        // the interval after the pass of connect(), authRetryInterval after the refusal
        expect(timerWaits().slice(0, 2)).toEqual([LONG, SHORT]);
    });

    it('on a new connection: down with that check, not fatal for mysql2', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster(server.port, SLOW_RETRY);
        expect(await connectOf(cluster)).toBeUndefined();
        // the open connection goes, so the check has to log in again
        server.become('refuses the login');
        server.hangUp();
        const idle = () => cluster.getPoolStats()[0].idle;
        await until(() => idle() === 0, 'the pool to drop its connection', idle);

        await check(cluster);

        expect(node(cluster)).toStrictEqual({ isValid: false, checkError: DENIED });
        expect(handedOut()).toEqual([[1045, undefined]]);
    });

    it('on a new connection: the next login comes after authRetryInterval', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster(server.port, SLOW_RETRY);
        await connectOf(cluster);
        server.become('refuses the login');
        server.hangUp();
        const idle = () => cluster.getPoolStats()[0].idle;
        await until(() => idle() === 0, 'the pool to drop its connection', idle);
        await check(cluster);
        const before = server.logins();

        await until(() => server.logins() > before, 'the next login', server.logins);

        expect(timerWaits().slice(0, 2)).toEqual([LONG, SHORT]);
    });

    it('at the check of connect(): the results keep the error, the next login waits', async () => {
        const server = await listen('refuses the login');
        const cluster = makeCluster(server.port, SLOW_RETRY);

        expect(await connectOf(cluster)).toBe(NOT_VALID);
        const [ready] = await cluster.ready;
        const [first] = await cluster.firstReady;
        expect([ready.ok, ready.checkError]).toStrictEqual([false, DENIED]);
        expect(first.checkError).toStrictEqual(DENIED);
        expect(node(cluster)).toStrictEqual({ isValid: false, checkError: DENIED });

        await until(() => server.logins() > 1, 'the second login', server.logins);
        expect(timerWaits()[0]).toBe(SHORT);
    });

    it('comes back by rise once the server accepts again', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster(server.port, SLOW_RETRY);
        await connectOf(cluster);
        server.become('refuses the change of user');
        await check(cluster);
        server.become('accepts');

        await check(cluster);
        const afterOnePass = node(cluster);
        await check(cluster);

        // the default rise is 2. The first pass already cleared the error
        expect(afterOnePass).toStrictEqual({ isValid: false, checkError: undefined });
        expect(node(cluster)).toStrictEqual({ isValid: true, checkError: undefined });
    });
});

describe('a server that holds its refusal back for longer than a check waits', () => {
    // The probe of the review of this rule. The check gives up after 150 ms, the server
    // answers after 1000. With a wait of 200 ms two more logins would come in that time
    const block = { interval: 200, timeout: 150, authRetryInterval: LONG, fall: 3 };

    it('gets no further login while the first late answer is on its way', async () => {
        const server = await listen('accepts');
        // five connections: a login that still waits for its answer blocks no other one
        const cluster = makeCluster(server.port, { healthCheck: block }, 5);
        await connectOf(cluster);
        // the timer of the node sees the first refusal, which comes in time
        server.become('refuses the login');
        server.hangUp();
        const refused = () => node(cluster).checkError?.errno === 1045;
        await until(refused, 'a refused check', () => node(cluster));
        server.become('refuses the login late');
        const before = server.logins();

        await check(cluster);
        const afterTimeout = node(cluster);
        await until(() => server.late() > 0, 'the late answer of the server', server.late);

        // that check ran into its own timeout, and the slow pace held
        expect(afterTimeout).toStrictEqual({ isValid: false, checkError: {} });
        expect([server.logins() - before, timerWaits().slice(-1)]).toEqual([1, [LONG]]);
    });
});

describe('next to it', () => {
    it('a lost connection counts toward fall and waits the interval', async () => {
        const server = await listen('accepts');
        const pool = { healthCheck: { interval: SHORT, authRetryInterval: LONG, fall: 9 } };
        const cluster = makeCluster(server.port, pool);
        await connectOf(cluster);
        server.become('hangs up on the query');

        await check(cluster);
        const afterOne = node(cluster);
        const before = server.queries();
        await until(() => server.queries() > before, 'the next status query', server.queries);

        expect(afterOne).toStrictEqual({
            isValid: true, checkError: { code: 'PROTOCOL_CONNECTION_LOST' }
        });
        // never the ten minutes of authRetryInterval
        expect(new Set(timerWaits())).toEqual(new Set([SHORT]));
    });

    it('a node without the block still needs two refused logins, at its own pace', async () => {
        const server = await listen('accepts');
        const cluster = makeCluster(server.port, { timerCheckRange: { start: LONG, end: LONG } });
        await connectOf(cluster);
        server.become('refuses the change of user');

        await check(cluster);
        const afterOne = node(cluster);
        await check(cluster);

        expect(afterOne).toStrictEqual({ isValid: true, checkError: DENIED });
        expect(node(cluster)).toStrictEqual({ isValid: false, checkError: DENIED });
        expect(handedOut()).toEqual([[1045, true], [1045, true]]);
        expect(timerWaits()).toEqual([LONG, LONG, LONG]);
    });
});
