/**
 * Created by Bohdan on Sep, 2021
 */

import { GlobalStatusResult } from "../types/PoolInterfaces";
import { PoolSettings } from "../types/SettingsInterfaces";
import Logger from "../utils/Logger";
import { Utils } from "../utils/Utils";
import { Timer } from "../utils/Timer";
import { Pool } from "./Pool";
import { Validator } from "./Validator";
import { LoadFactor } from "./LoadFactor";

export class PoolStatus {
    public active: boolean;
    public availableConnectionCount: number;
    // How much time query take. Time in seconds
    public queryTime: number;

    private readonly _pool: Pool;
    // Check if valid by passed validator
    private _isValid: boolean = false;
    public get isValid(): boolean {
        return this._isValid;
    }

    // Score from load factor
    private _loadScore: number = 0;
    public get loadScore(): number {
        return this._loadScore;
    }
    private _validator: Validator;
    private _loadFactor: LoadFactor;

    private _timer: Timer;
    // Time to next check status. Time in ms
    private _nextCheckTime: number = 10000;
    // Check status time range [min, max]
    private readonly timerCheckRange: [number, number];
    // Check status multiplier to change next time check depends on error or success
    private readonly timerCheckMultiplier: number;

    /**
     * @param pool pool of what status to check
     * @param settings pool settings
     * @param active default pool active status before status check
     * @param availableConnectionCount max connection count in the pool
     * @param queryTime default query time before status check
     */
    constructor(pool: Pool, settings: PoolSettings, active: boolean, availableConnectionCount: number, queryTime: number) {
        this._pool = pool;

        this.active = active;
        this.availableConnectionCount = availableConnectionCount;
        this.queryTime = queryTime;

        this._isValid = false;
        this._loadScore = 100000;

        this._validator = new Validator(this, settings.validators);
        this._loadFactor = new LoadFactor(settings.loadFactors);

        this.timerCheckRange = settings.timerCheckRange;
        this.timerCheckMultiplier = settings.timerCheckMultiplier;
        this._timer = new Timer(this.checkStatus.bind(this))
    }

    /**
     * stop pool check status timer
     */
    public stopTimerCheck() {
        this._timer.dispose();
    }

    /**
     * check pool status
     */
    public async checkStatus() {
        try {
            if (!this.active) return;

            Logger.debug("checking pool status in host: " + this._pool.host);
            const timeBefore = new Date().getTime();

            const result = await this._pool.query(`SHOW GLOBAL STATUS;`) as GlobalStatusResult[];

            const timeAfter = new Date().getTime();
            this.queryTime = Math.abs(timeAfter - timeBefore) / 1000;

            this._isValid = this._validator.check(result);
            Logger.debug("Is status ok in host " + this._pool.host + "? -> " + this._isValid.toString())
            this._loadScore = this._loadFactor.check(result);
            Logger.debug("Load score by checking status in host " + this._pool.host + " is " + this._loadScore);

            this.nextCheckStatus()
        } catch (err) {
            Logger.error("Error: Something wrong while checking status in host: " + this._pool.host + ".\n Message: " + err.message);
            this.nextCheckStatus(true)
        }
    }

    /** start timer for next check pool status
     * @param downgrade downgrade next time to check pool status
     * @private
     */
    private nextCheckStatus(downgrade: boolean = false) {
        if (downgrade) {
            this._nextCheckTime /= this.timerCheckMultiplier;
        } else {
            this._nextCheckTime *= this.timerCheckMultiplier;
        }
        this._nextCheckTime = Utils.clamp(this._nextCheckTime, this.timerCheckRange[0], this.timerCheckRange[1])

        this._timer.start(this._nextCheckTime);
    }
}
