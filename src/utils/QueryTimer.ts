export class QueryTimer {
    private _timeStart: number;
    private _timeEnd: number;
    private _queryTime: number;

    /**
     * Start counting query time
     */
    public start(): void {
        this._timeStart = QueryTimer._getTime();
    }

    /**
     * Stop counting query time
     */
    public end(): void {
        this._timeEnd = QueryTimer._getTime();
        this._queryTime = Math.abs(this._timeStart - this._timeEnd) / 1000;
    }

    /**
     * Get query time in seconds
     */
    public get(): number {
        return this._queryTime;
    }

    /**
     * Get time now
     * @private
     */
    private static _getTime(): number {
        return new Date().getTime();
    }
}
