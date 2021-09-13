import { GlobalStatusResult } from "../types/PoolInterfaces";
import { PoolSettings } from "../types/SettingsInterfaces";
import { Logger } from "../utils/Logger";
import { Utils } from "../utils/Utils";
import { Timer } from "../utils/Timer";
import { Pool } from "./Pool";
import { Validator } from "./Validator";
import { LoadFactor } from "./LoadFactor";

export class PoolStatus {
    public active: boolean;
    public availableConnectionCount: number;
    public queryTime: number; // time in seconds

    private readonly _pool: Pool;
    private _isValid: boolean = false;
    public get isValid(): boolean {
        return this._isValid;
    }

    private _loadScore: number = 0;
    public get loadScore(): number {
        return this._loadScore;
    }
    private _validator: Validator;
    private _loadFactor: LoadFactor;

    private _timer: Timer;
    private _nextCheckTime: number = 10000;
    private readonly timerCheckRange: [number, number];
    private readonly timerCheckMultiplier: number;

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

    public stopTimerCheck() {
        this._timer.dispose();
    }

    public async checkStatus() {
        try {
            if (!this.active) return;

            Logger("checking pool status in host: " + this._pool.host);
            const timeBefore = new Date().getTime();

            const result = await this._pool.query(`SHOW GLOBAL STATUS;`) as GlobalStatusResult[];

            const timeAfter = new Date().getTime();
            this.queryTime = Math.abs(timeAfter - timeBefore) / 1000;

            this._isValid = this._validator.check(result);
            Logger("Is status ok in host " + this._pool.host + "? -> " + this._isValid.toString())
            this._loadScore = this._loadFactor.check(result);
            Logger("Load score by checking status in host " + this._pool.host + " is " + this._loadScore);

            this.nextCheckStatus()
        } catch (err) {
            Logger("Error: Something wrong while checking status in host: " + this._pool.host + ".\n Message: " + err.message);
            this.nextCheckStatus(true)
        }
    }

    private nextCheckStatus(downgrade: boolean = false) {
        if (downgrade) {
            this._nextCheckTime /= this.timerCheckMultiplier;
        } else {
            this._nextCheckTime *= this.timerCheckMultiplier;
        }
        this._nextCheckTime = Utils.clamp(this._nextCheckTime, this.timerCheckRange[0] * 1000, this.timerCheckRange[1] * 1000)

        this._timer.start(this._nextCheckTime);
    }
}
