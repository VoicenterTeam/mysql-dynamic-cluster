// The abort of a call by the signal of the app, and what a failed call leaves of its
// connection. Pool, Borrow and GaleraCluster share them

/**
 * What a call is rejected with when its signal aborted: the reason of the signal as it is.
 * A signal without one, as on a Node that has no signal.reason yet, gives an Error named
 * AbortError
 * @param signal the signal that aborted
 */
export function abortReason(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) return signal.reason;
    // the name, the code and the message of the AbortError of Node itself
    return Object.assign(new Error("The operation was aborted"), {
        name: 'AbortError', code: 'ABORT_ERR'
    });
}

/**
 * Run `aborted` once when the signal aborts, until the function this returns is called. Every
 * call that takes a signal listens this way, so no listener stays on the signal once the call
 * settled, and a signal that keeps its listeners and calls them later changes nothing. The
 * signal of the app runs `aborted` inside its abort(): nothing may be thrown there
 * @param signal the signal of the call, or nothing
 */
export function whenAborted(signal: AbortSignal | undefined, aborted: () => void): () => void {
    if (!signal) return () => undefined;
    let stopped = false;
    const stop = () => {
        stopped = true;
        signal.removeEventListener('abort', listener);
    };
    const listener = () => {
        if (stopped) return;
        stop();
        aborted();
    };
    signal.addEventListener('abort', listener);
    return stop;
}

/**
 * Whether an error leaves a connection that must not be used again: a dead socket, or one that
 * still runs a statement that timed out
 * @param error error from mysql2
 */
export function isBroken(error: any): boolean {
    return error?.fatal || error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT';
}
