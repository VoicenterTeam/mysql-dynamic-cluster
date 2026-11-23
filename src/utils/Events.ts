import { EventEmitter } from 'events';
import { ClusterEvent } from "../types/PoolInterfaces";
import Logger from "./Logger";

const eventEmitter = new EventEmitter();

const Events = {
    /**
     * Connect to the event
     * @param event event name
     * @param callback function what will be called after emit
     */
    on(event: ClusterEvent, callback: (...args: any[]) => void) {
        eventEmitter.on(event, callback);
    },
    /**
     * Emit the event. Call all functions what connected to the event, each in its own try,
     * so one that throws keeps none after it from the event. The first throw goes on to the
     * caller once every listener ran, as a throw did before. Each later one is logged at warn
     * @param event event name
     * @param args arguments what will be passed to the callback function, as one array
     * @private
     */
    emit(event: ClusterEvent, ...args: any[]) {
        let first: { thrown: unknown } | undefined;
        for (const listener of eventEmitter.listeners(event)) {
            try {
                // the arguments as one array, not one by one, see docs/events.md
                listener.call(eventEmitter, args);
            } catch (thrown) {
                if (!first) {
                    first = { thrown };
                    continue;
                }
                let error: unknown;
                try {
                    error = (thrown as any)?.message || thrown;
                } catch {
                    // a revoked proxy, a message getter that throws
                    error = 'unreadable error';
                }
                Logger.warn("A listener of the " + event + " event threw", { event, error });
            }
        }
        if (first) throw first.thrown;
    }
}

export default Events;
