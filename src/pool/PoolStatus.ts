/**
 * Created by Bohdan on Sep, 2021
 */

import { GlobalStatusResult } from "../types/PoolInterfaces";
import Logger from "../utils/Logger";
import Events from "../utils/Events";
import { Utils } from "../utils/Utils";
import { Timer } from "../utils/Timer";
import { Pool } from "./Pool";
import { Validator } from "./Validator";
import { LoadFactor } from "./LoadFactor";
import { ITimerCheckRange, IUserPoolSettings } from "../types/PoolSettingsInterfaces";
import { QueryTimer } from "../utils/QueryTimer";

export class PoolStatus {
    public active: boolean;
    // Connections that can still be handed out, read from the pool
    public get availableConnectionCount(): number {
        return this._pool.availableConnectionCount;
    }
    // How much time query take. Time in seconds

    private readonly _pool: Pool;
    // Check if valid by passed validator
    private _isValid: boolean = false;
    public get isValid(): boolean {
        return this._isValid;
    }

    private _queryTime: number;
    get queryTime(): number {
        return this._queryTime;
    }

    // Score from load factor
    private _loadScore: number = 0;
    public get loadScore(): number {
        return this._loadScore;
    }
    private _validator: Validator;
    private _loadFactor: LoadFactor;
    // Failed checks in a row. One failure (network blip) doesn't take the pool out of rotation
    private _failedChecks: number = 0;
    // Status check timeout: a check slower than the longest check interval counts as failed
    private readonly _checkTimeout: number;

    private _timer: Timer;
    // goes up at every stopTimerCheck()
    private _checkRun: number = 0;
    // Time to next check status. Time in ms
    private _nextCheckTime: number = 10000;
    // Check status time range [min, max]
    private readonly timerCheckRange: ITimerCheckRange;
    // Check status multiplier to change next time check depends on error or success
    private readonly timerCheckMultiplier: number;

    /**
     * @param pool pool of what status to check
     * @param settings pool settings
     * @param active default pool active status before status check
     */
    constructor(pool: Pool, settings: IUserPoolSettings, active: boolean) {
        this._pool = pool;

        this.active = active;

        this._isValid = false;
        this._loadScore = 100000;

        this._validator = new Validator(this, settings.validators);
        this._loadFactor = new LoadFactor(settings.loadFactors);

        // complete by now: Settings.mixSettings filled both halves from the defaults
        this.timerCheckRange = settings.timerCheckRange as ITimerCheckRange;
        this.timerCheckMultiplier = settings.timerCheckMultiplier;
        // queryTimeout 0 means no timeout
        this._checkTimeout = Math.min(settings.queryTimeout || Infinity, this.timerCheckRange.end);
        this._timer = new Timer(this.checkStatus.bind(this));
        Logger.debug("Pool status configured");
    }

    /**
     * Mark the status active and let the check timer run again after stopTimerCheck().
     * The pool calls it when it connects, before its first check. It starts no check itself
     */
    public startTimerCheck() {
        this.active = true;
        this._timer.activate();
        Logger.debug("Check status in pool started");
    }

    private static _logDropped(host: string): void {
        Logger.debug("Dropped the result of a status check that outlived its connection in host: " + host);
    }

    /**
     * Stop pool check status timer.
     * A check that is still running after this changes nothing and reports nothing
     */
    public stopTimerCheck() {
        this._checkRun++;
        this._timer.dispose();
        Logger.info("Check status in pool stopped");
    }

    /**
     * Check pool status
     */
    public async checkStatus() {
        const queryTimer = new QueryTimer();
        // a check that outlives stopTimerCheck() belongs to a connection that is gone
        const run = this._checkRun;
        try {
            if (!this.active) return;

            Logger.debug("checking pool status in host: " + this._pool.host);
            queryTimer.start();

            // one timer for the whole check, including waiting for a free connection
            let checkTimer: NodeJS.Timeout;
            let result: GlobalStatusResult[];
            try {
                result = await Promise.race([
                    this._pool.query(`SHOW GLOBAL STATUS;`, { redis: false, timeout: this._checkTimeout }),
                    new Promise<never>((_, reject) => {
                        checkTimer = setTimeout(() => reject(new Error("Status check timeout")), this._checkTimeout);
                    })
                ]) as GlobalStatusResult[];
            } finally {
                clearTimeout(checkTimer);
            }
            if (run !== this._checkRun) return PoolStatus._logDropped(this._pool.host);

            queryTimer.end();
            this._queryTime = queryTimer.get();

            this._isValid = this._validator.check(result);
            Logger.debug("Is status ok in host " + this._pool.host + "? -> " + this._isValid.toString())
            this._loadScore = this._loadFactor.check(result);
            Logger.debug("Load score by checking status in host " + this._pool.host + " is " + this._loadScore);
            this._failedChecks = 0;

            this.nextCheckStatus()
        } catch (err) {
            if (run !== this._checkRun) return PoolStatus._logDropped(this._pool.host);
            Logger.error("Something wrong while checking status in host: " + this._pool.host +
                ".\n Message: " + PoolStatus._errorText(err));
            if (++this._failedChecks >= 2) this._isValid = false;

            queryTimer.end();
            this._queryTime = queryTimer.get();

            this.nextCheckStatus(true)
            this._emitCheckFailed(err);
        }
    }

    /**
     * Hand the error of a failed check to the app, with the id of the pool.
     * It runs after the next check is set, and a listener that throws is logged,
     * so a listener that throws cannot stop the checks. An async listener that rejects
     * is not caught here: that rejection belongs to the app.
     * A check that was still running when the pool was stopped reports nothing
     * @param err error of the failed check
     * @private
     */
    private _emitCheckFailed(err: any) {
        if (!this.active) return;
        try {
            Events.emit('pool_check_failed', err, this._pool.id);
        } catch (listenerError) {
            Logger.error("A pool_check_failed listener threw in host: " + this._pool.host +
                ".\n Message: " + PoolStatus._errorText(listenerError && listenerError.stack ? listenerError.stack : listenerError));
        }
    }

    /**
     * Text of whatever a check or a listener threw. Not every error has a message:
     * a rejection may be undefined, and a refused connection to a host with several
     * addresses is an AggregateError with a code and an empty message
     * @private
     */
    private static _errorText(err: any): string {
        try {
            return String((err && (err.message || err.code)) || err);
        } catch (unreadable) {
            // an object without a prototype, a symbol, a getter that throws
            return 'unreadable error';
        }
    }

    /**
     * Start timer for next pool check status
     * @param downgrade downgrade time for next check pool status?
     * @private
     */
    private nextCheckStatus(downgrade: boolean = false) {
        if (downgrade) {
            this._nextCheckTime /= this.timerCheckMultiplier;
        } else {
            this._nextCheckTime *= this.timerCheckMultiplier;
        }
        this._nextCheckTime = Utils.clamp(this._nextCheckTime, this.timerCheckRange.start, this.timerCheckRange.end)

        this._timer.start(this._nextCheckTime);
    }
}
