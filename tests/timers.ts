import { createHook } from 'async_hooks';

// The timers a scenario of a test leaves running, for the suites of #120. A count of every
// timer of the process before and after the scenario broke under load: jest and other code in
// the process start and end timers of their own meanwhile. This records only the timers
// started while it runs, and forgets each one that fires or is cleared
export interface ITimerRecord {
    // Ends the record. Resolves with the wait in ms of each recorded timer that still keeps
    // the process alive: not fired, not cleared, and ref'd
    stop: () => Promise<number[]>
}

// Turns off the hook of each record not stopped yet. A test that failed before stop() leaves
// its record here, and this afterEach of every file that imports this one turns it off, so no
// hook outlives its test in a worker that runs other files next
const open = new Set<() => void>();
afterEach(() => open.forEach(close => close()));

export const recordTimers = (): ITimerRecord => {
    const started = new Map<number, NodeJS.Timeout>();
    const hook = createHook({
        init: (asyncId, type, _trigger, resource) => {
            if (type === 'Timeout') started.set(asyncId, resource as NodeJS.Timeout);
        },
        destroy: asyncId => { started.delete(asyncId); }
    }).enable();
    const close = () => {
        hook.disable();
        open.delete(close);
    };
    open.add(close);
    return {
        stop: async () => {
            // Node calls the destroy hook of a timer that fired or was cleared on a later turn
            // of the event loop, not at once, so the hook must stay on until then. Two turns
            // is measured on Node 24 (one was enough for 50 cleared timers), not guaranteed by
            // Node. A destroy later than that leaves its ended timer here, and hasRef() stays
            // true after a timer ended: a miss is a false failure that names a timer already
            // gone, never a false pass, since a timer that still runs gets no destroy at all
            for (let turn = 0; turn < 2; turn++) {
                await new Promise(resolve => setImmediate(resolve));
            }
            close();
            const left = [...started.values()]
                .filter(timer => timer.hasRef())
                .map(timer => (timer as unknown as { _idleTimeout: number })._idleTimeout);
            started.clear();
            return left;
        }
    };
};
