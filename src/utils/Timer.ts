/**
 * Created by Bohdan on Sep, 2021
 */

export class Timer {
    private _timer: NodeJS.Timeout;
    private readonly _callback: () => void;
    private _active: boolean = false;

    /**
     * @param callback callback what called when time is out
     */
    constructor(callback: () => void) {
        this._callback = callback;
        this._timer = null;
        this._active = true;
    }

    /** run timer
     * @param time time how much need to wait
     */
    public start (time: number) {
        if (!this._active) return;
        this._timer = setTimeout(this._callback, time);
    }

    /**
     * clear timer
     */
    public dispose() {
        clearTimeout(this._timer)
        this._timer = null;
        this._active = false;
    }
}
