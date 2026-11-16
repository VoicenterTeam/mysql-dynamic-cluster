/**
 * Created by Bohdan on Sep, 2021
 */

/**
 * Simple timer what call callback some period of time
 */
export class Timer {
    private _timer: NodeJS.Timeout;
    private readonly _callback: () => void;
    private _active: boolean = false;
    public get active(): boolean {
        return this._active;
    }

    /**
     * @param callback callback what called when time is out
     */
    constructor(callback: () => void) {
        this._callback = callback;
        this._timer = null;
        this._active = true;
    }

    /**
     * Run timer
     * @param time time how much need to wait
     */
    public start(time: number) {
        if (!this._active) return;
        // one pending run at a time: a second start replaces the first
        clearTimeout(this._timer);
        this._timer = setTimeout(this._callback, time);
    }

    /**
     * Let start() work again after dispose(). It starts nothing by itself
     */
    public activate() {
        this._active = true;
    }

    /**
     * Clear timer and stop it. start() does nothing until activate() is called
     */
    public dispose() {
        clearTimeout(this._timer)
        this._timer = null;
        this._active = false;
    }
}
