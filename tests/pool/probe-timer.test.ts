import { EventEmitter } from 'events';
import mysql from 'mysql2';
import { probeServer } from '../../src/pool/ServerFlags';

// The timer of probeServer that closes a connection the server keeps after the logout.
// A stand-in connection and jest's timers: no socket, no real wait
const GRACE_MS = 2000;
const packet = { serverVersion: '8.0.36', capabilityFlags: 0 };

const startProbe = () => {
    const connection: any = new EventEmitter();
    connection.end = jest.fn();
    connection.destroy = jest.fn();
    connection.stream = { destroy: jest.fn() };
    jest.spyOn(mysql, 'createConnection').mockReturnValue(connection);
    const probe = probeServer({ host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' });
    return { connection, probe };
};

describe('the close timer of probeServer', () => {
    beforeEach(() => { jest.useFakeTimers(); });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('leaves the socket alone for 2 s less 1 ms after the logout', async () => {
        const { connection, probe } = startProbe();

        connection.emit('connect', packet);
        await probe.greeting;
        jest.advanceTimersByTime(GRACE_MS - 1);

        expect(connection.end).toHaveBeenCalledTimes(1);
        expect(connection.destroy).not.toHaveBeenCalled();
        expect(connection.stream.destroy).not.toHaveBeenCalled();
    });

    it('closes the connection and its socket after 2 s without an end', () => {
        const { connection } = startProbe();

        connection.emit('connect', packet);
        jest.advanceTimersByTime(GRACE_MS);

        expect(connection.destroy).toHaveBeenCalledTimes(1);
        expect(connection.stream.destroy).toHaveBeenCalledTimes(1);
    });

    it('is cleared when the connection ends cleanly', () => {
        const { connection } = startProbe();
        connection.emit('connect', packet);
        expect(jest.getTimerCount()).toBe(1);

        connection.emit('end');

        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(GRACE_MS * 2);
        expect(connection.destroy).not.toHaveBeenCalled();
        expect(connection.stream.destroy).not.toHaveBeenCalled();
    });

    it('is unrefed, so it does not keep the process running', () => {
        // a real timer: hasRef() is node's own answer
        jest.useRealTimers();
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        const { connection } = startProbe();

        const before = setTimeoutSpy.mock.results.length;
        connection.emit('connect', packet);
        const timers = setTimeoutSpy.mock.results.slice(before).map(result => result.value);
        connection.emit('end');

        expect(timers).toHaveLength(1);
        expect((timers[0] as NodeJS.Timeout).hasRef()).toBe(false);
    });
});
