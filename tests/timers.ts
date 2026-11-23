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

export const recordTimers = (): ITimerRecord => {
    const started = new Map<number, NodeJS.Timeout>();
    const hook = createHook({
        init: (asyncId, type, _trigger, resource) => {
            if (type === 'Timeout') started.set(asyncId, resource as NodeJS.Timeout);
        },
        destroy: asyncId => { started.delete(asyncId); }
    }).enable();
    return {
        stop: async () => {
            // Node calls the destroy hook of a timer that fired or was cleared on a later turn
            // of the event loop, not at once. The hook must stay on until then
            for (let turn = 0; turn < 2; turn++) {
                await new Promise(resolve => setImmediate(resolve));
            }
            hook.disable();
            return [...started.values()]
                .filter(timer => timer.hasRef())
                .map(timer => (timer as unknown as { _idleTimeout: number })._idleTimeout);
        }
    };
};
