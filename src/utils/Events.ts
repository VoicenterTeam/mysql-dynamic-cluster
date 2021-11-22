import { EventEmitter } from 'events';
import { ClusterEvent } from "../types/PoolInterfaces";

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
     * Emit the event. Call all functions what connected to the event
     * @param event event name
     * @param args arguments what will be passed to the callback function
     * @private
     */
    emit(event: ClusterEvent, ...args: any[]) {
        eventEmitter.emit(event, args);
    }
}

export default Events;
