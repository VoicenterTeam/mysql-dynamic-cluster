import globalSettings from './config'
import { GaleraHostSettings } from "./interfaces";
import { Logger } from "./Logger";
import { Pool } from './Pool'

export class Host {
    public readonly id: string;
    public readonly host: string;
    public readonly connectionLimit: number;

    private readonly port: string;
    private readonly user: string;
    private readonly password: string;
    private readonly database: string;

    public readonly pool: Pool;

    constructor(settings: GaleraHostSettings) {
        this.host = settings.host;
        this.port = settings.port ? settings.port : globalSettings.port;
        this.id = settings.id ? settings.id.toString() : this.host + ":" + this.port
        Logger("configure host " + this.host)

        this.user = settings.user;
        this.password = settings.password;
        this.database = settings.database;

        this.connectionLimit = settings.connectionLimit ? settings.connectionLimit : globalSettings.connectionLimit;

        this.pool = new Pool(this);
    }

    public connect() {
        Logger("connecting host: " + this.host)
        this.pool.create(this.user, this.password, this.database);
    }

    public disconnect() {
        Logger("disconnecting host")
        this.pool.close(err => {
            if (err) {
                Logger(err.message);
            }
        })
    }

    public checkStatus(): boolean {
        Logger("checking host status")
        return this.pool.active
    }
}
