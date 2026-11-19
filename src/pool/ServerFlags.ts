import mysql from "mysql2";

/**
 * Picks the mysql2 connection flags a node needs, from the greeting the server sends at login.
 *
 * mysql2 3.21.0 and later announce CLIENT_QUERY_ATTRIBUTES to every server that announces it too.
 * MySQL announces it since 8.0.23 but reads the prepared-statement packet that goes with it
 * only since 8.0.26. On the versions in between every connection.execute() gets no answer.
 * The flags of a connection are sent in the login reply, so they are decided before the pool logs in
 */

export const QUERY_ATTRIBUTES_OFF = '-CLIENT_QUERY_ATTRIBUTES';

// capability bit of the MySQL protocol
const CLIENT_QUERY_ATTRIBUTES = 0x08000000;
// first version that reads the prepared-statement packet with query attributes
const FIRST_FIXED_VERSION = [8, 0, 26];

export interface IServerGreeting {
    serverVersion: string;
    capabilityFlags: number;
}

export type FlagsReason =
    // the server does not announce the capability: mysql2 leaves it out by itself
    | 'not_announced'
    // MariaDB has its own protocol for this and its own version numbers
    | 'mariadb'
    | 'older_than_8.0.26'
    // announced, and the version does not start with three numbers
    | 'version_unreadable'
    | 'supported'
    // no greeting: the login failed
    | 'probe_failed';

export interface IFlagsDecision {
    // left out when mysql2's default flags are right for the server
    flags?: string[];
    reason: FlagsReason;
}

export interface IProbeOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

/**
 * Decide the flags for a server from its greeting. Without a greeting, and when in doubt,
 * the flag is turned off: that works on every server, it only gives up query attributes
 */
export function flagsForServer(greeting?: IServerGreeting): IFlagsDecision {
    const off = (reason: FlagsReason): IFlagsDecision => ({ flags: [QUERY_ATTRIBUTES_OFF], reason });

    if (!greeting) return off('probe_failed');
    if (!(greeting.capabilityFlags & CLIENT_QUERY_ATTRIBUTES)) return { reason: 'not_announced' };

    const version = String(greeting.serverVersion);
    if (/mariadb/i.test(version)) return { reason: 'mariadb' };

    const numbers = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!numbers) return off('version_unreadable');

    for (let i = 0; i < FIRST_FIXED_VERSION.length; i++) {
        const part = Number(numbers[i + 1]);
        if (part < FIRST_FIXED_VERSION[i]) return off('older_than_8.0.26');
        if (part > FIRST_FIXED_VERSION[i]) break;
    }
    return { reason: 'supported' };
}

export interface IServerProbe {
    // rejects when the login fails or the probe is cancelled
    greeting: Promise<IServerGreeting>;
    // drop the connection and its socket now. Safe to call at any time, more than once
    cancel(): void;
}

// how long a server gets to close the socket after the logout, before the probe closes it
const CLOSE_GRACE_MS = 2000;

/**
 * Close a connection for good. mysql2's destroy() only ends the writing side of the socket
 * and clears its own connect timer: a server that never answers would keep the socket,
 * and with it the process, open
 */
export function drop(connection: any): void {
    connection.destroy();
    connection.stream?.destroy();
}

/**
 * Log out of a connection: the logout is one packet, then the server closes. One that does
 * not would keep the socket, so the connection is dropped after CLOSE_GRACE_MS
 */
export function logOut(connection: any): void {
    connection.end();
    const timer = setTimeout(() => drop(connection), CLOSE_GRACE_MS);
    timer.unref();
    connection.once('end', () => clearTimeout(timer));
}

/**
 * Log in once, read the greeting and log out.
 * Without cancel(), mysql2 gives up on a server that does not answer after its connectTimeout,
 * 10 seconds by default
 */
export function probeServer(options: IProbeOptions): IServerProbe {
    // the probe sends no prepared statement, and with the flag off it works on every server
    const connection: any = mysql.createConnection({ ...options, flags: [QUERY_ATTRIBUTES_OFF] });
    let settled = false;
    let cancel: () => void;

    const greeting = new Promise<IServerGreeting>((resolve, reject) => {
        connection.once('connect', (packet: IServerGreeting) => {
            if (settled) return;
            settled = true;
            // the two values only: the packet also holds the data the password was scrambled with
            resolve({ serverVersion: packet.serverVersion, capabilityFlags: packet.capabilityFlags });
            logOut(connection);
        });
        // on, not once, and it stays after the greeting:
        // an error event without a listener would end the process
        connection.on('error', (error: Error) => {
            if (settled) return;
            settled = true;
            drop(connection);
            reject(error);
        });
        cancel = () => {
            drop(connection);
            if (settled) return;
            settled = true;
            reject(new Error('probe cancelled'));
        };
    });

    return { greeting, cancel };
}
