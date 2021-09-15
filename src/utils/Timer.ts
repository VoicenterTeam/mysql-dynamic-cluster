export class Timer {
    private _timer: NodeJS.Timeout;
    private readonly _callback: () => void;

    constructor(callback: () => void) {
        this._callback = callback;
        this._timer = null;
    }

    public start (time: number) {
        if (!this._timer) return;
        this._timer = setTimeout(this._callback, time);
    }

    public dispose() {
        clearTimeout(this._timer)
        this._timer = null;
    }
}
