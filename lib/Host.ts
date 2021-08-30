import globalSettings from './config'
import {GaleraHostSettings, HostStatus} from "./interfaces";
import { Logger } from "./Logger";
import { Pool } from './Pool'

export class Host {
    private _status: HostStatus;
    public get status(): HostStatus {
        return this._status;
    }
    private set status(val: HostStatus) {
        this._status = val;
    }

    public readonly id: string;
    public readonly host: string;
    public readonly connectionLimit: number;

    public readonly pool: Pool;

    private readonly port: string;
    private readonly user: string;
    private readonly password: string;
    private readonly database: string;


    private _timer: NodeJS.Timer;
    private _nextCheckTime: number = 10000;

    constructor(settings: GaleraHostSettings) {
        this.host = settings.host;
        this.port = settings.port ? settings.port : globalSettings.port;
        this.id = settings.id ? settings.id.toString() : this.host + ":" + this.port
        Logger("configure host " + this.host)

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : globalSettings.connectionLimit;

        this.status = {
            active: false
        }

        this.pool = new Pool(this);

        this.startTimerCheck()
    }

    private startTimerCheck() {
        this._timer = setInterval(this.checkStatus, this._nextCheckTime)
    }

    private stopTimerCheck() {
        clearInterval(this._timer)
    }

    public connect() {
        Logger("connecting host: " + this.host)
        this.pool.create(this.user, this.password, this.database);
        this.status.active = true;
    }

    public disconnect() {
        Logger("disconnecting host")
        this.pool.close(err => {
            if (err) {
                Logger(err.message);
            }
        })
    }

    public checkStatus() {
        Logger("checking host status")
        this.pool.isReady((error, result) => {
            if (error) {
                Logger("Error while checking status in host " + this.host  + " -> " + error.message)
            }
            this.status.active = result;
        })
    }
}
