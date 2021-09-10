export class Timer {
    private _timer: NodeJS.Timeout;
    private readonly _callback: () => void;
    private _disposed: boolean = false;

    constructor(callback: () => void) {
        this._callback = callback;
        this._disposed = false;
    }

    public start (time: number) {
        if (this._disposed) return;

        this._timer = setTimeout(this._callback, time);
    }

    public dispose() {
        this._disposed = true;
        clearTimeout(this._timer)
        this._timer.unref()
    }
}
